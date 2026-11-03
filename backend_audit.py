import urllib.request, json

BASE = "http://127.0.0.1:8000/api"

def post(path, body=None):
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(f"{BASE}{path}", data=data, headers={"Content-Type": "application/json"})
    try:
        r = urllib.request.urlopen(req, timeout=60)
        return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode()
        except Exception:
            body = str(e)
        return e.code, body[:200]

def get(path):
    try:
        r = urllib.request.urlopen(f"{BASE}{path}", timeout=60)
        return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode()
        except Exception:
            body = str(e)
        return e.code, body[:200]

results = []

# 1. Health
s, r = get("/health")
results.append(("GET /api/health", s, str(r)[:120]))

# 2. Settings read
s, r = get("/settings")
results.append(("GET /api/settings", s, f"mode={r.get('mode')}, budget={r.get('budget')}"))

# 3. Settings update
body = {"key": "budget", "value": 6000.0}
req = urllib.request.Request(f"{BASE}/settings", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
try:
    r = urllib.request.urlopen(req, timeout=10)
    results.append(("POST /api/settings (update)", r.status, "budget->6000"))
except urllib.error.HTTPError as e:
    results.append(("POST /api/settings (update)", e.code, e.read().decode()[:120]))

# Restore
body = {"key": "budget", "value": 5000.0}
req = urllib.request.Request(f"{BASE}/settings", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
urllib.request.urlopen(req, timeout=10)

# 4. Scan daily
s, r = post("/scan/daily")
results.append(("POST /api/scan/daily", s, f"hits={len(r.get('hits',[]))}" if isinstance(r, dict) else str(r)[:120]))

# 5. Scan orb
s, r = post("/scan/orb")
results.append(("POST /api/scan/orb", s, f"hits={len(r.get('hits',[]))}" if isinstance(r, dict) else str(r)[:120]))

# 6. Watchlist add
req = urllib.request.Request(f"{BASE}/watchlist", data=json.dumps({"symbol": "TSLA"}).encode(), headers={"Content-Type": "application/json"})
try:
    r = urllib.request.urlopen(req, timeout=10)
    results.append(("POST /api/watchlist (add TSLA)", r.status, "added"))
except urllib.error.HTTPError as e:
    results.append(("POST /api/watchlist (add TSLA)", e.code, e.read().decode()[:120]))

# 7. Watchlist get
s, r = get("/watchlist")
results.append(("GET /api/watchlist", s, f"count={len(r) if isinstance(r, list) else 0}"))

# 8. News
s, r = post("/news")
results.append(("POST /api/news", s, f"items={len(r.get('items',[]))}" if isinstance(r, dict) else str(r)[:120]))

# 9. Entry check TSLA
req = urllib.request.Request(f"{BASE}/entry/check", data=json.dumps({"symbol": "TSLA"}).encode(), headers={"Content-Type": "application/json"})
try:
    r = urllib.request.urlopen(req, timeout=30)
    entry_data = json.loads(r.read().decode())
    results.append(("POST /api/entry/check (TSLA)", r.status, f"status={entry_data.get('status')}, price={entry_data.get('trigger',{}).get('price')}"))
except urllib.error.HTTPError as e:
    results.append(("POST /api/entry/check (TSLA)", e.code, e.read().decode()[:120]))
    entry_data = None

# 10. Exit plan
if entry_data and entry_data.get("trigger"):
    body = {
        "symbol": "TSLA",
        "entry": entry_data["trigger"]["price"],
        "stop_rule": "or-mid",
        "target": "1R",
        "or_high": entry_data.get("opening_range",{}).get("high"),
        "or_low": entry_data.get("opening_range",{}).get("low")
    }
    req = urllib.request.Request(f"{BASE}/exit/plan", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    try:
        r = urllib.request.urlopen(req, timeout=30)
        plan = json.loads(r.read().decode())
        results.append(("POST /api/exit/plan", r.status, f"stop={plan.get('stop')}, target={plan.get('target')}"))
        plan_data = plan
    except urllib.error.HTTPError as e:
        results.append(("POST /api/exit/plan", e.code, e.read().decode()[:120]))
        plan_data = None
else:
    results.append(("POST /api/exit/plan", "SKIP", "no entry data"))
    plan_data = None

# 11. Time machine run
if plan_data:
    body = {"symbol": "TSLA", "entry": plan_data.get("entry"), "stop": plan_data.get("stop"), "target": plan_data.get("target"), "entry_time": "10:15 AM"}
    req = urllib.request.Request(f"{BASE}/timemachine/run", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    try:
        r = urllib.request.urlopen(req, timeout=60)
        tm = json.loads(r.read().decode())
        mc = tm.get("mc", {})
        results.append(("POST /api/timemachine/run", r.status, f"target={mc.get('p_target')}, stop={mc.get('p_stop')}, neither={mc.get('p_neither')}"))
    except urllib.error.HTTPError as e:
        results.append(("POST /api/timemachine/run", e.code, e.read().decode()[:120]))
else:
    results.append(("POST /api/timemachine/run", "SKIP", "no plan data"))

# 12. Position size
req = urllib.request.Request(f"{BASE}/size", data=json.dumps({}).encode(), headers={"Content-Type": "application/json"})
try:
    r = urllib.request.urlopen(req, timeout=30)
    sz = json.loads(r.read().decode())
    results.append(("POST /api/size", r.status, str(sz)[:120]))
except urllib.error.HTTPError as e:
    results.append(("POST /api/size", e.code, e.read().decode()[:120]))

# 13. Risk check
req = urllib.request.Request(f"{BASE}/risk/check", data=json.dumps({}).encode(), headers={"Content-Type": "application/json"})
try:
    r = urllib.request.urlopen(req, timeout=30)
    results.append(("POST /api/risk/check", r.status, str(r.read().decode())[:120]))
except urllib.error.HTTPError as e:
    results.append(("POST /api/risk/check", e.code, e.read().decode()[:120]))

# 14. Alerts add (unique id so reruns do not collide with a real rule)
rule_id = "audit-tsla-stop"
try:
    req = urllib.request.Request(f"{BASE}/alerts/{rule_id}", method="DELETE")
    urllib.request.urlopen(req, timeout=10).read()
except urllib.error.HTTPError:
    pass
req = urllib.request.Request(f"{BASE}/alerts/add", data=json.dumps({"rule_id": rule_id, "symbol": "TSLA", "stop": 358.32}).encode(), headers={"Content-Type": "application/json"})
try:
    r = urllib.request.urlopen(req, timeout=10)
    results.append(("POST /api/alerts/add", r.status, "added"))
except urllib.error.HTTPError as e:
    results.append(("POST /api/alerts/add", e.code, e.read().decode()[:120]))

# 15. Alerts list
s, r = get("/alerts/list")
count = len(r.get("rules", [])) if isinstance(r, dict) else len(r) if isinstance(r, list) else 0
results.append(("GET /api/alerts/list", s, f"count={count}"))

# 16. Alerts check
req = urllib.request.Request(f"{BASE}/alerts/check", data=json.dumps({}).encode(), headers={"Content-Type": "application/json"})
try:
    r = urllib.request.urlopen(req, timeout=10)
    results.append(("POST /api/alerts/check", r.status, str(r.read().decode())[:120]))
except urllib.error.HTTPError as e:
    results.append(("POST /api/alerts/check", e.code, e.read().decode()[:120]))

# Clean up the audit-only rule so the desk is left as it was.
try:
    req = urllib.request.Request(f"{BASE}/alerts/{rule_id}", method="DELETE")
    urllib.request.urlopen(req, timeout=10).read()
except urllib.error.HTTPError:
    pass

# 17. Earnings (AAPL)
req = urllib.request.Request(f"{BASE}/earnings", data=json.dumps({"tickers": ["AAPL"]}).encode(), headers={"Content-Type": "application/json"})
try:
    r = urllib.request.urlopen(req, timeout=30)
    results.append(("POST /api/earnings (AAPL)", r.status, str(r.read().decode())[:120]))
except urllib.error.HTTPError as e:
    results.append(("POST /api/earnings (AAPL)", e.code, e.read().decode()[:120]))

# 18. Congress filings (Pelosi)
req = urllib.request.Request(f"{BASE}/congress/index", data=json.dumps({"member": "Pelosi"}).encode(), headers={"Content-Type": "application/json"})
try:
    r = urllib.request.urlopen(req, timeout=30)
    results.append(("POST /api/congress/index (Pelosi)", r.status, str(r.read().decode())[:120]))
except urllib.error.HTTPError as e:
    results.append(("POST /api/congress/index (Pelosi)", e.code, e.read().decode()[:120]))

# 19. Watchlist remove
req = urllib.request.Request(f"{BASE}/watchlist/TSLA", method="DELETE")
try:
    r = urllib.request.urlopen(req, timeout=10)
    results.append(("DELETE /api/watchlist/TSLA", r.status, "removed"))
except urllib.error.HTTPError as e:
    results.append(("DELETE /api/watchlist/TSLA", e.code, e.read().decode()[:120]))

print("\n=== BACKEND AUDIT RESULTS ===")
for name, status, summary in results:
    status_str = "PASS" if status == 200 else ("FAIL" if isinstance(status, int) else "SKIP")
    print(f"  [{status_str}] {name}: {status} - {summary}")
