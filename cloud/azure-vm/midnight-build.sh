#!/bin/bash
# One-shot midnight build: origin/main -> perry:new -> container swap -> menu.
#
# Installed as root's cron entry (see README). Takes its own entry out first,
# so it runs once: a failure is reported in Telegram and the old container is
# put back, rather than retried silently every night.
set -uo pipefail

LOG=/home/azureuser/midnight-build.log
exec >> "$LOG" 2>&1
echo "=== build start $(date -u)"

crontab -l 2>/dev/null | grep -v 'midnight-build.sh' | crontab - || true

ENV=/home/azureuser/perry.env
TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV" | cut -d= -f2-)
OWNER=5037527378
notify() {
  [ -n "${TOKEN:-}" ] || return 0
  curl -s -m 20 "https://api.telegram.org/bot$TOKEN/sendMessage" \
    -d "chat_id=$OWNER" --data-urlencode "text=$1" >/dev/null || true
}

cd /home/azureuser/perry-app || { notify "Midnight build: the repo folder is missing."; exit 1; }
su - azureuser -c "cd /home/azureuser/perry-app && git fetch -q origin && git reset --hard -q origin/main" \
  || { notify "Midnight build: git reset failed; the running Perry is untouched."; exit 1; }
echo "on $(git -C /home/azureuser/perry-app log --oneline -1)"

docker build -t perry:new . \
  || { notify "Midnight build failed at the image build; the running Perry is untouched."; exit 1; }

# Keep the old container until the new one answers.
docker stop perry && docker rename perry perry-old \
  || { notify "Midnight build: could not stop the old container."; exit 1; }
docker run -d --name perry --restart unless-stopped -p 7377:7377 \
  --env-file "$ENV" -v /data/.perry:/data/.perry --log-opt max-size=10m perry:new >/dev/null
up=0
for _ in $(seq 1 24); do
  sleep 5
  if curl -sf -o /dev/null http://127.0.0.1:7377/api/backend/http/health; then up=1; break; fi
done
if [ "$up" != 1 ]; then
  docker rm -f perry >/dev/null 2>&1
  docker rename perry-old perry && docker start perry >/dev/null
  notify "Midnight build: the new container did not come up; the old one is running again."
  exit 1
fi
docker rm -f perry-old >/dev/null 2>&1

python3 - "$TOKEN" <<'PY' || notify "Perry is up, but publishing the command menu failed."
import json, sys, urllib.request
sys.path.insert(0, "/home/azureuser/perry-app/cloud/azure-vm-controller")
import app
body = json.dumps({"commands": [{"command": n, "description": d} for n, d in app.COMMANDS]}).encode()
req = urllib.request.Request(
    f"https://api.telegram.org/bot{sys.argv[1]}/setMyCommands",
    data=body, headers={"content-type": "application/json"},
)
print("menu published:", json.load(urllib.request.urlopen(req, timeout=30)).get("ok"))
PY

notify "Perry rebuilt at midnight and is up on $(git -C /home/azureuser/perry-app rev-parse --short HEAD)."
echo "=== done $(date -u)"
