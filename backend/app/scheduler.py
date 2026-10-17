"""Background worker (separate container): scheduled email reports, status checks, daily config snapshots.

Runs even when nobody has the dashboard open. A PostgreSQL advisory lock guarantees only one
scheduler acts at a time, so running extra copies never sends duplicate emails.
"""

import logging
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import text

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s scheduler %(message)s")
log = logging.getLogger("tagid.scheduler")
LOCK_ID = 7240099


def tick() -> None:
    from . import backup, health, reports
    from .config import get_settings
    from .db import SessionLocal, engine

    s = get_settings()
    label = s.server_label or s.public_url or "TagID"
    # Session-level advisory lock held on one dedicated connection for the whole tick
    with engine.connect() as lock_conn:
        if not lock_conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": LOCK_ID}).scalar():
            return
        try:
            with SessionLocal() as db:
                now = datetime.now(timezone.utc)
                # 1. scheduled email report
                cfg, _ = reports.load(db, reports.EMAIL_KEY, reports.DEFAULT_EMAIL)
                slot = reports.due_slot(cfg, now)
                if slot:
                    run = reports.send_report(db, "scheduled", "scheduler", s.app_name, label)
                    cfg = {**cfg, "last_slot": slot.isoformat()}
                    if run.status == "sent":
                        cfg["last_sent_at"] = now.isoformat()
                    reports.save(db, reports.EMAIL_KEY, cfg)
                    db.commit()
                    log.info("Scheduled report %s: %s", run.status, run.detail)

                # 2. status checks
                mon, _ = reports.load(db, reports.MONITOR_KEY, reports.DEFAULT_MONITOR)
                last = datetime.fromisoformat(mon["last_check_at"]) if mon.get("last_check_at") else None
                if mon.get("enabled") and (last is None or now - last >= timedelta(minutes=int(mon["interval_minutes"]))):
                    res = health.run_checks(db)
                    mon["last_check_at"] = now.isoformat()
                    reports.save(db, reports.MONITOR_KEY, mon)
                    db.commit()
                    log.info("Status checks done: %s", res)

                # 3. daily configuration snapshot
                local = now.astimezone(ZoneInfo(s.tz or "Asia/Kolkata"))
                if local.hour >= int(mon.get("snapshot_hour", 2)) and mon.get("last_snapshot_date") != local.date().isoformat():
                    backup.take_snapshot(db, "scheduled", "scheduler")
                    mon["last_snapshot_date"] = local.date().isoformat()
                    reports.save(db, reports.MONITOR_KEY, mon)
                    db.commit()
                    log.info("Daily configuration snapshot saved")
        finally:
            lock_conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": LOCK_ID})
            lock_conn.commit()


def main() -> None:
    log.info("Scheduler started")
    while True:
        try:
            tick()
        except Exception as e:  # noqa: BLE001 — keep running (DB down, config not ready yet, …)
            log.warning("Tick failed: %s: %s", type(e).__name__, str(e).splitlines()[0][:200] if str(e) else "")
        time.sleep(30)


if __name__ == "__main__":
    main()
