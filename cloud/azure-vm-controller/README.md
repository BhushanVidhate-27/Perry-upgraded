# Azure VM Telegram controller

This tiny Azure Function keeps the Telegram control path alive while the Perry
VM is deallocated. It handles `/start_vm`, `/stop_vm`, and `/status_vm`.

Configure these Function App settings:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_ALLOWED_CHAT_ID
TELEGRAM_WEBHOOK_URL
PERRY_VM_CONTROL_KEY
AZURE_SUBSCRIPTION_ID
AZURE_RESOURCE_GROUP
AZURE_VM_NAME
```

Enable a system-assigned managed identity on the Function App and grant it
`Virtual Machine Contributor` on the Perry VM or resource group. Set Telegram's
webhook to `TELEGRAM_WEBHOOK_URL`.

When Perry is running, its normal long poll removes the webhook. `/stop_vm`
first restores the webhook and then deallocates the VM, so `/start_vm` remains
available while the VM is off.

## Perry on the VM

Run Perry's container with a persistent home, and name the owner so a reset
`/data/.perry` comes back claimed instead of asking for a code:

```text
PERRY_HOME=/data/.perry
PERRY_OWNER_TELEGRAM_ID=<the owner's numeric chat id>
PERRY_OWNER_NAME=<their name>
PERRY_VM_CONTROL_URL=https://<function-app>.azurewebsites.net/api/control
PERRY_VM_CONTROL_KEY=<same value as the Function App setting>
```

Mount the host's data directory at `/data` (for example
`-v /srv/perry:/data`). Without it, recreating the container loses SQLite and
the install looks unpaired.

### `/pair`

With `PERRY_OWNER_TELEGRAM_ID` set, send `/pair` from that chat when the bot is
unpaired. Perry replies with a six-digit code; send it back to claim. Other
chats are refused, and without the setting `/pair` points back at
`pnpm run pair` on the VM.
