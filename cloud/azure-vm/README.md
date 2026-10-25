# Perry on an Azure VM

Perry runs as one Docker container on a small Linux VM, with its memory on the
VM's own disk. The Telegram controller in `cloud/azure-vm-controller` keeps
`/start-vm`, `/stop-vm`, `/status-vm` and `/restart-vm` reachable whenever this
VM is deallocated.

## What is deployed

| Thing | Name | Notes |
| --- | --- | --- |
| VM | `perry-vm` | `Standard_B2ls_v2`, 2 vCPU / 4 GB, `indiasouthcentral` |
| Resource group | `perry-rg` | holds the VM, its disk, NIC, IP and the controller's plan |
| OS disk | `perry-vm_OsDisk_1_...` | 32 GB, gen2, x86; the only stateful part besides the controller |
| NIC / IP | `perry-vmVMNic` / `perry-vmPublicIP` | the IP is **Static**, so it survives deallocate/start |
| Container | `perry` | `--restart unless-stopped`, `/data/.perry` bind-mounted from the disk |

`Standard_B2ls_v2` is the cheapest size that actually runs the stack: Next.js,
OpenCode, Bun and Chromium together do not fit in the 1 GB free-tier sizes
(`B1s`, `B2ats_v2`, `B2pts_v2`). At roughly 0.04 USD/hour it is about 100 days
of continuous runtime on the student credit, and deallocating when idle
stretches that further.

The `Azure for Students` subscription restricts deployments to a short list of
regions (`indiasouthcentral`, `eastasia`, `koreacentral`, `malaysiawest`,
`polandcentral`). Anything else fails with `RequestDisallowedByAzure`. Keep new
resources in one of those.

## Recreate the VM from the existing disk

If the VM is ever deleted, the disk, NIC and IP can be reused. Do not delete
them together.

```bash
az vm create -g perry-rg -n perry-vm \
  --location indiasouthcentral \
  --size Standard_B2ls_v2 \
  --attach-os-disk perry-vm_OsDisk_1_35a1cce2a3934cc1baa2d9897bc491d9 \
  --os-type Linux \
  --nics perry-vmVMNic
```

SSH in as `azureuser` with the key that is already in the disk's
`authorized_keys`. If the host key changed, `ssh-keygen -R 172.198.61.169`
first.

Resizing is deallocate plus `az vm resize`; nothing needs rebuilding. `B1ms`
(2 GB) could double the runtime if the idle footprint stays under ~1.5 GB, but
career-ops' Chromium does not leave much room.

## The container

The image is built from the repo's `Dockerfile` on the VM:

```bash
git clone --depth 1 https://github.com/BhushanVidhate-27/Perry-upgraded.git ~/perry-app
cd ~/perry-app
docker build -t perry:new .
```

`next build` needs more memory than the VM has while Perry runs: without swap
the kernel kills it (`exit 137`). A 4 GB swap file is enough, and keeps Perry
alive during a build:

```bash
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo "/swapfile none swap sw 0 0" >> /etc/fstab
```

Then swap it in, keeping the old container until the new one is healthy:

```bash
docker stop perry && docker rename perry perry-old
docker run -d --name perry --restart unless-stopped \
  -p 7377:7377 \
  --env-file /home/azureuser/perry.env \
  -v /data/.perry:/data/.perry \
  --log-opt max-size=10m \
  perry:new
curl -sf http://127.0.0.1:7377/api/backend/http/health && echo up
docker logs --tail 40 perry        # expect "Telegram: polling for messages"
```

If it does not come up, `docker rm -f perry && docker rename perry-old perry
&& docker start perry` puts the old one back.

### A build at midnight

`cloud/azure-vm/midnight-build.sh` does the same unattended: reset to
`origin/main`, build, swap, wait for health, put the old container back on
failure, publish the Telegram menu from the controller's `COMMANDS`, and say
how it went in Telegram. It takes its own cron entry out first, so it runs
once. Install it for midnight IST (18:30 UTC) with:

```bash
scp -i ~/.ssh/id_rsa cloud/azure-vm/midnight-build.sh azureuser@172.198.61.169:/home/azureuser/
ssh -i ~/.ssh/id_rsa azureuser@172.198.61.169 'chmod +x /home/azureuser/midnight-build.sh'
ssh -i ~/.ssh/id_rsa azureuser@172.198.61.169 "sudo bash -c '(crontab -l 2>/dev/null; echo \"30 18 * * * /home/azureuser/midnight-build.sh\") | crontab -'"
```

The log is `/home/azureuser/midnight-build.log`. Make the entry
`0 0 * * *` instead for UTC midnight.

## Stopping when idle

The VM deallocates itself after **30 minutes** with no messages and no running
turn. Compute is then free; the 32 GB disk, the static IP and the controller
still cost about **5.34 USD/month**. Because a cold start takes about a minute,
30 minutes is the default: a 15-minute tail saves roughly 0.67 USD/month at
three sessions a day and stops during natural pauses in a conversation.

`auto_off.py` runs from a systemd timer. It asks Perry's own admin API and
stops only when **all** of these hold:

- no turn has `status: running`;
- no SSH session and no image build is active;
- the VM has been up for at least **10 minutes**;
- the newest message in any chat is at least **30 minutes** old;
- no enabled schedule is due within **5 minutes** (unless Perry is paused);
- the admin route answered (if it cannot tell, it leaves the VM up).

Install it on the VM:

```bash
ssh -i ~/.ssh/id_rsa azureuser@172.198.61.169 '
  cd ~/perry-app &&
  git pull --ff-only &&
  sudo install -m 755 cloud/azure-vm/auto_off.py /usr/local/bin/perry-auto-off.py &&
  sudo install -m 644 cloud/azure-vm/perry-auto-off.service cloud/azure-vm/perry-auto-off.timer /etc/systemd/system/ &&
  sudo systemctl daemon-reload &&
  sudo systemctl enable --now perry-auto-off.timer
'
```

The timer checks 10 minutes after boot and every 5 minutes after that. Its
decisions go to the journal:

```bash
systemctl list-timers perry-auto-off.timer
sudo journalctl -u perry-auto-off.service -n 20 --no-pager
```

See the decision without stopping anything:

```bash
ssh -i ~/.ssh/id_rsa azureuser@172.198.61.169 '
  sudo systemd-run --pipe --wait \
    --property=EnvironmentFile=/home/azureuser/perry.env \
    --setenv=PERRY_AUTO_OFF_DRY_RUN=1 \
    /usr/bin/python3 /usr/local/bin/perry-auto-off.py
'
```

Tune it in `/home/azureuser/perry.env` (then
`sudo systemctl daemon-reload` is not needed; the next run reads it):

```text
PERRY_IDLE_MINUTES=30
PERRY_MIN_UPTIME_MINUTES=10
PERRY_JOB_GUARD_MINUTES=5
```

**Schedules while the VM is off** run when it next wakes, not at their exact
time: `jobs.tick` catches up what came due. If exact-time delivery matters,
keep the VM awake over that window, or add an external wake timer later.

The next message wakes the VM: the controller starts it, waits for the admin
route, removes the webhook and forwards that message. The measured cold start
is **57 seconds**; budget a minute. `/start-vm` still works and skips the
message.

Everything that matters lives in `/data/.perry`: `perry.sqlite`, the workspace,
the skills folder and career-ops' checkout. Recreating the container does not
touch it. The image is Debian rather than Alpine because career-ops renders CV
PDFs with Playwright's Chromium, which is built against glibc; Chromium is baked
in at the version career-ops pins and `PLAYWRIGHT_BROWSERS_PATH` points at it.

## career-ops

career-ops is a checkout in Perry's workspace, not an installed tool. Perry's
`career-ops` skill points at it and the `/career` command names that skill:

```bash
docker exec perry sh -lc '
  cd /data/.perry/workspace &&
  git clone --depth 1 https://github.com/career-ops-hq/career-ops.git'

docker exec -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright perry sh -lc '
    cd /data/.perry/workspace/career-ops && npm install --no-audit --no-fund'

docker exec -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright perry sh -lc '
  cd /data/.perry/workspace/career-ops && node doctor.mjs'
```

`doctor.mjs` should report Node, dependencies and Playwright chromium as fine.
It will still ask for `cv.md`, `config/profile.yml`, `modes/_profile.md` and
`portals.yml`: those are the owner's own material, and Perry asks for them in
the chat on the first `/career` turn.

In Telegram:

```text
/career                 the mode menu
/career https://…       evaluate that job posting
/career tracker         application status
```

`/career <anything>` rewrites the message to `$career-ops <anything>` before it
reaches the model, so the skill loads and career-ops' own router decides the
mode.

## Networking

Inbound `22` and `7377` are open in `perry-vmNSG`. Telegram is outbound only,
so the bot does not need either; `7377` is the dashboard and should be narrowed
to the owner's address when it is stable:

```bash
az network nsg rule update -g perry-rg --nsg-name perry-vmNSG \
  -n open-port-7377 --source-address-prefixes <your-ip>/32
```

## Costs

Deallocate when not in use. The controller takes over Telegram, and `/start-vm`
brings the VM back in about a minute. A deallocated VM bills only for the disk.

```bash
az vm deallocate -g perry-rg -n perry-vm      # same as /stop-vm
az vm start -g perry-rg -n perry-vm           # same as /start-vm
```
