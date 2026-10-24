#!/usr/bin/env python3
"""Self-check for the Azure VM controller's control flow.

Run it with `python3 cloud/azure-vm-controller/check_function_app.py`. It stubs
Azure and Telegram, so it needs no cloud account and touches nothing.

Ways this can break, which the checks below guard:
  - `/stop-vm` sets the webhook while Perry is still running: Perry removes it
    on its next poll, the VM finishes deallocating, and `/start-vm` is lost.
  - The timer does not set the webhook once the VM is deallocated: same lockout.
  - The timer sets the webhook while the VM is running: Perry's poll gets 409.
  - `/start-vm` leaves the webhook set: messages sent while the VM boots are
    eaten by the Function App and never reach Perry.
  - `/status-vm` through `/control` reports availability instead of VM state.
  - A stranger's chat id, a spoofed Telegram request, or a wrong control key is
    accepted.
  - The underscore command names in the README are not understood.
"""

from __future__ import annotations

import json
import os
import sys
import types

# ---- Azure stubs, imported before the controller -------------------------

azure = types.ModuleType("azure")
functions = types.ModuleType("azure.functions")
identity = types.ModuleType("azure.identity")


class FunctionApp:
    def __init__(self, **kwargs):
        pass

    def route(self, **kwargs):
        return lambda function: function

    def timer_trigger(self, **kwargs):
        return lambda function: function


class AuthLevel:
    ANONYMOUS = "anonymous"


class HttpResponse:
    def __init__(self, body="", status_code=200, mimetype=None):
        self.body = body
        self.status_code = status_code
        self.mimetype = mimetype


class HttpRequest:
    pass


class TimerRequest:
    pass


class DefaultAzureCredential:
    def get_token(self, scope):
        raise AssertionError(f"the self-check must not reach Azure ({scope})")


functions.FunctionApp = FunctionApp
functions.AuthLevel = AuthLevel
functions.HttpResponse = HttpResponse
functions.HttpRequest = HttpRequest
functions.TimerRequest = TimerRequest
identity.DefaultAzureCredential = DefaultAzureCredential
azure.functions = functions
azure.identity = identity
sys.modules.update({"azure": azure, "azure.functions": functions, "azure.identity": identity})

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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import function_app as controller  # noqa: E402

VM = "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/perry"
calls: list[tuple[str, str, str]] = []
telegrams: list[tuple[str, dict]] = []
replies: list[tuple[str, str]] = []
state = {"statuses": ["Provisioning succeeded", "VM running"], "webhook": ""}


def fake_arm(method: str, path: str) -> dict:
    calls.append(("arm", method, path))
    if path.endswith("/instanceView"):
        return {"instanceView": {"statuses": [{"displayStatus": status} for status in state["statuses"]]}}
    return {}


def fake_telegram(method: str, body: dict) -> dict:
    telegrams.append((method, body))
    if method == "getWebhookInfo":
        return {"ok": True, "result": {"url": state["webhook"]}}
    return {"ok": True, "result": True}


def fake_reply(chat_id: str, text: str) -> None:
    replies.append((chat_id, text))


class FakeRequest:
    def __init__(self, payload: dict | None, headers: dict | None = None):
        self.payload = payload
        self.headers = headers or {}

    def get_json(self):
        return self.payload


def reset(statuses: list[str], webhook: str = "") -> None:
    calls.clear()
    telegrams.clear()
    replies.clear()
    state["statuses"] = statuses
    state["webhook"] = webhook


def methods() -> list[str]:
    return [method for method, _body in telegrams]


def main() -> None:
    controller.arm = fake_arm
    controller.telegram = fake_telegram
    controller.reply = fake_reply

    # /start-vm wakes the VM, then lets Telegram queue messages for Perry.
    reset(["Provisioning succeeded", "Deallocated"])
    controller.start_vm()
    assert ("arm", "POST", VM + "/start") in calls, calls
    assert "deleteWebhook" in methods(), methods()

    # /stop-vm only deallocates. The webhook is the timer's job after the VM is dead.
    reset(["Provisioning succeeded", "VM running"])
    controller.stop_vm()
    assert ("arm", "POST", VM + "/deallocate") in calls, calls
    assert "setWebhook" not in methods(), methods()

    # /restart-vm restarts in place: no deallocation, and no webhook, so Perry keeps polling.
    reset(["Provisioning succeeded", "VM running"])
    message = controller.restart_vm()
    assert "restart" in message.lower(), message
    assert ("arm", "POST", VM + "/restart") in calls, calls
    assert not [call for call in calls if call[2].endswith("/deallocate")], calls
    assert "setWebhook" not in methods() and "deleteWebhook" not in methods(), methods()

    # The timer restores the webhook only once the VM is really gone.
    reset(["Provisioning succeeded", "Deallocated"])
    controller.reconcile(None)
    assert "setWebhook" in methods(), methods()
    webhook = dict(telegrams)["setWebhook"]
    assert webhook["url"] == os.environ["TELEGRAM_WEBHOOK_URL"], webhook
    assert webhook["secret_token"] == os.environ["TELEGRAM_WEBHOOK_SECRET"], webhook

    # A running VM keeps polling; the timer must not break it.
    reset(["Provisioning succeeded", "VM running"])
    controller.reconcile(None)
    assert "setWebhook" not in methods(), methods()

    # /status-vm reports the actual state through the control route too.
    reset(["Provisioning succeeded", "VM running"])
    response = controller.control(FakeRequest({"action": "status"}, {"x-perry-control-key": "control-key"}))
    assert response.status_code == 200, response.status_code
    assert "VM running" in json.loads(response.body)["message"], response.body

    # A wrong or missing control key is refused.
    reset(["Provisioning succeeded", "VM running"])
    assert controller.control(FakeRequest({"action": "status"}, {})).status_code == 401
    assert controller.control(FakeRequest({"action": "status"}, {"x-perry-control-key": "wrong"})).status_code == 401

    # The bot's own /restart-vm reaches the same restart through the control route.
    reset(["Provisioning succeeded", "VM running"])
    response = controller.control(FakeRequest({"action": "restart"}, {"x-perry-control-key": "control-key"}))
    assert response.status_code == 200, response.status_code
    assert ("arm", "POST", VM + "/restart") in calls, calls
    assert json.loads(response.body)["ok"], response.body

    # A spoofed Telegram update is refused when the webhook secret is configured.
    reset(["Provisioning succeeded", "Deallocated"])
    update = {"message": {"chat": {"id": 42}, "text": "/start-vm"}}
    assert controller.telegram_webhook(FakeRequest(update, {})).status_code == 401
    assert controller.telegram_webhook(FakeRequest(update, {"x-telegram-bot-api-secret-token": "wrong"})).status_code == 401
    assert not calls, calls

    # The real owner's command gets through, with the secret header.
    reset(["Provisioning succeeded", "VM running"])
    response = controller.telegram_webhook(
        FakeRequest(
            {"message": {"chat": {"id": 42}, "text": "/status_vm@PerryBot"}},
            {"x-telegram-bot-api-secret-token": "telegram-secret"},
        )
    )
    assert response.status_code == 200, response.status_code
    assert replies and "VM running" in replies[-1][1], replies
    # Status reads the VM; it must not start or stop it.
    assert not [call for call in calls if call[1] == "POST"], calls

    # A stranger cannot command the VM or make it spend money.
    reset(["Provisioning succeeded", "Deallocated"])
    controller.telegram_webhook(
        FakeRequest(
            {"message": {"chat": {"id": 99}, "text": "/start-vm"}},
            {"x-telegram-bot-api-secret-token": "telegram-secret"},
        )
    )
    assert not calls, calls
    assert not replies, replies

    # Plain text while the VM is off gets directions, not silence.
    reset(["Provisioning succeeded", "Deallocated"])
    controller.telegram_webhook(
        FakeRequest(
            {"message": {"chat": {"id": 42}, "text": "are you there?"}},
            {"x-telegram-bot-api-secret-token": "telegram-secret"},
        )
    )
    assert replies and "/start-vm" in replies[-1][1], replies

    print("ok: azure vm controller checks passed")


if __name__ == "__main__":
    main()
