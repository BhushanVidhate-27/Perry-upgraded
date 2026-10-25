#!/usr/bin/env python3
"""A self-check for the VM controller: no Azure, no Telegram, no network.

Run it after any change to app.py: `python3 check_app.py`. It fails when the
commands stop doing what the controller promises: start wakes the VM and gives
Telegram back to Perry, stop only deallocates and takes over later, restart
touches neither, and a stranger gets nothing.
"""

from __future__ import annotations

import io
import json
import os
import sys

os.environ.update(
    {
        "TELEGRAM_BOT_TOKEN": "123:test",
        "TELEGRAM_ALLOWED_CHAT_ID": "42",
        "TELEGRAM_WEBHOOK_URL": "https://perry.test/api/telegram",
        "TELEGRAM_WEBHOOK_SECRET": "telegram-secret",
        "PERRY_VM_CONTROL_KEY": "control-key",
        "PERRY_BASE_URL": "http://perry.test:7377",
        "PERRY_DASHBOARD_KEY": "dashboard-key",
        "AZURE_SUBSCRIPTION_ID": "sub",
        "AZURE_RESOURCE_GROUP": "rg",
        "AZURE_VM_NAME": "perry",
    }
)
for name in ("IDENTITY_ENDPOINT", "IDENTITY_HEADER"):
    os.environ.pop(name, None)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import app as controller  # noqa: E402

VM = "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/perry"
calls: list[tuple[str, str, str]] = []
telegrams: list[tuple[str, dict]] = []
replies: list[tuple[str, str]] = []
state = {"statuses": ["Provisioning succeeded", "VM running"], "webhook": ""}
later: list[bool] = []
wakes: list[dict] = []
admins: list[tuple[str, dict]] = []
failure = {"forward": False}


def fake_arm(method: str, path: str) -> dict:
    calls.append(("arm", method, path))
    if path.endswith("/instanceView"):
        # The shape of the real sub-resource: the view itself, not an
        # {"instanceView": ...} envelope. Checked against Azure on 2026-10-24.
        return {"statuses": [{"displayStatus": status} for status in state["statuses"]]}
    return {}


def fake_telegram(method: str, body: dict) -> dict:
    telegrams.append((method, body))
    if method == "getWebhookInfo":
        return {"ok": True, "result": {"url": state["webhook"]}}
    if method == "setWebhook":
        state["webhook"] = body["url"]
    return {"ok": True, "result": True}


def fake_reply(chat_id: str, text: str) -> None:
    replies.append((chat_id, text))


def fake_later() -> None:
    later.append(True)


def fake_wake_later(update: dict) -> None:
    wakes.append(update)


def fake_admin(path: str, args: dict | None = None):
    admins.append((path, args or {}))
    if failure["forward"] and path == "ingest:fromTelegram":
        raise RuntimeError("admin route said no")
    return "Asia/Kolkata"


def reset(statuses: list[str], webhook: str = "") -> None:
    calls.clear()
    telegrams.clear()
    replies.clear()
    later.clear()
    wakes.clear()
    admins.clear()
    failure["forward"] = False
    controller.SEEN.clear()
    state["statuses"] = statuses
    state["webhook"] = webhook


def methods() -> list[str]:
    return [method for method, _body in telegrams]


def post(path: str, payload: dict | None, headers: dict | None = None) -> tuple[int, str]:
    raw = json.dumps(payload or {}).encode()
    environ = {
        "REQUEST_METHOD": "POST",
        "PATH_INFO": path,
        "CONTENT_LENGTH": str(len(raw)),
        "wsgi.input": io.BytesIO(raw),
    }
    sent = dict(headers or {})
    if path.endswith("/telegram") and "x-telegram-bot-api-secret-token" not in sent:
        sent["x-telegram-bot-api-secret-token"] = os.environ["TELEGRAM_WEBHOOK_SECRET"]
    for name, value in sent.items():
        environ["HTTP_" + name.upper().replace("-", "_")] = value
    captured: dict = {}

    def start_response(status: str, _headers) -> None:
        captured["status"] = int(status.split()[0])

    body = b"".join(controller.app(environ, start_response)).decode()
    return captured["status"], body


def get(path: str = "/") -> tuple[int, str]:
    environ = {"REQUEST_METHOD": "GET", "PATH_INFO": path, "CONTENT_LENGTH": "0", "wsgi.input": io.BytesIO(b"")}
    captured: dict = {}

    def start_response(status: str, _headers) -> None:
        captured["status"] = int(status.split()[0])

    body = b"".join(controller.app(environ, start_response)).decode()
    return captured["status"], body


def message(text: str, chat: str = "42") -> dict:
    return {"message": {"chat": {"id": chat}, "text": text}}


def main() -> None:
    controller.arm = fake_arm
    controller.telegram = fake_telegram
    controller.reply = fake_reply
    controller.take_over_later = fake_later
    controller.wake_later = fake_wake_later
    controller.admin_call = fake_admin

    # Without the host's identity endpoint there is no way to reach Azure, and
    # the controller says so instead of failing somewhere deeper.
    try:
        controller.arm_token()
    except RuntimeError as error:
        assert "managed identity" in str(error), error
    else:
        raise AssertionError("arm_token must refuse to run without an identity")

    # /start-vm wakes the VM, then lets Telegram queue messages for Perry.
    reset(["Provisioning succeeded", "Deallocated"])
    assert post("/api/telegram", message("/start-vm"))[0] == 200
    assert ("arm", "POST", VM + "/start") in calls, calls
    assert "deleteWebhook" in methods(), methods()
    assert replies and replies[0][0] == "42", replies

    # /stop-vm only deallocates. Taking Telegram over is out of band, because
    # the VM is still running and Perry's poller would delete the webhook.
    reset(["Provisioning succeeded", "VM running"])
    assert post("/api/telegram", message("/stop-vm"))[0] == 200
    assert ("arm", "POST", VM + "/deallocate") in calls, calls
    assert "setWebhook" not in methods(), methods()
    assert later == [True], later

    # The takeover waits for the VM to be really gone, then points Telegram here.
    reset(["Provisioning succeeded", "VM running"])
    assert controller.take_over_telegram(wait_seconds=0) is False
    assert "setWebhook" not in methods(), methods()

    reset(["Provisioning succeeded", "Deallocated"])
    assert controller.take_over_telegram(wait_seconds=0) is True
    assert "setWebhook" in methods(), methods()
    webhook = dict(telegrams)["setWebhook"]
    assert webhook["url"] == os.environ["TELEGRAM_WEBHOOK_URL"], webhook
    assert webhook["secret_token"] == os.environ["TELEGRAM_WEBHOOK_SECRET"], webhook

    # Already ours: no second call.
    reset(["Provisioning succeeded", "Deallocated"], webhook=os.environ["TELEGRAM_WEBHOOK_URL"])
    assert controller.take_over_telegram(wait_seconds=0) is True
    assert "setWebhook" not in methods(), methods()

    # /restart-vm restarts in place: no deallocation, no webhook change.
    reset(["Provisioning succeeded", "VM running"])
    assert post("/api/telegram", message("/restart-vm"))[0] == 200
    assert ("arm", "POST", VM + "/restart") in calls, calls
    assert not [call for call in calls if call[2].endswith("/deallocate")], calls
    assert "setWebhook" not in methods() and "deleteWebhook" not in methods(), methods()

    # A request that finds the VM off and Telegram elsewhere heals the webhook.
    reset(["Provisioning succeeded", "Deallocated"])
    assert post("/api/telegram", message("/status-vm"))[0] == 200
    assert "setWebhook" in methods(), methods()
    assert "deallocated" in replies[0][1].lower(), replies

    # Someone else's chat is ignored, and nothing is sent to them.
    reset(["Provisioning succeeded", "VM running"])
    assert post("/api/telegram", message("/start-vm", chat="666"))[0] == 200
    assert calls == [] and replies == [], (calls, replies)

    # Any other message while the VM is off is handed to a wake worker, and
    # Telegram gets its 200 before the minute-long boot.
    reset(["Provisioning succeeded", "Deallocated"])
    update = {"update_id": 7, **message("hello?")}
    assert post("/api/telegram", update)[0] == 200
    assert wakes == [update], wakes
    assert replies == [], replies

    # The wake starts the VM, waits for the admin route, removes the webhook so
    # Perry can poll, and forwards that same update exactly once.
    controller.wake(update)
    assert ("arm", "POST", VM + "/start") in calls, calls
    assert "deleteWebhook" in methods(), methods
    assert ("ingest:fromTelegram", {"update": update}) in admins, admins
    assert "Starting Perry" in replies[0][1], replies
    # Telegram retrying the webhook does not start it or forward it again.
    controller.wake(update)
    assert len([call for call in calls if call[2].endswith("/start")]) == 1, calls
    assert len([path for path, _args in admins if path == "ingest:fromTelegram"]) == 1, admins

    # A message that arrives while the VM is already running (or still
    # starting) is forwarded without a second start and without the notice.
    reset(["Provisioning succeeded", "VM running"])
    already = {"update_id": 8, **message("still there?")}
    controller.wake(already)
    assert not [call for call in calls if call[2].endswith("/start")], calls
    assert replies == [], replies
    assert ("ingest:fromTelegram", {"update": already}) in admins, admins

    # If Perry never answers, the owner is told instead of being left waiting.
    reset(["Provisioning succeeded", "Deallocated"])
    wait = controller.wait_for_admin
    controller.wait_for_admin = lambda _seconds: False
    try:
        controller.wake({"update_id": 9, **message("anyone?")})
    finally:
        controller.wait_for_admin = wait
    assert "did not come up" in replies[-1][1], replies
    assert not [path for path, _args in admins if path == "ingest:fromTelegram"], admins

    # If the wake works but the hand-off does not, the owner is told to resend.
    reset(["Provisioning succeeded", "Deallocated"])
    failure["forward"] = True
    controller.wake({"update_id": 10, **message("lost?")})
    assert "could not pass your message on" in replies[-1][1], replies
    assert "deleteWebhook" in methods(), methods

    # A wrong or missing control key is refused.
    reset(["Provisioning succeeded", "VM running"])
    assert post("/api/control", {"action": "status"})[0] == 401
    assert post("/api/control", {"action": "status"}, {"x-perry-control-key": "wrong"})[0] == 401
    assert calls == [], calls

    # The bot's own /restart-vm reaches the same restart through the control route.
    reset(["Provisioning succeeded", "VM running"])
    status, body = post("/api/control", {"action": "restart"}, {"x-perry-control-key": "control-key"})
    assert status == 200, (status, body)
    assert ("arm", "POST", VM + "/restart") in calls, calls
    assert json.loads(body)["ok"], body

    # The idle watchdog asks for a stop that leaves Telegram here before it
    # answers; otherwise nobody is left to wake the VM afterwards.
    reset(["Provisioning succeeded", "Deallocated"])
    status, body = post("/api/control", {"action": "stop", "wait": True}, {"x-perry-control-key": "control-key"})
    assert status == 200, (status, body)
    assert ("arm", "POST", VM + "/deallocate") in calls, calls
    assert "setWebhook" in methods(), methods
    assert later == [], later
    assert "deallocated" in json.loads(body)["message"], body

    # An unknown action is a refusal, not a wrapper for one of the four.
    reset(["Provisioning succeeded", "VM running"])
    assert post("/api/control", {"action": "delete"}, {"x-perry-control-key": "control-key"})[0] == 400
    assert calls == [], calls

    # The root says whether a wake can hand a message on, without the values.
    status, body = get()
    assert status == 200, status
    assert json.loads(body)["forwarding"] is True, body

    # The webhook secret is enforced when it is set.
    reset(["Provisioning succeeded", "VM running"])
    assert post("/api/telegram", message("/start-vm"), {"x-telegram-bot-api-secret-token": "nope"})[0] == 401
    assert calls == [], calls

    # The menu Telegram shows obeys its rules: one bad name fails the whole
    # setMyCommands, and a hyphen (which Telegram refuses) is the easy mistake.
    names = [name for name, _text in controller.COMMANDS]
    assert len(names) == len(set(names)), names
    assert len(names) <= 100, len(names)
    for name, text in controller.COMMANDS:
        assert 1 <= len(name) <= 32, name
        assert all(char.islower() or char.isdigit() or char == "_" for char in name), name
        assert 1 <= len(text) <= 256, text
    # The four the menu offers are the four this app answers, in its spelling.
    for name in ("start_vm", "stop_vm", "status_vm", "restart_vm"):
        assert name in names, name

    # Taking Telegram over publishes that menu, without the webhook waiting on it.
    reset(["Provisioning succeeded", "Deallocated"])
    assert controller.take_over_telegram(wait_seconds=0) is True
    published = dict(telegrams)["setMyCommands"]
    assert [item["command"] for item in published["commands"]] == names, published

    reset(["Provisioning succeeded", "Deallocated"])
    def broken() -> None:
        raise RuntimeError("Telegram says no")

    controller.install_commands = broken
    assert controller.take_over_telegram(wait_seconds=0) is True
    assert "setWebhook" in methods(), methods

    print("ok: azure vm controller checks passed")


if __name__ == "__main__":
    main()
