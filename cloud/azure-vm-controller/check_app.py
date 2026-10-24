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


def reset(statuses: list[str], webhook: str = "") -> None:
    calls.clear()
    telegrams.clear()
    replies.clear()
    later.clear()
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


def message(text: str, chat: str = "42") -> dict:
    return {"message": {"chat": {"id": chat}, "text": text}}


def main() -> None:
    controller.arm = fake_arm
    controller.telegram = fake_telegram
    controller.reply = fake_reply
    controller.take_over_later = fake_later

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

    # Any other message while the VM is off gets the hint, so the bot is not dead.
    reset(["Provisioning succeeded", "Deallocated"])
    post("/api/telegram", message("hello?"))
    assert "start-vm" in replies[0][1], replies

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

    # An unknown action is a refusal, not a wrapper for one of the four.
    reset(["Provisioning succeeded", "VM running"])
    assert post("/api/control", {"action": "delete"}, {"x-perry-control-key": "control-key"})[0] == 400
    assert calls == [], calls

    # The webhook secret is enforced when it is set.
    reset(["Provisioning succeeded", "VM running"])
    assert post("/api/telegram", message("/start-vm"), {"x-telegram-bot-api-secret-token": "nope"})[0] == 401
    assert calls == [], calls

    print("ok: azure vm controller checks passed")


if __name__ == "__main__":
    main()
