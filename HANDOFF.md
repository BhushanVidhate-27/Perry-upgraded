# Perry on Azure — state, 2026-10-25

Verified against the live system. Tokens and keys live in `/tmp/perry.env`
(local) and `/home/azureuser/perry.env` (VM). Never print them.

## Live

- VM `perry-vm` (Standard_B2ls_v2, 172.198.61.169), 4 GB swap file added so
  image builds no longer die with `exit 137`.
- Container `perry` on image `perry:new` = `6891b664bfd4`, `/data/.perry`
  mounted, `Telegram: polling for messages`, backend health 200.
- Controller `https://perry-ctrl-26af6748.azurewebsites.net` (F1 free) live and
  deployed from `7dd38c9`.
- Telegram menu: 19 commands — `/start`, `/career`, `/help`, `/status_vm`,
  `/start_vm`, `/stop_vm`, `/restart_vm`, `/model`, `/think`, `/access`,
  `/usage`, `/stop`, `/pause`, `/resume`, `/compact`, `/note`, `/status`,
  `/pair`, `/reset`.

## The one thing that is broken, and it is not Perry

OpenCode's **free** allowance is used up: every one of the nine models says
`Internal error: Free usage limit reached. Connect a provider or subscribe to
OpenCode Go`. It is one account-wide allowance, not per model — proven by
switching the chat to `opencode/big-pickle` from Telegram (the run records that
model) and getting the same refusal.

What Perry does about it:
- `/model` (menu or typed) still answers, because commands never reach the
  engine. Its list now adds that the engine's plan is used up, so switching
  cannot help yet.
- A turn refused for the limit now ends with "That model's plan is used up.
  /model lists this chat's models; /model <name> switches." instead of a raw
  engine string.

Ways out, in order of effort:
1. Wait for the free allowance to reset (it resets on OpenCode's schedule).
2. Connect a provider inside OpenCode (`opencode auth login`) — a Gemini,
   Groq/OpenAI-compatible or Anthropic key; its models then appear in `/model`.
   Do this **inside the container**, and note the auth file lives in
   `/root/.local/share/opencode`, which is not on the volume yet (see below).
3. Subscribe to OpenCode Go.

## Known rough edge

OpenCode's data (`/root/.local/share/opencode`: sessions, auth) is outside
`/data/.perry`, so every container recreate loses the engine session
("could not resume this chat's session") and any provider auth. Moving it onto
the volume via `XDG_DATA_HOME=/data/.perry/opencode` in `perry.env` fixes both;
not done yet.

## Verified today

- Menu spelling works: `/status_vm` from the menu reaches Perry, which folds
  `_vm` → `-vm` and calls the controller.
- `/stop_vm` deallocated the VM in 20 s; the controller took Telegram over,
  answered `/status_vm` with 200, refused a request without the secret (401),
  then `/start_vm` woke the VM and removed the webhook. Container back in 57 s.
- `/model big-pickle` switched the chat from Telegram while the plan was out.
- `pnpm typecheck` and `cloud/azure-vm-controller/check_app.py` pass.

## Open

- career-ops onboarding in `/data/.perry/workspace/career-ops`: `cv.md`,
  `config/profile.yml`, `modes/_profile.md`, `portals.yml`.
- NSG rule `open-port-7377` is still `*`; port 7377 carries the dashboard and
  `/api/backend/admin` (key-gated). Narrow it or use an SSH tunnel.
- `perry:latest` (3.36 GB, 41 h old) is the rollback image; delete when happy.
- Build images on the Mac and copy them over to stop paying 15 minutes of VM
  CPU per change; the VM build only exists because it was the simplest path.

## Rebuild and swap

```bash
ssh -i ~/.ssh/id_rsa azureuser@172.198.61.169 'cd /home/azureuser/perry-app && git fetch -q origin && git reset --hard -q origin/main && docker build -t perry:new . > /home/azureuser/build.log 2>&1'
ssh -i ~/.ssh/id_rsa azureuser@172.198.61.169 'docker rm -f perry && docker run -d --name perry --restart unless-stopped -p 7377:7377 --env-file /home/azureuser/perry.env -v /data/.perry:/data/.perry --log-opt max-size=10m perry:new'
```

While a build runs the VM is under heavy load and SSH may time out; use
`az vm run-command invoke` for status.

## Deploy the controller

```bash
cd cloud/azure-vm-controller && python3 check_app.py && zip -q /tmp/ctrl.zip app.py requirements.txt && \
az webapp deployment source config-zip -g perry-rg -n perry-ctrl-26af6748 --src /tmp/ctrl.zip
```

## Cost

`B2ls_v2` ≈ $0.0403/hr while running (~$29/month if never stopped); controller
F1 free; disk reused. `/stop-vm` deallocates and keeps the static IP.

## Key paths

- `cloud/azure-vm-controller/app.py` — WSGI controller; `COMMANDS`,
  `install_commands()`, webhook takeover.
- `cloud/azure-vm-controller/check_app.py` — offline self-check.
- `cloud/azure-vm/README.md` — VM, swap, container, career-ops runbook.
- `convex/brain.ts` — command routing; `_vm` → `-vm` fold; `/model` quota note.
- `convex/codex.ts` — `failureText()`, the refused-turn message.
- `convex/lib/usage.ts` — `LIMIT_HIT`, `standing()`.
