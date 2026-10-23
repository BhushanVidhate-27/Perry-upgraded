import json
import os
import urllib.error
import urllib.request

import azure.functions as func
from azure.identity import DefaultAzureCredential

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)


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


def start_vm(chat_id: str) -> str:
    arm("POST", vm_path() + "/start")
    return "Starting Perry. It usually takes a minute or two. I will be back when the VM is ready."


def stop_vm() -> str:
    webhook = setting("TELEGRAM_WEBHOOK_URL")
    telegram("setWebhook", {"url": webhook, "allowed_updates": ["message"]})
    arm("POST", vm_path() + "/deallocate")
    return "Perry is saving state and shutting down to save Azure credits."


@app.route(route="telegram", methods=["POST"])
def telegram_webhook(request: func.HttpRequest) -> func.HttpResponse:
    try:
        update = request.get_json()
        message = update.get("message") or {}
        chat = message.get("chat") or {}
        chat_id = str(chat.get("id", ""))
        text = str(message.get("text", "")).strip().split()[0].lower().split("@")[0] if message.get("text") else ""
        if not authorized(chat_id):
            return func.HttpResponse("ignored", status_code=200)
        if text == "/start-vm":
            reply(chat_id, start_vm(chat_id))
        elif text == "/status-vm":
            state = arm("GET", vm_path() + "/instanceView").get("instanceView", {}).get("statuses", [])
            names = [item.get("displayStatus") for item in state if item.get("displayStatus")]
            reply(chat_id, f"Azure VM: {', '.join(names) or 'unknown'}")
        elif text == "/stop-vm":
            reply(chat_id, stop_vm())
        return func.HttpResponse("ok", status_code=200)
    except Exception as error:
        try:
            chat_id = str((update.get("message") or {}).get("chat", {}).get("id", ""))
            if chat_id and authorized(chat_id):
                reply(chat_id, f"VM control failed: {error}")
        except Exception:
            pass
        return func.HttpResponse("controller error", status_code=500)


@app.route(route="control", methods=["POST"])
def control(request: func.HttpRequest) -> func.HttpResponse:
    if request.headers.get("x-perry-control-key") != setting("PERRY_VM_CONTROL_KEY"):
        return func.HttpResponse("unauthorized", status_code=401)
    try:
        action = request.get_json().get("action")
        if action == "start":
            message = start_vm(setting("TELEGRAM_ALLOWED_CHAT_ID"))
        elif action == "stop":
            message = stop_vm()
        elif action == "status":
            message = "Azure VM control is available."
        else:
            return func.HttpResponse("unknown action", status_code=400)
        return func.HttpResponse(json.dumps({"ok": True, "message": message}), mimetype="application/json")
    except Exception as error:
        return func.HttpResponse(json.dumps({"ok": False, "error": str(error)}), status_code=500, mimetype="application/json")
