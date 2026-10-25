#!/usr/bin/env python3
"""Stop the VM after it has been idle, so compute is paid only while it is used.

Runs from a systemd timer on the VM. It asks Perry's own admin API (the same
one the dashboard uses) for a running turn, the last message and the next
schedule, and only then asks the controller to deallocate. The controller
installs the Telegram webhook before it answers, so the next message wakes the
VM again. Disk, IP address and the controller keep costing a few dollars a
month; the VM itself does not.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.request
from datetime import datetime

IDLE_SECONDS = int(os.environ.get("PERRY_IDLE_MINUTES", "30")) * 60
MIN_UPTIME_SECONDS = int(os.environ.get("PERRY_MIN_UPTIME_MINUTES", "10")) * 60
JOB_GUARD_SECONDS = int(os.environ.get("PERRY_JOB_GUARD_MINUTES", "5")) * 60
ADMIN_URL = os.environ.get("PERRY_ADMIN_URL", f"http://127.0.0.1:{os.environ.get('PERRY_PORT', '7377')}").rstrip("/")
CONTROL_URL = os.environ["PERRY_VM_CONTROL_URL"].rstrip("/")
DRY_RUN = os.environ.get("PERRY_AUTO_OFF_DRY_RUN", "").strip().lower() in ("1", "true", "yes")
NEVER = 8.64e15


def setting(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing setting: {name}")
    return value


def admin(path: str, args: dict | None = None):
    """Call one of Perry's internal functions, with the dashboard key."""
    request = urllib.request.Request(
        f"{ADMIN_URL}/api/backend/admin",
        data=json.dumps({"path": path, "args": args or {}}).encode(),
        headers={"content-type": "application/json", "x-perry-key": setting("DASHBOARD_KEY")},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        body = json.loads(response.read())
    if body.get("error"):
        raise RuntimeError(str(body["error"]))
    return body.get("value")


def output(*command: str) -> str:
    result = subprocess.run(command, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"{command[0]} failed")
    return result.stdout.strip()


def busy_reason() -> str:
    """A build or an SSH session: never stop under the owner's hands."""
    if output("who"):
        return "an SSH session is open"
    for pattern in ("docker build", "midnight-build"):
        found = subprocess.run(["pgrep", "-f", pattern], capture_output=True, timeout=10)
        if found.returncode == 0:
            return "an image build is running"
    return ""


def uptime_seconds() -> float:
    with open("/proc/uptime", encoding="utf-8") as file:
        return float(file.read().split()[0])


def parse_started(text: str) -> float:
    """Docker's RFC3339 timestamp, whose fraction may have nine digits."""
    value = text.strip().replace("Z", "+00:00")
    head, dot, tail = value.partition(".")
    if dot:
        fraction, plus, zone = tail.partition("+")
        value = f"{head}.{fraction[:6]}{plus}{zone}"
    return datetime.fromisoformat(value).timestamp()


def container_started() -> tuple[float, bool]:
    """When the Perry container started, and whether it is running."""
    started = output("docker", "inspect", "-f", "{{.State.StartedAt}}", "perry")
    running = output("docker", "inspect", "-f", "{{.State.Running}}", "perry") == "true"
    return parse_started(started), running


def last_activity(conversations: list[dict], started: float) -> float:
    """The newest message in any chat, never older than the container itself.

    Stored times are milliseconds (JavaScript's `Date.now`); seconds are used
    here so they compare with `/proc/uptime` and `time.time()`.
    """
    times = [started]
    for chat in conversations:
        at = chat.get("lastMessageAt")
        if isinstance(at, (int, float)):
            times.append(float(at) / 1000)
    return max(times)


def soonest_job(jobs: list[dict], now: float) -> float | None:
    """The next run a schedule has planned, or a waiting run that is due."""
    times: list[float] = []
    for job in jobs:
        if not job.get("enabled"):
            continue
        at = job.get("nextRunAt")
        if isinstance(at, (int, float)) and at < NEVER:
            times.append(float(at) / 1000)
        until = (job.get("waiting") or {}).get("until")
        if isinstance(until, (int, float)) and now * 1000 < until < NEVER:
            times.append(float(until) / 1000)
    return min(times) if times else None


def decide(
    now: float,
    uptime: float,
    last_message: float,
    next_job: float | None,
    running: bool,
    busy: str,
    paused: bool,
) -> tuple[bool, str]:
    """Whether to stop now, and a line for the journal either way."""
    if busy:
        return False, f"staying up: {busy}"
    if running:
        return False, "staying up: a turn is running"
    if uptime < MIN_UPTIME_SECONDS:
        return False, f"staying up: only {int(uptime // 60)} min since boot"
    idle = now - last_message
    if idle < IDLE_SECONDS:
        return False, f"staying up: last message {int(idle // 60)} min ago"
    if not paused and next_job is not None and next_job <= now + JOB_GUARD_SECONDS:
        wait = int((next_job - now) // 60)
        return False, f"staying up: a scheduled run is due in {wait} min"
    return True, f"idle for {int(idle // 60)} min"


def stop(reason: str) -> None:
    print(f"asking the controller to stop the VM: {reason}", flush=True)
    request = urllib.request.Request(
        f"{CONTROL_URL}/api/control",
        data=json.dumps({"action": "stop", "wait": True}).encode(),
        headers={"content-type": "application/json", "x-perry-control-key": setting("PERRY_VM_CONTROL_KEY")},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=240) as response:
            answer = json.loads(response.read())
        if not answer.get("ok"):
            print(f"the controller did not stop the VM: {answer}", flush=True)
    except Exception as error:
        # Deallocation cuts the VM's own network first, so a dropped answer is
        # the normal path. A stop that never started is retried by the timer.
        print(f"stop asked; the VM is going down ({error})", flush=True)


def main() -> None:
    busy = busy_reason()
    if busy:
        print(f"staying up: {busy}", flush=True)
        return
    try:
        started, container_running = container_started()
    except Exception as error:
        print(f"staying up: cannot read the container ({error})", flush=True)
        return
    if not container_running:
        print("staying up: the Perry container is not running", flush=True)
        return
    try:
        runs = admin("runs:recent", {"limit": 5}) or []
        conversations = admin("conversations:list", {}) or []
        jobs = admin("jobs:list", {}) or []
        paused = bool(admin("pause:state", {}))
    except Exception as error:
        print(f"staying up: the admin route did not answer ({error})", flush=True)
        return
    now = time.time()
    running = any(run.get("status") == "running" for run in runs)
    should_stop, reason = decide(
        now=now,
        uptime=uptime_seconds(),
        last_message=last_activity(conversations, started),
        next_job=soonest_job(jobs, now),
        running=running,
        busy="",
        paused=paused,
    )
    print(reason, flush=True)
    if should_stop and DRY_RUN:
        print("dry run: would ask the controller to stop the VM", flush=True)
    elif should_stop:
        stop(reason)


if __name__ == "__main__":
    main()
