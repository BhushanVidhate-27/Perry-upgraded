#!/usr/bin/env python3
"""A self-check for auto_off.py: no Docker, no network, no Azure.

Run it after any change to auto_off.py: `python3 check_auto_off.py`. It pins
the decisions that cost money: never stop during a turn, under an SSH session,
before the minimum uptime, or just before a scheduled run.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone

os.environ.update(
    {
        "PERRY_VM_CONTROL_URL": "https://perry.test",
        "PERRY_VM_CONTROL_KEY": "control-key",
        "DASHBOARD_KEY": "dashboard-key",
        "PERRY_IDLE_MINUTES": "30",
        "PERRY_MIN_UPTIME_MINUTES": "10",
        "PERRY_JOB_GUARD_MINUTES": "5",
    }
)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import auto_off  # noqa: E402

NOW = 1_800_000_000.0
MINUTE = 60


def decide(**changes):
    base = dict(
        now=NOW,
        uptime=60 * MINUTE,
        last_message=NOW - 31 * MINUTE,
        next_job=None,
        running=False,
        busy="",
        paused=False,
    )
    base.update(changes)
    return auto_off.decide(**base)


def main() -> None:
    assert decide()[0] is True, decide()
    assert decide(last_message=NOW - 29 * MINUTE)[0] is False
    assert decide(running=True)[0] is False
    assert decide(busy="an SSH session is open")[0] is False
    assert decide(uptime=9 * MINUTE)[0] is False
    assert decide(uptime=10 * MINUTE)[0] is True
    # A run due inside the guard keeps the VM up; one further out does not.
    assert decide(next_job=NOW + 4 * MINUTE)[0] is False
    assert decide(next_job=NOW + 6 * MINUTE)[0] is True
    # An overdue run is about to start, so it keeps the VM up too.
    assert decide(next_job=NOW - MINUTE)[0] is False
    # Paused, nothing is about to run, whatever the clocks say.
    assert decide(next_job=NOW + MINUTE, paused=True)[0] is True

    # Docker's timestamp has a nine-digit fraction and a Z.
    stamp = auto_off.parse_started("2026-10-25T14:00:00.123456789Z")
    assert abs(stamp - datetime(2026, 10, 25, 14, 0, tzinfo=timezone.utc).timestamp()) < 1, stamp

    # Only a real next time counts; an event job's NEVER does not. Stored
    # times are milliseconds, as the backend sends them.
    jobs = [
        {"enabled": True, "nextRunAt": (NOW + 60 * MINUTE) * 1000},
        {"enabled": False, "nextRunAt": (NOW + MINUTE) * 1000},
        {"enabled": True, "nextRunAt": auto_off.NEVER},
        {"enabled": True, "nextRunAt": (NOW + 120 * MINUTE) * 1000, "waiting": {"until": (NOW + 10 * MINUTE) * 1000}},
        {"enabled": True, "nextRunAt": (NOW + 120 * MINUTE) * 1000, "waiting": {"until": (NOW - MINUTE) * 1000}},
    ]
    assert auto_off.soonest_job(jobs, NOW) == NOW + 10 * MINUTE, auto_off.soonest_job(jobs, NOW)
    assert auto_off.soonest_job([], NOW) is None

    # A chat's last message, but never before the container started; a message
    # stored in milliseconds becomes seconds.
    assert auto_off.last_activity([{"lastMessageAt": (NOW - MINUTE) * 1000}], NOW - 10 * MINUTE) == NOW - MINUTE
    assert auto_off.last_activity([], NOW - 10 * MINUTE) == NOW - 10 * MINUTE

    print("ok: auto-off checks passed")


if __name__ == "__main__":
    main()
