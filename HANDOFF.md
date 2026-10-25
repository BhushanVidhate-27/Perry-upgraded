# Perry on Azure — state, 2026-10-25

Verified against the live system. Tokens and keys live in `/tmp/perry.env`
(local) and `/home/azureuser/perry.env` (VM). Never print them.

## Live

- VM `perry-vm` (Standard_B2ls_v2, 172.198.61.169), 4 GB swap file added so
  image builds no longer die with `exit 137`.
- Container `perry` on image `perry:new` = `73c52ff19a84`, built from
  `479205b` at 14:16 UTC: `/data/.perry` mounted, `XDG_DATA_HOME=/data/.perry`,
  `Telegram: polling for messages`, backend health 200, 22-command menu.
  `perry:latest` = `769084e965a4` is the rollback. `/account` and `/schedule`
  are in this image.
- Controller `https://perry-ctrl-26af6748.azurewebsites.net` (F1 free) live,
  deployed from `e24733e`: wake-on-message, synchronous idle stop, and the
  settings `PERRY_BASE_URL=http://172.198.61.169:7377` and
  `PERRY_DASHBOARD_KEY` (same key as the VM). `GET /` shows
  `"forwarding": true`.
- Auto-off installed on the VM and its timer active: `auto_off.py` checks every
  5 min, stops after **30 min idle**, never under **10 min uptime**, and not
  when a job is due within **5 min**. The stop waits for the webhook takeover;
  the next message starts the VM, forwards that update, and Perry answers.
- Telegram menu: 22 commands — `/start`, `/career`, `/schedule`, `/schedules`,
  `/account`, `/help`, `/status_vm`, `/start_vm`, `/stop_vm`, `/restart_vm`,
  `/model`, `/think`, `/access`, `/usage`, `/stop`, `/pause`, `/resume`,
  `/compact`, `/note`, `/status`, `/pair`, `/reset`.

## Schedules from Telegram

- `/schedule <when> <what>` is a turn, like `/career`: the words reach the model
  with the instruction to call `create_job`, so it works out the time in the
  owner's timezone and asks before creating anything unclear.
- `/schedules` (and bare `/schedule`) is deterministic — it never reaches the
  engine, so it answers even while the plan is out. It lists the owner's jobs,
  next run on their clock, leaves out Perry's four built-in upkeep jobs and
  one-time jobs whose time has gone.
- Both are in the menu. The controller republishes the menu on takeover.

## Logins from Telegram

- `/account <name> <username> <password>` saves a login in Settings → Logins &
  secrets without the engine, so it works while a plan is used up. The name may
  have spaces; the password is the last word.
- `/account` (or `/account list`) prints the saved logins and usernames, never
  a password.
- The password message is deleted from Telegram once it is saved; the vault also
  scrubs it from Perry's chat, turns and traces. The agent uses it with
  `use_secret` or the browser's `sign_in` when the owner asks.
- On `origin/main` (`af17cf7`); the running image gets it at midnight.

## The midnight build

- `cloud/azure-vm/midnight-build.sh` is on the VM, run by root cron
  `30 18 * * *` (18:30 UTC = 00:00 IST). It is one-shot: it removes its own
  entry first.
- It resets to `origin/main`, builds, swaps with rollback, waits for health,
  publishes the menu from the controller's `COMMANDS`, and reports in Telegram.
  Log: `/home/azureuser/midnight-build.log`.
- Run manually at 14:16 UTC on 2026-10-25; its cron entry was removed first, so
  it does not run again at 18:30. Image `73c52ff19a84`, health 200, menu
  published, old `769084e965a4` kept as `perry:latest`.

## The model pool, and the fallback

OpenCode's **free** allowance was used up when tested: every one of the nine
models said `Internal error: Free usage limit reached. Connect a provider or
subscribe to OpenCode Go`. It is one account-wide allowance, not per model —
proven by switching the chat to `opencode/big-pickle` from Telegram (the run
records that model) and getting the same refusal.

Groq is connected now, so a quota refusal on the bundled pool is no longer a
dead end: `/model` lists the seven Groq models too, and switching is manual
(`/model groq/openai/gpt-oss-20b`). There is no automatic failover.

What Perry does about it:
- `/model` (menu or typed) still answers, because commands never reach the
  engine. Its list adds that the engine's plan is used up, so switching cannot
  help yet.
- A turn refused for the limit ends with "That model's plan is used up. /model
  lists this chat's models; /model <name> switches." instead of a raw engine
  string.
- `/schedules` works; `/schedule <words>` is a turn, so it can create a job as
  soon as the chosen model has room (for example a Groq one).
- `/model <name>` switches this chat to another engine's model and picks up
  from the chat so far.

Ways out, in order of effort:
1. Wait for the free allowance to reset (it resets on OpenCode's schedule).
2. Connect a provider inside OpenCode (`opencode auth login`) — a Gemini,
   Groq/OpenAI-compatible or Anthropic key; its models then appear in `/model`.
   Do this **inside the container**:
   `docker exec -it perry /root/.opencode/bin/opencode auth login`, or use
   Settings → Engines → OpenCode → Connect, which refreshes the list at once
   (a manual login shows up within two minutes, the list's cache). Auth lives
   in `/data/.perry/opencode`, on the volume, so it survives container
   recreates. Bundled models stay first (so the default does not move) and only
   the models of providers actually connected with `opencode auth login`
   follow — switching is manual with `/model <name>`; there is no automatic
   failover to another model.
   **Groq is connected** on the VM (`groq` in `opencode auth list`, 7 models;
   `opencode run -m groq/openai/gpt-oss-20b` answered `GROQ OK`). The running
   image lists 16 models: the nine bundled, then the seven Groq. The key is in
   `/data/.perry/opencode`, never in the repo or `perry.env`.
3. Subscribe to OpenCode Go.

## OpenCode data on the volume

`XDG_DATA_HOME=/data/.perry` is set in `perry.env`, so OpenCode keeps sessions,
auth and its database in `/data/.perry/opencode` instead of
`/root/.local/share/opencode`. Verified after a turn: the directory holds
`opencode.db`, `log`, `repos` and `shell`. Engine sessions and any provider
auth now survive a container recreate.

## Verified today

- Menu spelling works: `/status_vm` from the menu reaches Perry, which folds
  `_vm` → `-vm` and calls the controller.
- `/stop_vm` deallocated the VM in 20 s; the controller took Telegram over,
  answered `/status_vm` with 200, refused a request without the secret (401),
  then `/start_vm` woke the VM and removed the webhook. Container back in 57 s.
- `/model big-pickle` switched the chat from Telegram while the plan was out.
- Groq connected inside the container: `opencode auth list` names `groq`, the
  CLI lists 7 `groq/*` models, and a real turn on `groq/openai/gpt-oss-20b`
  answered. Feeding the VM's real `opencode models` and auth output through
  `offeredModels` gives 16 models, bundled first, default `opencode/beam-free`,
  and no provider that is not connected.
- `/schedules` from Telegram: 200, reply sent with no error. Only Perry's four
  built-in jobs exist, and they are filtered out, so it says nothing is
  scheduled.
- `/schedule every Monday at 9:00 send me a plan for the week`: the turn
  `337qv2ztghpty0f4kqbd1mbcer` carries the `create_job` instruction and the
  owner's words, and failed only on the OpenCode quota.
- `/data/.perry/opencode` is populated and used after that turn.
- The running image lists **16 models** (`models:list`): the nine bundled, then
  the seven Groq, default `opencode/opencode/beam-free`. This is the live list,
  not a projection.
- Auto-off, end to end: the watchdog asked the controller to stop at 14:25:14,
  Azure showed deallocated at 14:25:41, the controller installed the webhook.
  A synthetic owner update then started the VM at 14:27:46; the admin route
  answered at 14:29:00 (**74 s**), the controller removed the webhook, and Perry
  was polling again. The owner chat got the `/status` reply.
- `python3 cloud/azure-vm-controller/check_app.py` and
  `python3 cloud/azure-vm/check_auto_off.py` pass; `pnpm typecheck` passes.

## Open

- career-ops onboarding in `/data/.perry/workspace/career-ops`: `cv.md`,
  `config/profile.yml`, `modes/_profile.md`, `portals.yml`.
- NSG rule `open-port-7377` is still `*`; port 7377 carries the dashboard and
  `/api/backend/admin` (key-gated). The controller now sends the dashboard key
  to it over plain HTTP to forward a waking message, so anyone who can watch
  that path can read the key. Narrow the rule to App Service's outbound
  addresses, or put an HTTPS front (a DNS name and Caddy) in front of 7377.
- Auto-off does not wake for an exact schedule time: a job due while the VM is
  off catches up on the next message (`jobs.tick`). An external wake timer is
  the upgrade if exact-time delivery is needed.
- The controller's wake runs in a background thread after Telegram's 200. An
  App Service recycle during that ~75 s would lose the forwarded message; the
  owner sees "Starting Perry" but no reply and can resend.
- `perry:latest` (3.36 GB) is the rollback image; delete when happy.
- Build images on the Mac and copy them over to stop paying ~15 minutes of VM
  CPU per change; the VM build only exists because it was the simplest path.

## Rebuild and swap

```bash
ssh -i ~/.ssh/id_rsa azureuser@172.198.61.169 'cd /home/azureuser/perry-app && git fetch -q origin && git reset --hard -q origin/main && docker build -t perry:new . > /home/azureuser/build.log 2>&1'
ssh -i ~/.ssh/id_rsa azureuser@172.198.61.169 'docker rm -f perry && docker run -d --name perry --restart unless-stopped -p 7377:7377 --env-file /home/azureuser/perry.env -v /data/.perry:/data/.perry --log-opt max-size=10m perry:new'
```

While a build runs the VM is under heavy load and SSH may time out; use
`az vm run-command invoke` for status. The build takes ~15 minutes on 2 vCPU.

## Deploy the controller

```bash
cd cloud/azure-vm-controller && python3 check_app.py && zip -q /tmp/ctrl.zip app.py requirements.txt && \
az webapp deployment source config-zip -g perry-rg -n perry-ctrl-26af6748 --src /tmp/ctrl.zip
```

The wake path also needs two app settings (already set; use the VM's
`DASHBOARD_KEY` value without printing it):

```text
PERRY_BASE_URL=http://172.198.61.169:7377
PERRY_DASHBOARD_KEY=<the VM's DASHBOARD_KEY>
```

## Cost

`B2ls_v2` ≈ $0.0448/hr while running (Central India proxy; about $32.70/month
24/7), plus the 32 GiB disk ($1.69) and the static IP ($3.65): **$38.04/month**
awake all the time, **$5.34/month** deallocated. With 30-minute auto-off and a
couple of hours of use a day it lands near **$8–10/month**, so the $100 student
credit lasts most of its 12-month life. The credit expires; leftover credit is
not refunded.

## Auto-off install

Files in `cloud/azure-vm`: `auto_off.py`, `check_auto_off.py`,
`perry-auto-off.service`, `perry-auto-off.timer`. They are installed in
`/usr/local/bin/perry-auto-off.py` and `/etc/systemd/system/`, with the timer
enabled. Logs:

```bash
systemctl list-timers perry-auto-off.timer
sudo journalctl -u perry-auto-off.service -n 20 --no-pager
```

Dry run, without stopping anything:

```bash
sudo systemd-run --pipe --wait \
  --property=EnvironmentFile=/home/azureuser/perry.env \
  --setenv=PERRY_AUTO_OFF_DRY_RUN=1 \
  /usr/bin/python3 /usr/local/bin/perry-auto-off.py
```

## Key paths

- `cloud/azure-vm-controller/app.py` — WSGI controller; `COMMANDS`,
  `install_commands()`, webhook takeover, `wake()`, `stop_vm(wait=True)`.
- `cloud/azure-vm-controller/check_app.py` — offline self-check.
- `cloud/azure-vm/auto_off.py` — idle decision and the controller stop.
- `cloud/azure-vm/check_auto_off.py` — offline self-check for the money rules.
- `cloud/azure-vm/perry-auto-off.service`, `.timer` — systemd units on the VM.
- `cloud/azure-vm/README.md` — VM, swap, container, auto-off, career-ops.
- `convex/brain.ts` — command routing; `_vm` → `-vm` fold; `/model` quota note;
  `/schedule` turn and `/schedules` list.
- `convex/lib/commands.ts` — `scheduleAsk()`, `describeSchedules()`.
- `convex/codex.ts` — `failureText()`, the refused-turn message.
- `convex/lib/usage.ts` — `LIMIT_HIT`, `standing()`.
