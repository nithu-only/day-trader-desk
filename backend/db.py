"""SQLite storage for Day Trader Desk."""

import json
import sqlite3
from datetime import datetime, timezone

from config import DB_PATH, DEFAULT_CONFIG


def get_conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_conn()
    c = conn.cursor()

    c.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS watchlist (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT NOT NULL UNIQUE,
            name TEXT,
            added_at TEXT NOT NULL
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS plans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT NOT NULL,
            setup TEXT,
            entry REAL,
            stop REAL,
            target REAL,
            risk_per_share REAL,
            reward_risk REAL,
            date TEXT,
            status TEXT DEFAULT 'pending',
            plan_json TEXT,
            created_at TEXT NOT NULL
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS simulations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            plan_id INTEGER,
            symbol TEXT NOT NULL,
            target_first_pct REAL,
            stop_first_pct REAL,
            neither_pct REAL,
            verdict TEXT,
            sim_json TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (plan_id) REFERENCES plans(id)
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS scans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mode TEXT NOT NULL,
            as_of TEXT,
            hits_json TEXT,
            counts_json TEXT,
            created_at TEXT NOT NULL
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_id TEXT NOT NULL UNIQUE,
            symbol TEXT,
            rule_type TEXT,
            price REAL,
            pct REAL,
            direction TEXT,
            at_time TEXT,
            date TEXT,
            rearm INTEGER DEFAULT 0,
            armed INTEGER DEFAULT 1,
            created_at TEXT NOT NULL
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS news_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticker TEXT NOT NULL,
            items_json TEXT,
            fetched_at TEXT NOT NULL
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            symbol TEXT,
            details_json TEXT,
            created_at TEXT NOT NULL
        )
    """)

    # Seed default settings
    for key, value in DEFAULT_CONFIG.items():
        c.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
            (key, json.dumps(value)),
        )

    conn.commit()
    conn.close()


def _defaults():
    return dict(DEFAULT_CONFIG)


def coerce_setting(key: str, value):
    """Turn a form/JSON value into the type the default for `key` uses."""
    if key not in DEFAULT_CONFIG:
        raise KeyError(key)
    default = DEFAULT_CONFIG[key]
    if isinstance(default, bool):
        if isinstance(value, str):
            return value.strip().lower() in ("1", "true", "yes", "on")
        return bool(value)
    if isinstance(default, (int, float)):
        if isinstance(value, bool):
            raise ValueError(f"{key} must be a number")
        try:
            number = float(value)
        except (TypeError, ValueError):
            raise ValueError(f"{key} must be a number") from None
        return int(number) if isinstance(default, int) else number
    if isinstance(default, list):
        if isinstance(value, str):
            return [part.strip() for part in value.split(",") if part.strip()]
        if isinstance(value, (list, tuple)):
            return [str(part).strip() for part in value if str(part).strip()]
        raise ValueError(f"{key} must be a list")
    # strings
    if value is None:
        return ""
    return str(value)


def get_setting(key: str):
    conn = get_conn()
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    conn.close()
    if row is None:
        return None
    try:
        return json.loads(row["value"])
    except (json.JSONDecodeError, TypeError):
        return row["value"]


def get_all_settings() -> dict:
    conn = get_conn()
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    conn.close()
    out = {}
    for row in rows:
        try:
            out[row["key"]] = json.loads(row["value"])
        except (json.JSONDecodeError, TypeError):
            out[row["key"]] = row["value"]
    return out


def set_setting(key: str, value):
    conn = get_conn()
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, json.dumps(value)),
    )
    conn.commit()
    conn.close()


def add_watchlist(symbol: str, name: str = None):
    conn = get_conn()
    conn.execute(
        "INSERT OR IGNORE INTO watchlist (symbol, name, added_at) VALUES (?, ?, ?)",
        (symbol.upper(), name or "", _now()),
    )
    conn.commit()
    conn.close()


def remove_watchlist(symbol: str):
    conn = get_conn()
    conn.execute("DELETE FROM watchlist WHERE symbol = ?", (symbol.upper(),))
    conn.commit()
    conn.close()


def get_watchlist():
    conn = get_conn()
    rows = conn.execute("SELECT symbol, name, added_at FROM watchlist ORDER BY added_at DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def save_plan(symbol, setup, entry, stop, target, risk, rr, date, plan_json):
    conn = get_conn()
    cur = conn.execute(
        "INSERT INTO plans (symbol, setup, entry, stop, target, risk_per_share, reward_risk, date, plan_json, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (symbol, setup, entry, stop, target, risk, rr, date, plan_json, _now()),
    )
    plan_id = cur.lastrowid
    conn.commit()
    conn.close()
    return plan_id


def get_plans():
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM plans ORDER BY created_at DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def latest_plan(symbol: str | None = None):
    conn = get_conn()
    if symbol:
        row = conn.execute(
            "SELECT * FROM plans WHERE symbol = ? ORDER BY created_at DESC LIMIT 1",
            (symbol.upper(),),
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT * FROM plans ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
    conn.close()
    return dict(row) if row else None


def save_simulation(plan_id, symbol, target_first, stop_first, neither, verdict, sim_json):
    conn = get_conn()
    conn.execute(
        "INSERT INTO simulations (plan_id, symbol, target_first_pct, stop_first_pct, neither_pct, verdict, sim_json, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (plan_id, symbol, target_first, stop_first, neither, verdict, sim_json, _now()),
    )
    conn.commit()
    conn.close()


def get_simulations():
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM simulations ORDER BY created_at DESC LIMIT 50"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def save_scan(mode, as_of, hits, counts):
    conn = get_conn()
    conn.execute(
        "INSERT INTO scans (mode, as_of, hits_json, counts_json, created_at) VALUES (?, ?, ?, ?, ?)",
        (mode, as_of, json.dumps(hits), json.dumps(counts), _now()),
    )
    conn.commit()
    conn.close()


def get_scans(limit: int = 10):
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM scans ORDER BY created_at DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    out = []
    for row in rows:
        item = dict(row)
        for src, dst in (("hits_json", "hits"), ("counts_json", "counts")):
            try:
                item[dst] = json.loads(item.pop(src) or "null")
            except (json.JSONDecodeError, TypeError):
                item[dst] = None
        out.append(item)
    return out


def save_alert(rule_id, symbol, rule_type, price=None, pct=None, direction=None,
               at_time=None, date=None, rearm=0):
    conn = get_conn()
    conn.execute(
        "INSERT OR REPLACE INTO alerts (rule_id, symbol, rule_type, price, pct, direction, at_time, date, rearm, armed, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
        (rule_id, symbol, rule_type, price, pct, direction, at_time, date, rearm, _now()),
    )
    conn.commit()
    conn.close()


def delete_alert(rule_id: str) -> bool:
    conn = get_conn()
    cur = conn.execute("DELETE FROM alerts WHERE rule_id = ?", (rule_id,))
    deleted = cur.rowcount > 0
    conn.commit()
    conn.close()
    return deleted


def get_alerts():
    conn = get_conn()
    rows = conn.execute("SELECT * FROM alerts ORDER BY created_at DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def add_history(action, symbol=None, details=None):
    conn = get_conn()
    conn.execute(
        "INSERT INTO history (action, symbol, details_json, created_at) VALUES (?, ?, ?, ?)",
        (action, symbol, json.dumps(details) if details else None, _now()),
    )
    conn.commit()
    conn.close()


def _now():
    return datetime.now(timezone.utc).isoformat()
