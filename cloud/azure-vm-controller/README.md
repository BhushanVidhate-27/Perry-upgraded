# Azure VM Telegram controller

A small web app that keeps Telegram commands working while the Perry VM is
deallocated. It serves two routes:

| Route | Who calls it | What it does |
| --- | --- | --- |
| `POST /api/telegram` | Telegram webhook | `/start-vm`, `/stop-vm`, `/status-vm`, `/restart-vm` from the allowed chat |
| `POST /api/control` | Perry on the VM | The same four actions, for the bot's own commands |
| `GET /` | you, or uptime checks | `ok` |

The hyphenated commands are canonical; `/start_vm`, `/stop_vm`, `/status_vm`
and `/restart_vm` are accepted too. Any other message while Perry is off gets a
short hint, so the bot does not look dead.

### The menu in Telegram

Whenever the app points Telegram at itself it also publishes the command menu
(`setMyCommands`), so the blue button beside the message box lists what Perry
does — the same commands `/help` prints. Telegram refuses a hyphen in a menu
name, so the four VM commands are listed as `/start_vm`, `/stop_vm`,
`/status_vm` and `/restart_vm`; Perry folds a trailing `_vm` back to `-vm`, so
both spellings are one command. To publish the menu without waiting for a
takeover, run `install_commands()` from `app.py` on a machine with
`TELEGRAM_BOT_TOKEN` set.

It is a plain WSGI app (`app.py`), served by gunicorn on an **F1 (free) Linux
App Service plan**, so it costs nothing while it waits. There is no framework
and no Azure SDK: the only dependency is gunicorn.

## App settings

```text
TELEGRAM_BOT_TOKEN            # from @BotFather
TELEGRAM_ALLOWED_CHAT_ID      # the owner's numeric Telegram chat id
TELEGRAM_WEBHOOK_URL          # https://<app>.azurewebsites.net/api/telegram
TELEGRAM_WEBHOOK_SECRET       # optional but recommended; see below
PERRY_VM_CONTROL_KEY          # long random string, shared with Perry
AZURE_SUBSCRIPTION_ID
AZURE_RESOURCE_GROUP
AZURE_VM_NAME
```

Enable a system-assigned managed identity and grant it **Virtual Machine
Contributor** on the Perry VM (or its resource group). The app asks the
platform's token endpoint (`IDENTITY_ENDPOINT`/`IDENTITY_HEADER`) for a token,
so no Azure secret is stored anywhere and there is no `azure-identity`
dependency.

If `TELEGRAM_WEBHOOK_SECRET` is set, the app passes it to Telegram as
`secret_token` when installing the webhook and rejects any request whose
`X-Telegram-Bot-Api-Secret-Token` header does not match. Telegram does not
report whether a webhook has a secret, so if you add or change the secret after
the webhook already exists, remove the webhook once (or call `setWebhook`) and
let the next stop install it again.

## Start, stop, status

- `/start-vm` starts the VM, then removes the webhook, so messages sent while
  Perry boots queue up for it instead of being consumed here. Perry also
  removes a leftover webhook on its first poll.
- `/stop-vm` deallocates the VM and replies immediately. **Then**, out of band,
  it waits for `instanceView` to say `deallocated` and only then points Telegram
  at this app. Installing the webhook earlier loses every later command: the
  still-running Perry polls Telegram, sees a webhook, removes it (Telegram
  refuses `getUpdates` while one is set), and the VM finishes deallocating with
  no way to send `/start-vm`.
- There is no timer. The free plan has no always-on, so a timer would not run
  reliably anyway; the takeover happens in a background thread, and
  `/status-vm` re-installs the webhook whenever it finds the VM off and
  Telegram pointed elsewhere. That is the self-heal for a stop whose background
  takeover was cut short.
- `/status-vm` reads the real `instanceView` statuses and works in either
  state. `/restart-vm` restarts the VM in place (`POST .../restart`): same
  allocation, same public IP, no deallocation, no webhook change, so Perry keeps
  polling. Use it when the bot has stopped answering but the VM is up.

`POST /api/control` takes `{"action": "start" | "stop" | "restart" | "status"}`
and requires the `x-perry-control-key` header. This is what `convex/brain.ts`
calls when the owner sends `/start-vm`, `/stop-vm`, `/status-vm` or
`/restart-vm` to Perry while the VM is running.

## Deploying

The plan is F1 Linux in `indiasouthcentral` (the only low-cost region this
student subscription's "allowed deployment regions" policy permits next to the
VM). Deploy the two files and restart:

```bash
zip -q /tmp/ctrl.zip app.py requirements.txt
az webapp deployment source config-zip -g perry-rg -n perry-ctrl-26af6748 --src /tmp/ctrl.zip
```

The startup command is `gunicorn --bind=0.0.0.0 --timeout 600 app:app`, and
`SCM_DO_BUILD_DURING_DEPLOYMENT=true` makes the platform install
`requirements.txt`. Cold start after the plan idles out is ten to twenty
seconds, well inside Telegram's webhook timeout.

Check it after a deploy:

```bash
python3 check_app.py   # no Azure, no Telegram, no network
curl -s https://perry-ctrl-26af6748.azurewebsites.net/
curl -s -X POST https://perry-ctrl-26af6748.azurewebsites.net/api/control \
  -H "x-perry-control-key: $(cat /path/to/key)" \
  -d '{"action":"status"}'
```

A real answer looks like `{"ok": true, "message": "Azure VM: Provisioning
succeeded, VM running"}`.

## Perry on the VM

Run Perry's container with a persistent `/data` volume. The volume holds
`PERRY_HOME`, which contains Perry's SQLite database: memory, chats, settings
and pairing. Without it, recreating the container loses all of that and the
install looks unpaired again.

```bash
docker run -d --name perry --restart unless-stopped \
  -p 7377:7377 \
  --env-file /home/azureuser/perry.env \
  -v /data/.perry:/data/.perry \
  --log-opt max-size=10m \
  perry:latest
```

- `PERRY_OWNER_TELEGRAM_ID` and `PERRY_OWNER_NAME` claim the install on a fresh
  volume, so it does not ask for a pairing code after a reset.
- `PERRY_VM_CONTROL_URL` and `PERRY_VM_CONTROL_KEY` let Perry's own
  `/start-vm`, `/stop-vm`, `/status-vm` and `/restart-vm` commands reach this
  app.
- `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` points career-ops at the Chromium
  baked into the image, so a container recreate needs no browser download.
- Telegram is polled outbound, so the VM needs no public inbound port for the
  bot. Port `7377` is only for the dashboard; put it behind a private network or
  a password if it is exposed.

## `/pair`

With `PERRY_OWNER_TELEGRAM_ID` set, send `/pair` from that chat when the bot is
unpaired. Perry replies with a six-digit code; send it back to claim. Other
chats are refused, and without the setting `/pair` points back at
`pnpm run pair` on the VM.
