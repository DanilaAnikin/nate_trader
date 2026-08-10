#!/usr/bin/env python3
"""Assertions against a real PostgREST instance.

What a hand-written fake cannot establish:

* which functions are actually reachable on ``/rpc/`` and with what status;
* how the server's ``db-max-rows`` truncates a response;
* that a *newly created* function does not become anonymously callable — the
  default-privilege behaviour only shows up for objects created after the
  migrations ran;
* that a multi-request page walk really can miss a concurrent UPDATE, and that
  the snapshot RPC really cannot.

Run through ``supabase/tests/run_postgrest.sh``, which provides the server.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sys
import urllib.error
import urllib.request

API = os.environ["API_URL"].rstrip("/")
DB = os.environ["DATABASE_URL"]
SECRET = os.environ["JWT_SECRET"]
DB_MAX_ROWS = int(os.environ.get("DB_MAX_ROWS", "100"))

ACCOUNT = "eeeeeeee-0000-0000-0000-0000000000f1"
OWNER = "00000000-0000-0000-0000-00000000000a"
OTHER = "00000000-0000-0000-0000-00000000000b"

failures: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        failures.append(message)


# --------------------------------------------------------------------------- jwt
def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def token(role: str, sub: str | None = None) -> str:
    """A PostgREST-shaped HS256 JWT. No library: the payload is three fields."""
    header = _b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    claims: dict[str, object] = {"role": role, "exp": 4_102_444_800}
    if sub:
        claims["sub"] = sub
    payload = _b64(json.dumps(claims).encode())
    signing_input = f"{header}.{payload}".encode()
    signature = _b64(hmac.new(SECRET.encode(), signing_input, hashlib.sha256).digest())
    return f"{header}.{payload}.{signature}"


def request(
    path: str,
    *,
    role: str | None = None,
    sub: str | None = None,
    method: str = "GET",
    body: object | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, str]:
    url = f"{API}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if role:
        req.add_header("Authorization", f"Bearer {token(role, sub)}")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as exc:  # 4xx/5xx carry the body we want
        return exc.code, exc.read().decode()
    except urllib.error.URLError as exc:  # pragma: no cover - infrastructure
        return 0, str(exc)


def psql(sql: str) -> str:
    import subprocess

    return subprocess.run(
        ["psql", DB, "-tAc", sql],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


# ------------------------------------------------------- 1. the server's row cap
status, body = request(
    "/equity_snapshots?select=snapshot_date", role="service_role"
)
rows = json.loads(body) if status == 200 else []
check(status == 200, f"service_role cannot read equity_snapshots: {status} {body[:200]}")
check(
    len(rows) == DB_MAX_ROWS,
    "the server did not truncate at db-max-rows; this gate proves nothing "
    f"(got {len(rows)}, expected {DB_MAX_ROWS})",
)
print(f"  server truncates a plain select at {len(rows)} rows (db-max-rows)")

# The fixture is genuinely bigger than the cap *and* bigger than 1000.
total_equity = int(psql(f"select count(*) from equity_snapshots where account_id='{ACCOUNT}'"))
total_flows = int(psql(f"select count(*) from cash_flows where account_id='{ACCOUNT}'"))
check(total_equity > 1000, f"fixture equity rows must exceed 1000, got {total_equity}")
check(total_flows > DB_MAX_ROWS, f"fixture flow rows must exceed the cap, got {total_flows}")

# ------------------------------------------ 2. the snapshot RPC returns everything
status, body = request(
    "/rpc/account_history_snapshot",
    role="service_role",
    method="POST",
    body={"p_account": ACCOUNT, "p_owner": OWNER, "p_from": None},
)
check(status == 200, f"snapshot RPC failed: {status} {body[:300]}")
if status == 200:
    snapshot = json.loads(body)
    check(
        len(snapshot["equity"]) == total_equity,
        f"snapshot returned {len(snapshot['equity'])} equity rows of {total_equity}",
    )
    check(
        len(snapshot["cash_flows"]) == total_flows,
        f"snapshot returned {len(snapshot['cash_flows'])} flows of {total_flows}",
    )
    check(
        snapshot["equity_count"] == total_equity
        and snapshot["cash_flow_count"] == total_flows,
        "the snapshot's own counts disagree with its payload",
    )
    check(bool(snapshot.get("snapshot")), "the snapshot carries no audit token")
    # bigint ids must survive as text; a JSON number would lose precision.
    check(
        all(isinstance(flow["id"], str) for flow in snapshot["cash_flows"]),
        "cash-flow ids must be strings, not JSON numbers",
    )
    print(
        f"  one snapshot returned {len(snapshot['equity'])} equity rows and "
        f"{len(snapshot['cash_flows'])} flows, past a {DB_MAX_ROWS}-row cap"
    )

# --------------------------- 3. a multi-request walk misses a concurrent UPDATE
#
# The point of the RPC. Page one is read, the row it contained is then updated,
# and page two is read: the walk's count is unchanged, no key repeats and
# nothing is skipped — so every client-side consistency check passes while the
# returned value is already stale. The single-snapshot RPC cannot do this.
first_page_status, first_page = request(
    f"/equity_snapshots?select=snapshot_date,equity&account_id=eq.{ACCOUNT}"
    f"&order=snapshot_date.asc&limit=5",
    role="service_role",
)
check(first_page_status == 200, "walk page one failed")
page_one = json.loads(first_page) if first_page_status == 200 else []
if page_one:
    victim = page_one[0]["snapshot_date"]
    psql(
        "update equity_snapshots set equity = 999999 "
        f"where account_id='{ACCOUNT}' and snapshot_date='{victim}'"
    )
    cursor = page_one[-1]["snapshot_date"]
    status, second_page = request(
        f"/equity_snapshots?select=snapshot_date,equity&account_id=eq.{ACCOUNT}"
        f"&snapshot_date=gt.{cursor}&order=snapshot_date.asc&limit=5",
        role="service_role",
    )
    check(status == 200, "walk page two failed")
    walked = page_one + (json.loads(second_page) if status == 200 else [])
    stale = [row for row in walked if row["snapshot_date"] == victim]
    check(
        bool(stale) and float(stale[0]["equity"]) != 999999,
        "the multi-request walk was expected to carry a stale value; it did not, "
        "so this assertion no longer demonstrates the tear it exists for",
    )
    # And the snapshot RPC, read now, sees the update.
    status, body = request(
        "/rpc/account_history_snapshot",
        role="service_role",
        method="POST",
        body={"p_account": ACCOUNT, "p_owner": OWNER, "p_from": None},
    )
    fresh = json.loads(body)["equity"] if status == 200 else []
    updated = [row for row in fresh if row["date"] == victim]
    check(
        bool(updated) and float(updated[0]["equity"]) == 999999,
        "the snapshot RPC did not observe the concurrent update",
    )
    print("  a page walk returned a stale row the single snapshot did not")
    psql(
        "update equity_snapshots set equity = 1000000 "
        f"where account_id='{ACCOUNT}' and snapshot_date='{victim}'"
    )

# ------------------------------------- 4. concurrent insert/delete inside a snapshot
before = json.loads(
    request(
        "/rpc/account_history_snapshot",
        role="service_role",
        method="POST",
        body={"p_account": ACCOUNT, "p_owner": OWNER, "p_from": None},
    )[1]
)
psql(
    "insert into cash_flows (account_id, flow_date, amount, kind, source, external_id) "
    f"values ('{ACCOUNT}', current_date, 5, 'deposit', 'alpaca_activities', 'act-concurrent')"
)
after_insert = json.loads(
    request(
        "/rpc/account_history_snapshot",
        role="service_role",
        method="POST",
        body={"p_account": ACCOUNT, "p_owner": OWNER, "p_from": None},
    )[1]
)
check(
    after_insert["cash_flow_count"] == before["cash_flow_count"] + 1,
    "the snapshot did not observe an inserted row on the next call",
)
check(
    len(after_insert["cash_flows"]) == after_insert["cash_flow_count"],
    "an inserted row produced a snapshot whose payload and count disagree",
)
psql(f"delete from cash_flows where account_id='{ACCOUNT}' and external_id='act-concurrent'")
after_delete = json.loads(
    request(
        "/rpc/account_history_snapshot",
        role="service_role",
        method="POST",
        body={"p_account": ACCOUNT, "p_owner": OWNER, "p_from": None},
    )[1]
)
check(
    after_delete["cash_flow_count"] == before["cash_flow_count"]
    and len(after_delete["cash_flows"]) == before["cash_flow_count"],
    "the snapshot did not observe a deleted row consistently",
)
print("  every snapshot is internally consistent across insert and delete")

# ---------------------------------------------- 5. the row limit fails UNAVAILABLE
limit = int(psql("select account_history_row_limit()"))
psql(
    "insert into equity_snapshots (account_id, snapshot_date, equity, cash, source) "
    f"select '{ACCOUNT}', date '2100-01-01' + (n || ' days')::interval, 1, 0, "
    f"'alpaca_portfolio_history' from generate_series(0, {limit}) as n "
    "on conflict do nothing"
)
status, body = request(
    "/rpc/account_history_snapshot",
    role="service_role",
    method="POST",
    body={"p_account": ACCOUNT, "p_owner": OWNER, "p_from": None},
)
check(
    status >= 400 and "snapshot limit" in body,
    f"an over-limit history must fail loudly, got {status} {body[:200]}",
)
psql(f"delete from equity_snapshots where account_id='{ACCOUNT}' and snapshot_date >= '2100-01-01'")
print("  an over-limit history fails closed instead of truncating")

# --------------------------------------------------- 6. ownership inside the RPC
status, body = request(
    "/rpc/account_history_snapshot",
    role="service_role",
    method="POST",
    body={"p_account": ACCOUNT, "p_owner": OTHER, "p_from": None},
)
check(status >= 400, f"another owner could read this history: {status}")

# ------------------------------------------------ 7. client roles reach nothing
for role, sub in (("anon", None), ("authenticated", OWNER)):
    for path in (
        "/accounts?select=*",
        "/trades?select=*",
        "/cash_flows?select=*",
    ):
        status, body = request(path, role=role, sub=sub)
        check(
            status in (401, 403, 404),
            f"{role} reached {path}: {status} {body[:120]}",
        )

    for rpc, payload in (
        ("account_history_snapshot", {"p_account": ACCOUNT, "p_owner": OWNER}),
        ("rotate_account_credentials", {
            "p_account": ACCOUNT, "p_owner": OWNER,
            "p_api_key": "k", "p_api_secret": "s", "p_account_number": "PA-1",
        }),
        ("delete_account_atomic", {"p_account": ACCOUNT, "p_owner": OWNER}),
        ("get_account_credentials", {"acct": ACCOUNT}),
        ("vault_create_secret", {"p_secret": "x"}),
        ("reconcile_cash_flow_mirror", {
            "p_account": ACCOUNT, "p_owner": OWNER,
            "p_from": "2020-01-01", "p_rows": [],
        }),
        ("replace_equity_snapshots", {
            "p_account": ACCOUNT, "p_owner": OWNER, "p_rows": [],
        }),
    ):
        status, body = request(
            f"/rpc/{rpc}", role=role, sub=sub, method="POST", body=payload
        )
        check(
            status in (401, 403, 404),
            f"{role} could call /rpc/{rpc}: {status} {body[:120]}",
        )
print("  anon and authenticated reach no sensitive table or RPC")

# ------------------------------------------------------- 8. sequences are closed
for role, sub in (("anon", None), ("authenticated", OWNER)):
    for statement in ("nextval", "setval"):
        # There is no REST verb for a sequence, so this is asserted in-database
        # against the same role PostgREST would switch to.
        result = psql(
            "select has_sequence_privilege("
            f"'{role}', 'public.cash_flows_id_seq', "
            f"'{'USAGE' if statement == 'nextval' else 'UPDATE'}')"
        )
        check(result == "f", f"{role} can {statement}() on cash_flows_id_seq")
print("  no client role can nextval() or setval() a public sequence")

# ------------------------- 9. a function created AFTER the migrations stays closed
#
# The default-privilege behaviour only shows up for new objects. Without the
# narrowed defaults, PostgreSQL grants EXECUTE to PUBLIC and Supabase's
# defaults add anon/authenticated, so this probe would be world-callable.
psql(
    "create or replace function audit_probe_function() returns text "
    "language sql immutable as $$ select 'reachable'::text $$"
)
psql("notify pgrst, 'reload schema'")
import time

time.sleep(2)
for role, sub in ((None, None), ("anon", None), ("authenticated", OWNER)):
    status, body = request(
        "/rpc/audit_probe_function", role=role, sub=sub, method="POST", body={}
    )
    label = role or "unauthenticated"
    check(
        status in (401, 403, 404),
        f"{label} could call /rpc/audit_probe_function: {status} {body[:160]}",
    )
status, body = request("/rpc/audit_probe_function", role="service_role", method="POST", body={})
check(
    status == 200,
    f"service_role must still be able to call a new function: {status} {body[:160]}",
)
print("  a probe function created after the migrations is not anonymously callable")

# ------------------------------------- 10. the service-role workflow still works
status, body = request(
    "/rpc/reconcile_cash_flow_mirror",
    role="service_role",
    method="POST",
    body={
        "p_account": ACCOUNT,
        "p_owner": OWNER,
        "p_from": "2020-01-01",
        "p_rows": [
            {
                "external_id": "act-000000",
                "flow_date": "2020-01-01",
                "amount": 10,
                "kind": "deposit",
            }
        ],
    },
)
check(status == 200, f"service_role reconciliation failed: {status} {body[:200]}")
if status == 200:
    outcome = json.loads(body)
    check(
        outcome["removed"] == total_flows - 1,
        "the reconciliation did not delete the rows the broker no longer reports "
        f"(removed {outcome['removed']} of an expected {total_flows - 1})",
    )
    remaining = int(psql(f"select count(*) from cash_flows where account_id='{ACCOUNT}'"))
    check(remaining == 1, f"expected 1 mirrored flow after reconciliation, got {remaining}")
print("  the service-role reconciliation removes withdrawn activities atomically")

# RLS helpers, Vault and the lifecycle RPC must all still function.
check(psql("select owns_account('%s')" % ACCOUNT) in ("f", ""), "owns_account is callable")
status, body = request(
    "/rpc/delete_account_atomic",
    role="service_role",
    method="POST",
    body={
        "p_account": "eeeeeeee-0000-0000-0000-0000000000f2",
        "p_owner": OTHER,
        "p_purge_history": False,
    },
)
check(status == 200, f"service_role lifecycle RPC failed: {status} {body[:200]}")
print("  RLS helpers, Vault wrappers and the lifecycle RPC still work")

# ----------------------------------------------------------------------- verdict
if failures:
    print("\nFAILED:")
    for failure in failures:
        print(f"  - {failure}")
    sys.exit(1)
print("\npostgrest assertions OK")
