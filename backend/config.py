"""Day Trader Desk - configuration and environment defaults."""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
VENDOR_DIR = BASE_DIR / "vendor" / "day-trader-skill"
DATA_DIR = BASE_DIR / "data"
TRADER_DIR = DATA_DIR / "trader"
DB_PATH = DATA_DIR / "desk.db"
ENV_FILE = BASE_DIR / ".env"
ENV_EXAMPLE = BASE_DIR / ".env.example"

DEMO_FIXTURES = VENDOR_DIR / "tests" / "fixtures"

# One dataset per demo tool: the upstream fixtures for a folder contain several
# unrelated downloads, and the tools would otherwise mix them together.
DEMO_DATA = {
    "scanner_daily": DEMO_FIXTURES / "trader-scanner" / "daily-spark-2026-10-19.json",
    "scanner_orb": DEMO_FIXTURES / "trader-scanner" / "wall5m-2026-10-19.json.gz",
    "news": DEMO_FIXTURES / "trader-news",
    "entry": DEMO_FIXTURES / "trader-entry",
    "timemachine": DEMO_FIXTURES / "trader-timemachine",
    "alerts": DEMO_FIXTURES / "trader-alerts",
    "facts": DEMO_FIXTURES / "trader-analyst",
    "pelosi": DEMO_FIXTURES / "trader-pelosi" / "2026FD.zip",
}

# Pinned wall-clock time for demo mode. Everything that takes --now gets this
# as New York time; news.py is the exception and is given UTC (see wrappers).
DEMO_NOW = "2026-10-19 10:15"
DEMO_NOW_UTC = "2026-10-19T14:15:00Z"

DEFAULT_CONFIG = {
    "mode": "demo",
    "budget": 5000.0,
    "cash_buffer_pct": 10,
    "max_position_pct": 75,
    "max_order_usd": 4000,
    "min_order_usd": 5,
    "max_loss_per_trade_usd": 50,
    "max_daily_loss_usd": 150,
    "max_trades_per_day": 3,
    "max_orders_per_day": 10,
    "min_reward_risk": 1.0,
    "require_stop": True,
    "no_entries_before": "09:45",
    "no_entries_after": "15:30",
    "flat_by": "15:55",
    "fractional": False,
    "blocked": [],
    "allow_options": False,
    "allow_margin": False,
    "allow_short": False,
    "pdt_guard": False,
    "sec_user_agent": "",
    "cache_ttl_seconds": 60,
}

# The subset the vendor CLIs read from trader/config.json.
VENDOR_CONFIG_KEYS = [
    "budget", "cash_buffer_pct", "max_position_pct", "max_order_usd",
    "min_order_usd", "max_loss_per_trade_usd", "max_daily_loss_usd",
    "max_trades_per_day", "max_orders_per_day", "min_reward_risk",
    "require_stop", "no_entries_before", "no_entries_after", "flat_by",
    "fractional", "blocked", "allow_options", "allow_margin", "allow_short",
    "pdt_guard", "sec_user_agent",
]


def get_env(key, default=None):
    return os.environ.get(key, default)


def env_mode() -> str | None:
    """The mode forced by DESK_MODE, or None when it is not set."""
    raw = (os.environ.get("DESK_MODE") or "").strip().lower()
    return raw if raw in ("demo", "live") else None


def mode() -> str:
    """Effective mode: DESK_MODE wins, otherwise the saved setting."""
    forced = env_mode()
    if forced:
        return forced
    try:
        from db import get_setting

        stored = str(get_setting("mode") or "").strip().lower()
    except Exception:  # noqa: BLE001 - settings are not available this early
        stored = ""
    return stored if stored in ("demo", "live") else "demo"


def is_demo() -> bool:
    return mode() == "demo"


def now_iso():
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()
