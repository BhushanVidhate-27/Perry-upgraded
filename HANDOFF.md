# Perry on Azure — state, 2026-10-25

Everything below was verified against the live system, not assumed. Tokens and
keys live in `/tmp/perry.env` (local) and `/home/azureuser/perry.env` (VM).
Never print them.

## Live

- VM `perry-vm` (Standard_B2ls_v2, 172.198.61.169) running, container `perry`
  on the rebuilt image `perry:new` (0b9128e27d7b), `/data/.perry` mounted,
  Telegram polling, runner connected, 584 backend functions.
- Controller `https://perry-ctrl-26af6748.azurewebsites.net` (F1 free) live.
  `/` reports ok, webhook_secret true, control_key true.
- Telegram menu (17 commands) registered on `@bhushansPerryBot`, plus bot
  description and short description.

## What was proven today

- Image carries the `_vm` → `-vm` fold: `grep -n _vm /app/convex/brain.ts`
  inside `perry:new` shows line 75.
- Menu spelling reaches the VM: a synthetic Telegram update `"/status_vm"`
  through `POST /api/backend/admin` → `ingest:fromTelegram` returned 200 with no
  error in the container log (real parser, brain, controller, Bot API).
- `/stop_vm` from the same path deallocated the VM within 20 s.
- The controller took Telegram over (webhook URL became the App Service URL,
  pending 0, no last error), answered `/status_vm` with 200 `ok`, refused the
  same request without the secret header (401).
- `/start_vm` to the controller returned 200, removed the webhook, VM went
  running, container back up in ~57 s, polling resumed.
- `check_app.py` passes, `pnpm typecheck` clean, repo at `f7f1db2`.

## Only the owner can confirm (10 seconds)

Four messages should be sitting in Telegram from the tests: `/status_vm` →
"Azure VM: … VM running", `/stop_vm` → "Perry is saving state…",
`/status_vm` while off → "…deallocated", `/start_vm` → "Starting Perry…".
Open the blue menu button and tap any command once; that is the last link
(Telegram's own delivery) nothing else can exercise.

## Open, not started

- career-ops onboarding in `/data/.perry/workspace/career-ops`: `cv.md`,
  `config/profile.yml`, `modes/_profile.md`, `portals.yml`.
- NSG rule `open-port-7377` is still `*`. Port 7377 carries
  `/api/backend/admin` (dashboard key) and the dashboard; narrow it to the
  owner's IP or close it and use SSH tunnels.
- `perry:latest` (3.36 GB) is the rollback image from before today's build;
  delete it once nothing regresses.
- OpenCode sessions live in `/root/.local/share/opencode`, not on the volume, so
  a container recreate starts a fresh engine session. Perry's memory is
  unaffected (`/data/.perry` keeps it).

## Rebuild and swap (after editing app code)

```bash
ssh -i ~/.ssh/id_rsa azureuser@172.198.61.169 'cd /home/azureuser/perry-app && git fetch -q origin && git reset --hard -q origin/main && docker build -t perry:new . > /home/azureuser/build.log 2>&1'
ssh -i ~/.ssh/id_rsa azureuser@172.198.61.169 'docker rm -f perry && docker run -d --name perry --restart unless-stopped -p 7377:7377 --env-file /home/azureuser/perry.env -v /data/.perry:/data/.perry --log-opt max-size=10m perry:new'
```

The build takes ~15 minutes on 2 vCPU. `perry:latest` is the previous image.

## Deploy the controller

```bash
cd cloud/azure-vm-controller && python3 check_app.py && zip -q /tmp/ctrl.zip app.py requirements.txt && \
az webapp deployment source config-zip -g perry-rg -n perry-ctrl-26af6748 --src /tmp/ctrl.zip
```

Setting changes take up to ~2 min to apply (a stale instance can serve old env).

## Cost

`B2ls_v2` ≈ $0.0403/hr running (~$29/month if never stopped); controller F1 is
free; disk is reused. `/stop-vm` deallocates and keeps the static IP; the
controller answers while the VM is off.

## Key paths

- `cloud/azure-vm-controller/app.py` — WSGI controller; `COMMANDS`,
  `install_commands()`, webhook takeover.
- `cloud/azure-vm-controller/check_app.py` — offline self-check.
- `cloud/azure-vm-controller/README.md` — deploy, settings, menu.
- `cloud/azure-vm/README.md` — VM, disk, container, career-ops runbook.
- `convex/brain.ts` — command routing; `_vm` → `-vm` fold in `runCommand`.
- `convex/lib/commands.ts` — `careerAsk()`.
