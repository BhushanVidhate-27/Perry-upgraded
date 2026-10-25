"""Perry's VM controller: the one endpoint that answers while the VM is off.

Telegram talks to this app for `/start-vm`, `/stop-vm`, `/status-vm` and
`/restart-vm`. While the VM is running, Perry polls Telegram itself and this
app is silent; Perry's own copies of those commands reach it over
`POST /api/control`.

When any other message arrives while the VM is off, this app starts it, waits
for Perry's admin route, removes the webhook and forwards that one update, so
sending a message is all it takes to wake Perry. An idle watchdog on the VM
stops it with `{"action": "stop", "wait": true}`, which installs the webhook
before answering.

One file, no framework: a WSGI callable, so App Service's gunicorn serves it
and the only dependency is gunicorn itself.

Azure access uses the app's managed identity through the token endpoint the
platform injects (IDENTITY_ENDPOINT/IDENTITY_HEADER), so there is no
azure-identity package and no secret to rotate.
"""

from __future__ import annotations

import hmac
import json
import os
import threading
import time
import urllib.error
import urllib.request
from http import HTTPStatus

SAVING = "Perry is saving state and shutting down to save Azure credits."
SAVED = "Perry is deallocated. Telegram is handled by the controller, so the next message wakes it."
STARTING = "Starting Perry. It usually takes a minute or two. I will be back when the VM is ready."
WAKING = "Starting Perry. I will pass your message on as soon as it is ready; that usually takes about a minute."
RESTARTING = "Restarting Perry. Back in a minute or two."
FAILED = "VM control failed: {error}"
FORWARD_FAILED = "Perry is up, but I could not pass your message on: {error}. Send it again."

# Telegram's command menu: what the blue menu button lists, per bot, so it
# outlives this app's instances. Names are lowercase letters, digits and "_"
# (Telegram refuses a hyphen), and the four VM ones are the same commands Perry
# answers as /start-vm and so on: it folds a trailing "_vm" back to "-vm".
COMMANDS = [
    ("start", "Say hello; shows what I can do"),
    ("career", "Job search: /career <mode|job url>, or /career alone for the modes"),
    ("schedule", "Set one up: /schedule every weekday at 8:00 send a briefing"),
    ("schedules", "What runs on a schedule, and when each runs next"),
    ("account", "Save a login: /account <name> <username> <password>"),
    ("help", "Commands, and how I work"),
    ("status_vm", "Azure VM state"),
    ("start_vm", "Start the Azure VM"),
    ("stop_vm", "Save state and deallocate the VM"),
    ("restart_vm", "Restart the VM in place"),
    ("model", "List models; /model <name> switches this chat"),
    ("think", "List thinking levels; /think <level> sets this chat"),
    ("access", "Ask, auto or full: whether I ask before acting"),
    ("usage", "This chat's plan usage, and what is left"),
    ("stop", "Stop the reply I am writing"),
    ("pause", "Stop everything, and start nothing new"),
    ("resume", "Start again; /run and /skip settle what was missed"),
    ("compact", "Shrink what I carry of this chat"),
    ("note", "Add to your Inbox note"),
    ("status", "Plumbing and recent errors"),
    ("pair", "A fresh pairing code, in the owner's chat"),
    ("reset", "Save this chat to memory, then start fresh"),
]

# How long a stop may take before the takeover gives up. Deallocation takes a
# minute or two; the rest is slack for a slow Azure.
TAKEOVER_SECONDS = 600
# An idle stop holds its request open until the webhook is back, under App
# Service's request timeout; a slow deallocation finishes in the background.
AUTO_STOP_SECONDS = 180
# How long a wake waits for Perry's admin route, which is ready once the VM,
# container and backend are up. Measured cold start: about a minute.
ADMIN_SECONDS = 180
ADMIN_POLL_SECONDS = 3


def setting(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing app setting: {name}")
    return value


def telegram(method: str, body: dict) -> dict:
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{setting('TELEGRAM_BOT_TOKEN')}/{method}",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        result = json.loads(response.read())
    if not result.get("ok"):
        raise RuntimeError(result.get("description", f"Telegram {method} failed"))
    return result


def arm_token() -> str:
    """A token for the app's managed identity, from the platform's endpoint."""
    endpoint = os.environ.get("IDENTITY_ENDPOINT", "").strip()
    header = os.environ.get("IDENTITY_HEADER", "").strip()
    if not endpoint or not header:
        raise RuntimeError("No managed identity: IDENTITY_ENDPOINT and IDENTITY_HEADER are not set")
    request = urllib.request.Request(
        f"{endpoint}?resource=https://management.azure.com&api-version=2019-08-01",
        headers={"x-identity-header": header},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read())["access_token"]


def arm(method: str, path: str) -> dict:
    request = urllib.request.Request(
        f"https://management.azure.com{path}?api-version=2024-07-01",
        headers={"Authorization": f"Bearer {arm_token()}"},
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read()) if response.status != 202 else {}
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise RuntimeError(f"Azure request failed ({error.code}): {detail[:500]}") from error


def authorized(chat_id: str) -> bool:
    return chat_id == setting("TELEGRAM_ALLOWED_CHAT_ID")


def reply(chat_id: str, text: str) -> None:
    telegram("sendMessage", {"chat_id": chat_id, "text": text})


def vm_path() -> str:
    return (
        f"/subscriptions/{setting('AZURE_SUBSCRIPTION_ID')}"
        f"/resourceGroups/{setting('AZURE_RESOURCE_GROUP')}"
        f"/providers/Microsoft.Compute/virtualMachines/{setting('AZURE_VM_NAME')}"
    )


def vm_status() -> list[str]:
    """The VM's display statuses, e.g. ["Provisioning succeeded", "VM running"]."""
    view = arm("GET", vm_path() + "/instanceView")
    # The sub-resource answers with the view itself, not wrapped in instanceView.
    statuses = view.get("statuses", [])
    return [str(item["displayStatus"]) for item in statuses if item.get("displayStatus")]


def vm_offline(statuses: list[str]) -> bool:
    """Deallocated, which is the only off state `/start-vm` can wake up."""
    return any("deallocated" in status.lower() for status in statuses)


def webhook_url() -> str:
    return setting("TELEGRAM_WEBHOOK_URL")


def install_webhook() -> None:
    """Point Telegram at this app, so its commands work while the VM is off."""
    body = {"url": webhook_url(), "allowed_updates": ["message"]}
    secret = os.environ.get("TELEGRAM_WEBHOOK_SECRET", "").strip()
    if secret:
        body["secret_token"] = secret
    telegram("setWebhook", body)
    # A menu that fails to publish is not worth losing the webhook over.
    try:
        install_commands()
    except Exception as error:
        print(f"could not publish the Telegram command menu: {error}")


def install_commands() -> None:
    """Publish the menu Telegram shows beside the message box (see COMMANDS)."""
    telegram(
        "setMyCommands",
        {"commands": [{"command": name, "description": text} for name, text in COMMANDS]},
    )


def webhook_is_ours() -> bool:
    info = telegram("getWebhookInfo", {})
    return (info.get("result") or {}).get("url", "") == webhook_url()


def take_over_telegram(wait_seconds: float = 0) -> bool:
    """Become Telegram's webhook once the VM is off; True when it is.

    Setting the webhook while the VM is still running loses every later
    command: Perry's poller sees it, removes it because `getUpdates` refuses to
    run beside a webhook, and the VM then deallocates with no way to reach
    `/start-vm`. So this waits for `instanceView` to say deallocated, and only
    then points Telegram here.
    """
    deadline = time.monotonic() + wait_seconds
    while True:
        if vm_offline(vm_status()):
            if not webhook_is_ours():
                install_webhook()
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(2)


def take_over_later() -> None:
    """Wait for the deallocation out of band, so Telegram's reply is not held.

    There is no timer: the free plan has no always-on, so a timer would not run
    reliably anyway. The next `/status-vm` heals the webhook if this thread is
    cut short before the VM is gone.
    """

    def wait() -> None:
        try:
            take_over_telegram(wait_seconds=TAKEOVER_SECONDS)
        except Exception as error:
            print(f"could not take over Telegram after stopping the VM: {error}")

    threading.Thread(target=wait, daemon=True).start()


def start_vm() -> str:
    arm("POST", vm_path() + "/start")
    # Let updates queue for Perry instead of this app eating them while it boots.
    try:
        telegram("deleteWebhook", {"drop_pending_updates": False})
    except Exception as error:  # Perry deletes a leftover webhook on its own first poll.
        print(f"could not remove the webhook after starting the VM: {error}")
    return STARTING


def stop_vm(wait: bool = False) -> str:
    """Deallocate; `wait` installs the webhook before answering (idle auto-off).

    The automatic stop has nobody to call `/status-vm` afterwards, so it waits
    for the VM to be really gone and Telegram to point here, and only says
    `SAVED` when that happened. A slow deallocation carries on in the
    background, as `/stop-vm` always has.
    """
    arm("POST", vm_path() + "/deallocate")
    if wait and take_over_telegram(wait_seconds=AUTO_STOP_SECONDS):
        return SAVED
    take_over_later()
    return SAVING


def admin_call(path: str, args: dict | None = None):
    """Call one of Perry's internal functions, with the dashboard key."""
    base = setting("PERRY_BASE_URL").rstrip("/")
    request = urllib.request.Request(
        f"{base}/api/backend/admin",
        data=json.dumps({"path": path, "args": args or {}}).encode(),
        headers={"content-type": "application/json", "x-perry-key": setting("PERRY_DASHBOARD_KEY")},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        body = json.loads(response.read())
    if body.get("error"):
        raise RuntimeError(str(body["error"]))
    return body.get("value")


def wait_for_admin(seconds: float) -> bool:
    """Wait until Perry's admin route answers; False if it never came up."""
    deadline = time.monotonic() + seconds
    while True:
        try:
            admin_call("jobs:ownerTimezone")
            return True
        except Exception:
            if time.monotonic() >= deadline:
                return False
            time.sleep(ADMIN_POLL_SECONDS)


# Telegram retries a webhook it did not hear a 200 for, so one update must not
# wake the VM twice or be handed to Perry twice.
SEEN: dict[int, float] = {}
SEEN_LOCK = threading.Lock()


def claim_update(update_id: int) -> bool:
    """True the first time this update is seen, False for a retry."""
    now = time.monotonic()
    with SEEN_LOCK:
        for old in [key for key, at in SEEN.items() if at < now - 86400]:
            del SEEN[old]
        if update_id in SEEN:
            return False
        SEEN[update_id] = now
        while len(SEEN) > 1000:
            del SEEN[min(SEEN, key=lambda key: SEEN[key])]
        return True


def wake(update: dict) -> None:
    """Wake the VM for one message, then hand that same message to Perry.

    Telegram delivered the update here because the VM was off, so Perry's
    poller will never see it; it is forwarded once the admin route answers.
    """
    update_id = update.get("update_id")
    if isinstance(update_id, int) and not claim_update(update_id):
        return
    message = update.get("message") or {}
    chat_id = str((message.get("chat") or {}).get("id", ""))
    if vm_offline(vm_status()):
        if chat_id:
            reply(chat_id, WAKING)
        arm("POST", vm_path() + "/start")
    if not wait_for_admin(ADMIN_SECONDS):
        if chat_id:
            reply(chat_id, FAILED.format(error="Perry did not come up in time"))
        return
    # Perry's poller removes a webhook on its own first poll; removing it here
    # means that poll starts from the update after this one.
    try:
        telegram("deleteWebhook", {"drop_pending_updates": False})
    except Exception as error:
        print(f"could not remove the webhook after waking the VM: {error}")
    try:
        admin_call("ingest:fromTelegram", {"update": update})
    except Exception as error:
        if chat_id:
            reply(chat_id, FORWARD_FAILED.format(error=error))


def wake_safely(update: dict) -> None:
    """Wake out of band, so Telegram gets its 200 before the minute-long boot."""
    message = update.get("message") or {}
    chat_id = str((message.get("chat") or {}).get("id", ""))
    try:
        wake(update)
    except Exception as error:
        print(f"could not wake the VM for update {update.get('update_id')}: {error}")
        try:
            if chat_id and authorized(chat_id):
                reply(chat_id, FAILED.format(error=error))
        except Exception:
            pass


def wake_later(update: dict) -> None:
    threading.Thread(target=wake_safely, args=(update,), daemon=True).start()


def restart_vm() -> str:
    """Restart in place: same VM, same IP, no deallocation, no webhook change."""
    arm("POST", vm_path() + "/restart")
    return RESTARTING


def status_message() -> str:
    names = vm_status()
    # A request that finds the VM off and Telegram pointed elsewhere heals it,
    # so a stop whose takeover was cut short still ends up reachable.
    if vm_offline(names) and not webhook_is_ours():
        install_webhook()
    return f"Azure VM: {', '.join(names) or 'unknown'}"


def command_of(message: dict) -> str:
    text = str(message.get("text") or "").strip()
    if not text:
        return ""
    return text.split()[0].lower().split("@", 1)[0]


# --- WSGI -------------------------------------------------------------------


def body_of(environ) -> dict:
    length = int(environ.get("CONTENT_LENGTH") or 0)
    raw = environ["wsgi.input"].read(length) if length else b""
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except ValueError:
        return {}


def header_of(environ, name: str) -> str:
    """A request header by its wire name, e.g. x-perry-control-key."""
    return environ.get("HTTP_" + name.upper().replace("-", "_"), "")


def respond(start_response, status: int, text: str):
    body = text.encode()
    start_response(
        f"{status} {HTTPStatus(status).phrase}",
        [("content-type", "text/plain; charset=utf-8"), ("content-length", str(len(body)))],
    )
    return [body]


def telegram_webhook(update: dict, start_response):
    message = update.get("message") or {}
    chat_id = str((message.get("chat") or {}).get("id", ""))
    command = command_of(message)
    try:
        if not authorized(chat_id):
            return respond(start_response, 200, "ignored")
        if command in ("/start-vm", "/start_vm"):
            reply(chat_id, start_vm())
        elif command in ("/status-vm", "/status_vm"):
            reply(chat_id, status_message())
        elif command in ("/stop-vm", "/stop_vm"):
            reply(chat_id, stop_vm())
        elif command in ("/restart-vm", "/restart_vm"):
            reply(chat_id, restart_vm())
        else:
            # Any other message wakes Perry and is handed to it once it is up.
            wake_later(update)
        return respond(start_response, 200, "ok")
    except Exception as error:
        try:
            if chat_id and authorized(chat_id):
                reply(chat_id, FAILED.format(error=error))
        except Exception:
            pass
        return respond(start_response, 500, "controller error")


def control(request: dict, environ, start_response):
    sent = header_of(environ, "x-perry-control-key")
    if not hmac.compare_digest(sent, setting("PERRY_VM_CONTROL_KEY")):
        return respond(start_response, 401, "unauthorized")
    action = request.get("action")
    try:
        if action == "start":
            message = start_vm()
        elif action == "stop":
            message = stop_vm(wait=request.get("wait") is True)
        elif action == "restart":
            message = restart_vm()
        elif action == "status":
            message = status_message()
        else:
            return respond(start_response, 400, "unknown action")
        return respond(start_response, 200, json.dumps({"ok": True, "message": message}))
    except Exception as error:
        return respond(start_response, 500, json.dumps({"ok": False, "error": str(error)}))


def app(environ, start_response):
    """gunicorn's entry point: `gunicorn app:app`."""
    method = environ.get("REQUEST_METHOD", "GET")
    path = environ.get("PATH_INFO", "/").rstrip("/")
    if path.endswith("/telegram") and method == "POST":
        secret = os.environ.get("TELEGRAM_WEBHOOK_SECRET", "").strip()
        sent = header_of(environ, "x-telegram-bot-api-secret-token")
        if secret and not hmac.compare_digest(sent, secret):
            return respond(start_response, 401, "unauthorized")
        return telegram_webhook(body_of(environ), start_response)
    if path.endswith("/control") and method == "POST":
        return control(body_of(environ), environ, start_response)
    if method == "GET":
        # What is configured, never the values: enough to tell a broken deploy
        # from a broken setting.
        return respond(
            start_response,
            200,
            json.dumps(
                {
                    "ok": True,
                    "webhook_secret": bool(os.environ.get("TELEGRAM_WEBHOOK_SECRET", "").strip()),
                    "control_key": bool(os.environ.get("PERRY_VM_CONTROL_KEY", "").strip()),
                    "forwarding": bool(
                        os.environ.get("PERRY_BASE_URL", "").strip()
                        and os.environ.get("PERRY_DASHBOARD_KEY", "").strip()
                    ),
                    "vm": os.environ.get("AZURE_VM_NAME", ""),
                }
            ),
        )
    return respond(start_response, 404, "not found")
