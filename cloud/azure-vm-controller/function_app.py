import hmac
import json
import os
import urllib.error
import urllib.request

import azure.functions as func
from azure.identity import DefaultAzureCredential

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)

SAVING = "Perry is saving state and shutting down to save Azure credits."


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


def arm(method: str, path: str) -> dict:
    credential = DefaultAzureCredential()
    token = credential.get_token("https://management.azure.com/.default").token
    request = urllib.request.Request(
        f"https://management.azure.com{path}?api-version=2024-07-01",
        headers={"Authorization": f"Bearer {token}"},
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
    statuses = view.get("instanceView", {}).get("statuses", [])
    return [str(item["displayStatus"]) for item in statuses if item.get("displayStatus")]


def vm_offline(statuses: list[str]) -> bool:
    """Deallocated, which is the only off state `/start-vm` can wake up."""
    return any("deallocated" in status.lower() for status in statuses)


def install_webhook() -> None:
    """Point Telegram at this Function App, so its commands work while the VM is off."""
    body = {"url": setting("TELEGRAM_WEBHOOK_URL"), "allowed_updates": ["message"]}
    secret = os.environ.get("TELEGRAM_WEBHOOK_SECRET", "").strip()
    if secret:
        body["secret_token"] = secret
    telegram("setWebhook", body)


def start_vm() -> str:
    arm("POST", vm_path() + "/start")
    # Let updates queue for Perry instead of this Function App eating them while the VM boots.
    try:
        telegram("deleteWebhook", {"drop_pending_updates": False})
    except Exception as error:  # Perry deletes a leftover webhook on its own first poll.
        print(f"could not remove the webhook after starting the VM: {error}")
    return "Starting Perry. It usually takes a minute or two. I will be back when the VM is ready."


def stop_vm() -> str:
    # A timer sets the webhook back once the VM is really deallocated. Setting it
    # here would race Perry's poller, which sees the webhook, removes it, and
    # leaves the deallocated VM unreachable.
    arm("POST", vm_path() + "/deallocate")
    return SAVING


def restart_vm() -> str:
    """Restart in place: same VM, same IP, no deallocation. For a bot that has stopped answering."""
    arm("POST", vm_path() + "/restart")
    return "Restarting Perry. Back in a minute or two."


def status_message() -> str:
    names = vm_status()
    return f"Azure VM: {', '.join(names) or 'unknown'}"


def command_of(message: dict) -> str:
    text = str(message.get("text") or "").strip()
    if not text:
        return ""
    return text.split()[0].lower().split("@", 1)[0]


@app.route(route="telegram", methods=["POST"])
def telegram_webhook(request: func.HttpRequest) -> func.HttpResponse:
    update = None
    try:
        secret = os.environ.get("TELEGRAM_WEBHOOK_SECRET", "").strip()
        sent = request.headers.get("x-telegram-bot-api-secret-token", "")
        if secret and not hmac.compare_digest(sent, secret):
            return func.HttpResponse("unauthorized", status_code=401)

        update = request.get_json() or {}
        message = update.get("message") or {}
        chat = message.get("chat") or {}
        chat_id = str(chat.get("id", ""))
        command = command_of(message)
        if not authorized(chat_id):
            return func.HttpResponse("ignored", status_code=200)
        if command in ("/start-vm", "/start_vm"):
            reply(chat_id, start_vm())
        elif command in ("/status-vm", "/status_vm"):
            reply(chat_id, status_message())
        elif command in ("/stop-vm", "/stop_vm"):
            reply(chat_id, stop_vm())
        elif command in ("/restart-vm", "/restart_vm"):
            reply(chat_id, restart_vm())
        elif command:
            reply(chat_id, "Perry is off. Send /start-vm to start the VM, /status-vm for its state, or /stop-vm to save credits.")
        return func.HttpResponse("ok", status_code=200)
    except Exception as error:
        try:
            chat_id = str((((update or {}).get("message") or {}).get("chat") or {}).get("id", ""))
            if chat_id and authorized(chat_id):
                reply(chat_id, f"VM control failed: {error}")
        except Exception:
            pass
        return func.HttpResponse("controller error", status_code=500)


@app.route(route="control", methods=["POST"])
def control(request: func.HttpRequest) -> func.HttpResponse:
    sent = request.headers.get("x-perry-control-key", "")
    if not hmac.compare_digest(sent, setting("PERRY_VM_CONTROL_KEY")):
        return func.HttpResponse("unauthorized", status_code=401)
    try:
        action = (request.get_json() or {}).get("action")
        if action == "start":
            message = start_vm()
        elif action == "stop":
            message = stop_vm()
        elif action == "restart":
            message = restart_vm()
        elif action == "status":
            message = status_message()
        else:
            return func.HttpResponse("unknown action", status_code=400)
        return func.HttpResponse(json.dumps({"ok": True, "message": message}), mimetype="application/json")
    except Exception as error:
        return func.HttpResponse(json.dumps({"ok": False, "error": str(error)}), status_code=500, mimetype="application/json")


@app.timer_trigger(schedule="0 * * * * *", arg_name="timer", run_on_startup=True)
def reconcile(timer: func.TimerRequest) -> None:
    """Keep the Telegram control path alive only while the VM is deallocated.

    The stop path cannot set the webhook itself: the running Perry sees it,
    removes it because `getUpdates` refuses to run with a webhook set, and then
    the VM finishes deallocating with no way to reach `/start-vm`. Doing it
    after the fact avoids that race, and a minute of queued updates is fine.
    """
    try:
        statuses = vm_status()
        if not vm_offline(statuses):
            return
        info = telegram("getWebhookInfo", {})
        current = (info.get("result") or {}).get("url", "")
        if current != setting("TELEGRAM_WEBHOOK_URL"):
            install_webhook()
    except Exception as error:
        print(f"could not reconcile the Telegram webhook: {error}")
