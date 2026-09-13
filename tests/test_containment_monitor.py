"""Containment checks use synthetic identities and fake local transports only."""
import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("nt_auth_probe", ROOT / "ops/monitor/auth_probe.py")
auth = importlib.util.module_from_spec(spec)
spec.loader.exec_module(auth)


def test_auth_http_identifies_monitor_without_changing_session_headers(monkeypatch):
    class Edge:
        def open(self, request, timeout):
            assert request.get_header('User-agent') == 'NateTrader-Monitor/1.0'
            assert request.get_header('Cookie') == 'synthetic-session'
            response = io.BytesIO(b'{"profile":{}}')
            response.status = 200
            return response
    monkeypatch.setattr(auth.urllib.request, 'build_opener', lambda *args: Edge())
    assert auth.http('GET', 'https://example.invalid/api/profile',
                     {'Cookie': 'synthetic-session'}) == (200, {'profile': {}})


def test_credentials_are_parsed_without_shell_execution():
    parsed = auth.parse_credentials("PROBE_EMAIL='probe@example.invalid'\nPROBE_PASSWORD='quotes\" and $(false)'\nPROBE_ANON='public-key'\n")
    assert parsed["PROBE_PASSWORD"] == 'quotes" and $(false)'
    with pytest.raises(ValueError):
        auth.parse_credentials("PROBE_EMAIL=x; touch /tmp/should-never-run")


def decode_cookie(header):
    values = [part.split("=", 1)[1] for part in header.split("; ")]
    encoded = "".join(values).removeprefix("base64-")
    return json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))


@pytest.mark.parametrize("size", [20, 6000])
def test_cookie_matches_actual_supabase_ssr_json_format_and_chunk_size(size):
    session = {"access_token": "a" * size, "refresh_token": "r", "user": {"id": "probe"}}
    header = auth.session_cookie("sb-pinned-auth-token", session)
    assert decode_cookie(header) == session
    assert all(len(part.split("=", 1)[1]) <= 3180 for part in header.split("; "))
    assert header.startswith("sb-pinned-auth-token" + (".0=" if size > 3180 else "="))


def exercise_probe(account_status=200, account_body=None):
    credentials = {"PROBE_EMAIL": "probe@example.invalid", "PROBE_PASSWORD": 'special"password', "PROBE_ANON": "public-key"}
    calls = []
    def request(method, url, headers, payload=None):
        calls.append((method, url, headers, payload))
        if "/token?" in url:
            assert payload == {"email": credentials["PROBE_EMAIL"], "password": credentials["PROBE_PASSWORD"]}
            return 200, {"access_token": "SECRET-ACCESS", "refresh_token": "SECRET-REFRESH", "expires_in": 3600, "user": {"id": "synthetic"}}
        if url.endswith("/user"):
            return 200, {"id": "synthetic"}
        if url.endswith("/api/accounts"):
            assert decode_cookie(headers["Cookie"])["access_token"] == "SECRET-ACCESS"
            assert headers["Cookie"].startswith("sb-pinned-auth-token=base64-")
            return account_status, {"accounts": []} if account_body is None else account_body
        if url.endswith("/api/profile"):
            return 200, {"profile": {"display_name": None}}
        if "/logout?scope=local" in url:
            return 204, None
        raise AssertionError("Unexpected endpoint")
    results = auth.probe(credentials, "https://auth.example.invalid", "https://dashboard.example.invalid", "sb-pinned-auth-token", request)
    return results, calls


def test_authenticated_probe_requires_real_session_read_and_cleans_up_only_its_session():
    results, calls = exercise_probe()
    assert all(passed for _, passed in results.values())
    assert len(calls) == 5
    assert "SECRET" not in json.dumps(results)
    assert "special" not in json.dumps(results)
    assert calls[-1][0] == "POST" and calls[-1][1].endswith("?scope=local")


@pytest.mark.parametrize("status", [401, 403, 500, 503])
def test_rejected_dashboard_read_cannot_count_as_authenticated_pass(status):
    results, calls = exercise_probe(status)
    assert results["dashboard_accounts"] == (status, False)
    assert results["logout"] == (204, True)
    assert calls[-1][1].endswith("?scope=local")


def test_probe_identity_must_not_acquire_customer_accounts():
    results, _ = exercise_probe(account_body={"accounts": [{"id": "unexpected"}]})
    assert not results["dashboard_accounts"][1]


@pytest.mark.parametrize("bad_denial,bad_patch", [("000", "401"), ("500", "401"), ("403", "500"), ("403", "000")])
def test_monitor_rejects_transport_errors_and_check_only_never_notifies(tmp_path, bad_denial, bad_patch):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    state = tmp_path / "state"
    state.mkdir()
    secrets = tmp_path / "secrets"
    secrets.mkdir()
    (state / "nt-containment-expect").write_text("EXPECT_BUILD_SHA=" + "a" * 40 + "\nEXPECT_REST=denied\nEXPECT_FREEZE=thawed\nEXPECT_DASHBOARD_CONTAINER=natetrader-dashboard-candidate\n")
    (secrets / "nt-containment-anon.txt").write_text("public-anon")
    # No actual identity/network calls or notification command can run.
    (fake_bin / "curl").write_text("""#!/usr/bin/env python3
import json,os,sys
a=sys.argv[1:]; url=a[-1]
if '-w' not in a:
 print(json.dumps({'buildSha':'a'*40}) if '/api/health' in url else '{"disable_signup":true}')
elif '/api/profile' in url: print(os.environ['FAKE_PATCH'],end='')
elif '/api/health' in url or '/auth/v1/settings' in url: print('200',end='')
else: print(os.environ['FAKE_DENIAL'],end='')
""")
    (fake_bin / "docker").write_text("""#!/usr/bin/env python3
import sys
a=sys.argv[1:]
if a[0]=='exec': print('OK')
elif '--format' in a:
 f=a[-1]
 print('true' if 'Running' in f else '0' if 'RestartCount' in f else '2026-09-13T00:00:00Z')
""")
    for path in fake_bin.iterdir():
        path.chmod(0o755)
    result = subprocess.run(["bash", str(ROOT / "ops/monitor/nt-containment-monitor.sh"), "--check-only"],
        env={**os.environ, "PATH": str(fake_bin) + os.pathsep + os.environ["PATH"],
             "NT_MONITOR_STATE_DIR": str(state), "NT_MONITOR_SECRETS_DIR": str(secrets),
             "FAKE_DENIAL": bad_denial, "FAKE_PATCH": bad_patch}, capture_output=True, text=True, timeout=20)
    assert result.returncode == 1
    assert "CONTAINMENT MONITOR FAILED" in result.stdout
    assert "natetrader-dashboard-candidate" in result.stdout
    assert not (state / "nt-containment-last").exists()
    if bad_patch != "401":
        assert "FAIL   freeze lifted as expected" in result.stdout
    else:
        assert "FAIL   public" in result.stdout
