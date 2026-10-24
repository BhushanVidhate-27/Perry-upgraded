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
