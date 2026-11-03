"""Subprocess wrappers for the day-trader-skill CLI tools.

Each tool runs as: <python> -I <script> <subcommand> [flags] [--json]
with cwd set to data/trader so the tools' trader/ files land there.
"""

import json
import os
import re
import sys
from pathlib import Path

from config import (
    BASE_DIR, DATA_DIR, DEMO_DATA, DEMO_NOW, DEMO_NOW_UTC,
    TRADER_DIR, VENDOR_CONFIG_KEYS, VENDOR_DIR, is_demo,
)
from db import get_all_settings

TOOLS = {
    "scanner": VENDOR_DIR / "trader-scanner" / "scan.py",
    "news": VENDOR_DIR / "trader-news" / "news.py",
    "entry": VENDOR_DIR / "trader-entry" / "entry.py",
    "exit": VENDOR_DIR / "trader-exit" / "exit.py",
    "timemachine": VENDOR_DIR / "trader-timemachine" / "timemachine.py",
    "size": VENDOR_DIR / "trader-budget" / "size.py",
    "risk": VENDOR_DIR / "trader-risk" / "check.py",
    "alerts": VENDOR_DIR / "trader-alerts" / "alerts.py",
    "facts": VENDOR_DIR / "trader-analyst" / "facts.py",
    "pelosi": VENDOR_DIR / "trader-pelosi" / "ptr.py",
}

CONFIG_PATH = TRADER_DIR / "config.json"
PLAN_PATH = TRADER_DIR / "plan.json"
ORDERS_PATH = TRADER_DIR / "orders.json"
RULES_PATH = TRADER_DIR / "alerts.json"
ALERT_STATE_PATH = TRADER_DIR / "state" / "alerts.json"

SYMBOL_RE = re.compile(r"^[A-Z][A-Z0-9]{0,5}([.\-][A-Z]{1,2})?$")

_FIXTURE_WORDS = {
    "yahoo", "stooq", "chart", "spark", "daily", "wall", "symdir", "company",
    "companyfacts", "submissions", "ptr", "plan", "demo", "berkshire", "nasdaq",
    "other", "listed", "live", "synthetic",
}


class ToolError(RuntimeError):
    """A vendor tool failed with a message meant for the user."""


# ---------------------------------------------------------------- plumbing

def clean_message(text: str) -> str:
    """Strip machine paths and newlines out of a tool's error text."""
    if not text:
        return ""
    text = str(text).strip()
    for base in {str(BASE_DIR), str(BASE_DIR).replace("\\", "/"), str(VENDOR_DIR)}:
        text = text.replace(base, "")
        text = text.replace(base.replace("\\", "/"), "")
    text = text.replace(str(Path.home()), "~")
    # The first line is the actual error; the rest is usually an argparse dump.
    first = text.splitlines()[0] if text.splitlines() else ""
    first = re.sub(r"^[\s:\\/]+", "", first)
    first = re.sub(r"exit \d+:\s*(\w+\.py:)?\s*", "", first)
    return " ".join(first.split())


def _run(tool_key: str, args: list[str], add_json: bool = True) -> dict:
    """Run a vendor tool, optionally with --json, return parsed JSON."""
    script = TOOLS[tool_key]
    cmd = [sys.executable, "-I", str(script)] + args
    if add_json:
        cmd += ["--json"]

    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    if is_demo():
        env["SEC_USER_AGENT"] = "Desk Demo demo@example.com"
    else:
        settings = get_all_settings()
        agent = (settings.get("sec_user_agent") or "").strip()
        if agent:
            env["SEC_USER_AGENT"] = agent

    TRADER_DIR.mkdir(parents=True, exist_ok=True)
    try:
        proc = _spawn(cmd, env)
    except FileNotFoundError as exc:
        raise ToolError(f"{tool_key}: the Python interpreter could not be started") from exc

    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()

    if proc.returncode != 0:
        if out:
            try:
                return json.loads(out)
            except json.JSONDecodeError:
                pass
        raise ToolError(clean_message(err or out) or f"{tool_key} failed")

    if add_json:
        try:
            return json.loads(out)
        except json.JSONDecodeError as exc:
            raise ToolError(
                f"{tool_key} returned something that was not JSON"
            ) from exc

    return {"output": out, "exit_code": proc.returncode}


def _spawn(cmd, env):
    import subprocess

    try:
        return subprocess.run(
            cmd, cwd=str(DATA_DIR), capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=240, env=env,
        )
    except subprocess.TimeoutExpired as exc:
        raise ToolError("the tool took longer than four minutes and was stopped") from exc


def _demo_now() -> list[str]:
    return ["--now", DEMO_NOW]


# ---------------------------------------------------------------- config file

def write_vendor_config() -> Path:
    """Materialise data/trader/config.json from the saved desk settings."""
    settings = get_all_settings()
    doc = {}
    for key in VENDOR_CONFIG_KEYS:
        if key in settings:
            doc[key] = settings[key]
    doc.setdefault("budget", 5000)
    TRADER_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    return CONFIG_PATH


# ---------------------------------------------------------------- symbols

def normalise_symbol(value) -> str:
    return str(value or "").strip().upper()


def check_symbol(value) -> str:
    """Validate a ticker shape; raise ToolError with a readable message."""
    symbol = normalise_symbol(value)
    if not symbol:
        raise ToolError("Enter a ticker symbol, for example TSLA.")
    if not SYMBOL_RE.match(symbol):
        raise ToolError(f'"{symbol}" is not a valid ticker symbol. Use letters only, for example TSLA.')
    return symbol


def _fixture_tickers(directory: Path) -> set[str]:
    """Tickers that actually have a fixture file (TSLA.json, yahoo-AAPL.xml...)."""
    found = set()
    if not directory.is_dir():
        return found
    for path in directory.iterdir():
        if not path.is_file():
            continue
        stem = path.name.split(".")[0]
        tokens = [tok for tok in re.split(r"[-_]", stem) if tok]
        if not tokens or tokens[0].lower() == "sec":
            continue
        for token in tokens:
            upper = token.upper()
            if upper.lower() in _FIXTURE_WORDS:
                continue
            if SYMBOL_RE.match(upper):
                found.add(upper)
    return found


def demo_tickers(tool_key: str) -> set[str]:
    directory = DEMO_DATA.get(tool_key)
    return _fixture_tickers(directory) if isinstance(directory, Path) else set()


def require_demo_data(tool_key: str, symbol: str):
    """In demo mode only a handful of tickers have fixtures; say so clearly."""
    if not is_demo():
        return
    available = demo_tickers(tool_key)
    if available and symbol not in available:
        sample = ", ".join(sorted(available)[:6])
        raise ToolError(
            f'No demo data for "{symbol}". Demo mode only has {sample}. '
            f"Switch to live mode for any other ticker."
        )


# ---------------------------------------------------------------- scanner

def scanner_daily(symbols: list[str] | None = None, limit: int | None = None) -> dict:
    args = ["daily", "--min-price", "0"]
    if is_demo():
        args += ["--offline", str(DEMO_DATA["scanner_daily"])] + _demo_now()
    if symbols:
        args += ["--symbols", ",".join(symbols)]
    if limit:
        args += ["--limit", str(limit)]
    return _run("scanner", args)


def scanner_orb(symbols: list[str] | None = None, at: str | None = None) -> dict:
    args = ["orb", "--or-minutes", "15", "--min-price", "0", "--max-confirm", "0"]
    if is_demo():
        args += ["--offline", str(DEMO_DATA["scanner_orb"])] + _demo_now() + ["--at", at or "10:15"]
    elif at:
        args += ["--at", at]
    if symbols:
        args += ["--symbols", ",".join(symbols)]
    return _run("scanner", args)


# ---------------------------------------------------------------- news

def news_check(tickers: list[str] | None = None, hours: int = 48) -> dict:
    args = ["--hours", str(hours), "--all"]
    if is_demo():
        # news.py reads --now as UTC (every other tool reads it as New York).
        args += ["--offline", str(DEMO_DATA["news"]), "--no-sec", "--now", DEMO_NOW_UTC]
    if tickers:
        args += ["--tickers"] + tickers
    return _run("news", args)


# ---------------------------------------------------------------- entry

def entry_check(symbol: str) -> dict:
    args = ["check", symbol, "--setup", "orb", "--or-minutes", "15"]
    if is_demo():
        args += ["--offline", str(DEMO_DATA["entry"])] + _demo_now()
    return _run("entry", args)


# ---------------------------------------------------------------- exit

def exit_plan(symbol: str, entry: float, stop_rule: str = "or-mid",
              target: str = "2R", or_high: float | None = None,
              or_low: float | None = None) -> dict:
    args = ["plan", "--symbol", symbol, "--entry", str(entry),
            "--stop", stop_rule, "--target", target, "--write"]
    if or_high is not None:
        args += ["--or-high", str(or_high)]
    if or_low is not None:
        args += ["--or-low", str(or_low)]
    if is_demo():
        args += _demo_now()
    return _run("exit", args)


def exit_show() -> dict:
    args = ["show"]
    if is_demo():
        args += _demo_now()
    return _run("exit", args)


# ---------------------------------------------------------------- timemachine

def timemachine_run(symbol: str | None = None, entry: float | None = None,
                    stop: float | None = None, target: float | None = None,
                    entry_time: str | None = None) -> dict:
    args = ["run", "--replays", "10000", "--seed", "19", "--write"]
    if is_demo():
        args += ["--offline", str(DEMO_DATA["timemachine"])] + _demo_now()
    if symbol:
        args += ["--symbol", symbol]
    if entry is not None:
        args += ["--entry", str(entry)]
    if stop is not None:
        args += ["--stop", str(stop)]
    if target is not None:
        args += ["--target", str(target)]
    if entry_time:
        args += ["--entry-time", entry_time]
    return _run("timemachine", args)


def timemachine_chart() -> dict:
    # `chart` has no --json flag.
    args = ["chart"]
    if is_demo():
        args += ["--from", str(TRADER_DIR / "timemachine.json")]
    return _run("timemachine", args, add_json=False)


# ---------------------------------------------------------------- size / budget

def size_position() -> dict:
    write_vendor_config()
    args = ["--plan", str(PLAN_PATH), "--config", str(CONFIG_PATH), "--write"]
    if is_demo():
        args += _demo_now()
    return _run("size", args)


# ---------------------------------------------------------------- risk

def risk_check() -> dict:
    write_vendor_config()
    args = ["--orders", str(ORDERS_PATH), "--config", str(CONFIG_PATH)]
    if is_demo():
        args += _demo_now()
    return _run("risk", args)


# ---------------------------------------------------------------- alerts

def alerts_clock() -> dict:
    args = ["clock"] + _demo_now()
    return _run("alerts", args)


def alerts_quote(tickers: list[str]) -> dict:
    args = ["quote"] + tickers + ["--write"]
    if is_demo():
        args += ["--offline", str(DEMO_DATA["alerts"])] + _demo_now()
    return _run("alerts", args)


def alerts_add(rule_id: str, symbol: str | None = None, stop: float | None = None,
               target: float | None = None, pct: float | None = None,
               at: str | None = None, label: str | None = None,
               above: float | None = None, below: float | None = None) -> dict:
    # `add` does not accept --json or --now.
    args = ["add", "--id", rule_id]
    if symbol:
        args += ["--symbol", symbol]
    if above is not None:
        args += ["--above", str(above)]
    if below is not None:
        args += ["--below", str(below)]
    if stop is not None:
        args += ["--stop", str(stop)]
    if target is not None:
        args += ["--target", str(target)]
    if pct is not None:
        args += ["--pct", str(pct)]
    if at:
        args += ["--at", at]
    if label:
        args += ["--label", label]
    return _run("alerts", args, add_json=False)


def alerts_check() -> dict:
    args = ["check"]
    if is_demo():
        args += ["--offline", str(DEMO_DATA["alerts"])] + _demo_now()
    return _run("alerts", args)


def alerts_list() -> dict:
    # `list` has no --json flag; its output is "<id padded> {json}" per line.
    # It exits 1 with "No rules yet." when the rules file is empty.
    try:
        result = _run("alerts", ["list"], add_json=False)
        output = result.get("output", "")
    except ToolError as exc:
        if "no rules" in str(exc).lower():
            return {"rules": [], "output": ""}
        raise
    rules = []
    for line in output.splitlines():
        line = line.strip()
        if not line or line.lower().startswith("no rules"):
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        try:
            rule = json.loads(parts[1])
        except json.JSONDecodeError:
            continue
        rule.setdefault("id", parts[0])
        rules.append(rule)
    return {"rules": rules, "output": output}


def alerts_remove(rule_id: str) -> bool:
    """Delete a rule from trader/alerts.json (the tools have no delete verb)."""
    doc = _read_json(RULES_PATH, {"rules": []})
    rules = doc.get("rules") or []
    kept = [r for r in rules if str(r.get("id")) != rule_id]
    if len(kept) == len(rules):
        return False
    doc["rules"] = kept
    RULES_PATH.write_text(json.dumps(doc, indent=2), encoding="utf-8")

    state = _read_json(ALERT_STATE_PATH, {})
    if isinstance(state.get("rung"), dict):
        state["rung"].pop(rule_id, None)
        ALERT_STATE_PATH.write_text(json.dumps(state, indent=2), encoding="utf-8")
    return True


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


# ---------------------------------------------------------------- earnings

def facts(tickers: list[str]) -> dict:
    # `facts` takes positional tickers and has no --now.
    args = list(tickers)
    if is_demo():
        args += ["--offline", str(DEMO_DATA["facts"]),
                 "--user-agent", "Desk Demo demo@example.com"]
    return _run("facts", args)


# ---------------------------------------------------------------- congress

def pelosi_index(member: str | None = None, year: int | None = None,
                 since: str | None = None) -> dict:
    # ptr.py index uses --offline <FILE> (absolute path to the .zip)
    args = ["index"]
    if member:
        args += ["--member", member]
    if year:
        args += ["--year", str(year)]
    if since:
        args += ["--since", since]
    if is_demo():
        args += ["--offline", str(DEMO_DATA["pelosi"])]
    return _run("pelosi", args)
