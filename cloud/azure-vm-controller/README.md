# Azure VM Telegram controller

A small Azure Function that keeps Telegram commands working while the Perry VM
is deallocated. It runs two HTTP routes and one timer:

| Route | Who calls it | What it does |
| --- | --- | --- |
| `POST /api/telegram` | Telegram webhook | `/start-vm`, `/stop-vm`, `/status-vm`, `/restart-vm` from the allowed chat |
| `POST /api/control` | Perry on the VM | The same four actions, for the bot's own commands |
| timer, every minute | Azure Functions | Restores the Telegram webhook once the VM is really deallocated |

The hyphenated commands are canonical; `/start_vm`, `/stop_vm`, `/status_vm`
and `/restart_vm` are accepted too. Any other message while Perry is off gets a
short hint, so the bot does not look dead.

## Function App settings

```text
TELEGRAM_BOT_TOKEN            # from @BotFather
TELEGRAM_ALLOWED_CHAT_ID      # the owner's numeric Telegram chat id
TELEGRAM_WEBHOOK_URL          # https://<function-app>.azurewebsites.net/api/telegram
TELEGRAM_WEBHOOK_SECRET       # optional but recommended; see below
PERRY_VM_CONTROL_KEY          # long random string, shared with Perry
AZURE_SUBSCRIPTION_ID
AZURE_RESOURCE_GROUP
AZURE_VM_NAME
AzureWebJobsStorage           # required by the timer trigger
```

`AzureWebJobsStorage` is the Function App's storage connection string (the
default name the Functions runtime looks for). The timer will not run without
it. Keep the app warm with **Always On** (or a minimum instance count on a Flex
Consumption plan), otherwise webhook restoration waits for the next wake-up.

Enable a system-assigned managed identity on the Function App and grant it
**Virtual Machine Contributor** on the Perry VM or its resource group. The
controller uses `DefaultAzureCredential`, so no Azure secret is stored in app
settings.

If `TELEGRAM_WEBHOOK_SECRET` is set, the function passes it to Telegram as
`secret_token` when installing the webhook and rejects any request whose
`X-Telegram-Bot-Api-Secret-Token` header does not match. Set the same value in
both places; the function does the registration itself. Telegram does not
report whether a webhook has a secret, so if you add or change the secret after
the webhook already exists, remove the webhook once (or call `setWebhook`)
and let the timer install it again.

## Start, stop, status

- `/stop-vm` deallocates the VM immediately and replies that Perry is saving
  state. It deliberately does **not** install the webhook: the still-running
  Perry polls Telegram, sees a webhook, removes it (Telegram refuses
  `getUpdates` while one is set), and the VM would finish deallocating with no
  way to send `/start-vm`.
- The timer watches the VM's `instanceView`. Only when the status contains
  `deallocated` does it install the webhook, so commands reach this function
  while the VM is off.
- `/start-vm` starts the VM and removes the webhook, so messages sent during
  boot queue for Perry instead of being consumed here. Perry also removes a
  leftover webhook on its first poll.
- `/status-vm` reads the real `instanceView` statuses and works in either
  state.
- `/restart-vm` restarts the VM in place (`POST .../restart`): same
  allocation, same public IP, no deallocation, and no webhook change, so Perry
  keeps polling. Use it when the bot has stopped answering but the VM is up.

`POST /api/control` takes `{"action": "start" | "stop" | "restart" | "status"}`
and requires the `x-perry-control-key` header. This is what `convex/brain.ts`
calls when the owner sends `/start-vm`, `/stop-vm`, `/status-vm` or
`/restart-vm` to Perry while the VM is running.

## Perry on the VM

Run Perry's container with a persistent `/data` volume. The volume holds
`PERRY_HOME`, which contains Perry's SQLite database: memory, chats, settings
and pairing. Without it, recreating the container loses all of that and the
install looks unpaired again.

```bash
docker build -t perry .
docker run -d --name perry --restart unless-stopped \
  -p 7377:7377 \
  -v /srv/perry:/data \
  -e PERRY_HOME=/data/.perry \
  -e PERRY_PORT=7377 \
  -e DASHBOARD_KEY='<long random string>' \
  -e TELEGRAM_BOT_TOKEN='<from @BotFather>' \
  -e PERRY_OWNER_TELEGRAM_ID='<owner numeric chat id>' \
  -e PERRY_OWNER_NAME='<their name>' \
  -e PERRY_VM_CONTROL_URL='https://<function-app>.azurewebsites.net/api/control' \
  -e PERRY_VM_CONTROL_KEY='<same value as the Function App setting>' \
  perry
```

- `PERRY_OWNER_TELEGRAM_ID` and `PERRY_OWNER_NAME` claim the install on a fresh
  volume, so it does not ask for a pairing code after a reset.
- `PERRY_VM_CONTROL_URL` and `PERRY_VM_CONTROL_KEY` let Perry's own
  `/start-vm`, `/stop-vm` and `/status-vm` commands reach this function.
- Telegram is polled outbound, so the VM needs no public inbound port for the
  bot. Port `7377` is only for the dashboard; put it behind a private network or
  a password if it is exposed.
- To keep OpenCode's own session cache across container recreation as well,
  also mount a volume at `/root/.local/share/opencode`. Perry's memory and chats
  do not depend on it; they live in `/data`.

## Deploying the function

From this folder:

```bash
func azure functionapp publish <function-app>
```

The `requirements.txt` installs `azure-functions` and `azure-identity`. After
the first deploy, set the app settings above, enable the managed identity and
role assignment, then let the timer install the webhook (or call
`setWebhook` once by hand with the same URL and secret).

## `/pair`

With `PERRY_OWNER_TELEGRAM_ID` set, send `/pair` from that chat when the bot is
unpaired. Perry replies with a six-digit code; send it back to claim. Other
chats are refused, and without the setting `/pair` points back at
`pnpm run pair` on the VM.
