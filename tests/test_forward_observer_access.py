"""Fake-only transport and account-binding checks for the paper observer."""

import base64
import hashlib
import importlib.util
import io
import json
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

import pytest

SPEC = importlib.util.spec_from_file_location(
    "forward_observer_access", Path(__file__).resolve().parents[1] / "ops/forward_observer_access.py"
)
access = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(access)
HTTP_BYTES = access.http_bytes

OWNER = "11111111-1111-4111-8111-111111111111"
ACCOUNT = "22222222-2222-4222-8222-222222222222"
BROKER = "33333333-3333-4333-8333-333333333333"
ORDER = "44444444-4444-4444-8444-444444444444"
SERVICE = "SYNTHETIC-SERVICE-NOT-A-KEY"
KEY = "SYNTHETIC-PAPER-KEY"
SECRET = "SYNTHETIC-PAPER-SECRET"
TOKEN = "SYNTHETIC-GITHUB-TOKEN"


@pytest.fixture(autouse=True)
def no_real_transport(monkeypatch):
    def refused(*args, **kwargs):
        raise AssertionError("Tests must supply a fake transport")
    monkeypatch.setattr(access, "http_bytes", refused)
    monkeypatch.setattr(access, "docker_get", refused)
    monkeypatch.setattr(access, "time", SimpleNamespace(sleep=lambda _: None, monotonic=lambda: 100.0))


@pytest.fixture
def binding_fixture(monkeypatch):
    config = {
        "app_container": "natetrader-dashboard-synthetic-active", "app_image": "sha256:" + "a" * 64,
        "app_sha": "b" * 40, "approved_release_sha": "c" * 40, "paper_handoff_sha256": "d" * 64,
    }
    env = {
        "GITHUB_REPO": access.REPOSITORY, "PRODUCTION_ACCOUNT_MODE": "paper",
        "SUPABASE_SERVER_URL": "http://natetrader-supabase-kong:8000",
        "PRODUCTION_RELEASE_SHA": config["approved_release_sha"],
        "PAPER_RUNTIME_HANDOFF_SHA256": config["paper_handoff_sha256"],
        "PRODUCTION_OWNER_USER_ID": OWNER, "PRODUCTION_ACCOUNT_ID": ACCOUNT,
        "PRODUCTION_ALPACA_ACCOUNT_NUMBER": "PAPER-SYNTHETIC", "SUPABASE_SERVICE_ROLE_KEY": SERVICE,
        "GITHUB_TOKEN": TOKEN,
    }
    network = {"NetworkID": "synthetic-network", "IPAddress": "10.20.30.40"}
    app = {
        "Id": "synthetic-app-instance", "Image": config["app_image"],
        "State": {"Running": True, "Pid": 987},
        "Config": {"Env": [f"{k}={v}" for k, v in env.items()],
                   "Labels": {"org.opencontainers.image.revision": config["app_sha"]}},
        "NetworkSettings": {"Networks": {"dokploy-network": network}},
    }
    gateway = {"Names": ["/natetrader-supabase-kong"],
               "NetworkSettings": {"Networks": {"dokploy-network": {**network, "IPAddress": "10.20.30.41"}}}}
    row = {"id": ACCOUNT, "owner_id": OWNER, "mode": "paper", "deleted_at": None,
           "status": "connected", "is_active": True, "alpaca_account_number": "PAPER-SYNTHETIC",
           "credential_version": 3}
    broker = {"id": BROKER, "account_number": "PAPER-SYNTHETIC", "currency": "USD", "status": "ACTIVE",
              "account_blocked": False, "trading_blocked": False, "trade_suspended_by_user": False}
    f = SimpleNamespace(config=config, app=app, gateways=[gateway], row=row, broker=broker,
                        calls=[], namespace=10, ns_calls=[], closed=[], row_reads=0,
                        credentials_reads=0, after_row=None, database_error=None, github_overrides={},
                        public_health={"status": "ok", "buildSha": config["app_sha"], "dataMode": "account-scoped"})

    def docker(path):
        f.calls.append(("docker", path))
        if path == "/containers/json?all=0":
            return deepcopy(f.gateways)
        assert path == "/containers/" + config["app_container"] + "/json"
        return deepcopy(f.app)

    def http(url, headers, *, payload=None, max_bytes=None):
        f.calls.append(("http", url, dict(headers), payload, max_bytes))
        parts = urlsplit(url)
        if parts.netloc == "10.20.30.41:8000":
            assert f.namespace == 20
            assert headers["Authorization"] == "Bearer " + SERVICE
            if f.database_error is not None:
                raise f.database_error
            if parts.path == "/rest/v1/accounts":
                assert payload is None
                assert parse_qs(parts.query)["id"] == ["eq." + ACCOUNT]
                f.row_reads += 1
                row = f.after_row if f.row_reads > 1 and f.after_row is not None else f.row
                return json.dumps([row]).encode()
            assert parts.path == "/rest/v1/rpc/get_account_credentials"
            assert json.loads(payload) == {"acct": ACCOUNT}
            f.credentials_reads += 1
            return json.dumps([{"api_key": KEY, "api_secret": SECRET}]).encode()
        if parts.netloc == "paper-api.alpaca.markets":
            assert f.namespace == 10 and parts.path == "/v2/account" and payload is None
            assert headers == {"APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SECRET}
            return json.dumps(f.broker).encode()
        if parts.netloc == "nate-trader.anikin.cz":
            assert parts.path == "/api/health" and headers == {} and payload is None and f.namespace == 10
            return json.dumps(f.public_health).encode()
        assert parts.netloc == "api.github.com" and payload is None and f.namespace == 10
        assert headers["Authorization"] == "Bearer " + TOKEN
        name = parts.path.rsplit("/", 1)[1]
        expected = {"PRODUCTION_RELEASE_SHA": config["approved_release_sha"],
                    "PAPER_RUNTIME_HANDOFF_SHA256": config["paper_handoff_sha256"]}
        return json.dumps({"value": f.github_overrides.get(name, expected[name])}).encode()

    def open_fd(path, flags):
        assert path in {"/proc/self/ns/net", "/proc/987/ns/net"}
        return 71 if path == "/proc/self/ns/net" else 72

    def setns(fd, flags):
        f.ns_calls.append((fd, flags))
        f.namespace = 10 if fd == 71 else 20

    monkeypatch.setattr(access, "docker_get", docker)
    monkeypatch.setattr(access, "http_bytes", http)
    monkeypatch.setattr(access, "os", SimpleNamespace(
        open=open_fd, close=f.closed.append, setns=setns, O_RDONLY=0, O_CLOEXEC=0,
        stat=lambda _: SimpleNamespace(st_ino=f.namespace),
        fstat=lambda _: SimpleNamespace(st_ino=10),
    ))
    return f


def test_bound_paper_account_uses_only_select_rpc_and_restores_namespace(binding_fixture):
    f = binding_fixture
    bound = access.Binding(f.config)
    expected = hashlib.sha256(json.dumps({"broker": "alpaca", "mode": "paper", "account_id": BROKER},
                                        sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    assert bound.account_digest == expected
    assert f.row_reads == 2 and f.credentials_reads == 1 and f.namespace == 10
    assert f.ns_calls == [(72, 0), (71, 0)] * 3
    assert f.closed == [72, 71] * 3
    posts = [call for call in f.calls if call[0] == "http" and call[3] is not None]
    assert len(posts) == 1 and posts[0][1].endswith("/rpc/get_account_credentials")


@pytest.mark.parametrize("field,value", [("mode", "live"), ("owner_id", BROKER), ("id", BROKER),
    ("deleted_at", "2026-01-01"), ("status", "disconnected"), ("alpaca_account_number", "WRONG"),
    ("credential_version", True), ("credential_version", 0), ("credential_version", -1),
    ("is_active", False)])
def test_wrong_account_binding_refused_before_decryption(binding_fixture, field, value):
    f = binding_fixture
    f.row[field] = value
    with pytest.raises(access.ObservationError, match="account_binding"):
        access.Binding(f.config)
    assert f.credentials_reads == 0


@pytest.mark.parametrize("field,value", [("Image", "sha256:" + "f" * 64), ("State", {"Running": False, "Pid": 987})])
def test_wrong_app_refused_before_database(binding_fixture, field, value):
    f = binding_fixture
    f.app[field] = value
    with pytest.raises(access.ObservationError, match="app_identity"):
        access.Binding(f.config)
    assert f.row_reads == f.credentials_reads == 0


def test_wrong_source_and_duplicate_environment_refused(binding_fixture):
    f = binding_fixture
    f.app["Config"]["Labels"]["org.opencontainers.image.revision"] = "e" * 40
    with pytest.raises(access.ObservationError, match="app_identity"):
        access.Binding(f.config)
    f.app["Config"]["Labels"]["org.opencontainers.image.revision"] = f.config["app_sha"]
    f.app["Config"]["Env"].append("PRODUCTION_ACCOUNT_MODE=live")
    with pytest.raises(access.ObservationError, match="app_environment"):
        access.Binding(f.config)
    assert f.credentials_reads == 0


@pytest.mark.parametrize("change", ["mode", "release", "pin"])
def test_wrong_deployed_paper_configuration_refused(binding_fixture, change):
    f = binding_fixture
    field = {"mode": "PRODUCTION_ACCOUNT_MODE", "release": "PRODUCTION_RELEASE_SHA",
             "pin": "PAPER_RUNTIME_HANDOFF_SHA256"}[change]
    f.app["Config"]["Env"] = [field + "=wrong" if item.startswith(field + "=") else item
                                for item in f.app["Config"]["Env"]]
    with pytest.raises(access.ObservationError, match="production_binding"):
        access.Binding(f.config)
    assert f.credentials_reads == 0


@pytest.mark.parametrize("change", ["duplicate", "network", "public_ip"])
def test_gateway_binding_refused_before_credentials(binding_fixture, change):
    f = binding_fixture
    if change == "duplicate":
        f.gateways *= 2
    else:
        network = f.gateways[0]["NetworkSettings"]["Networks"]["dokploy-network"]
        network["NetworkID" if change == "network" else "IPAddress"] = "wrong" if change == "network" else "8.8.8.8"
    with pytest.raises(access.ObservationError, match="gateway_"):
        access.Binding(f.config)
    assert f.credentials_reads == 0


@pytest.mark.parametrize("field,value", [("account_number", "WRONG"), ("currency", "EUR"),
    ("status", "PENDING"), ("account_blocked", True), ("trading_blocked", None), ("trade_suspended_by_user", "false")])
def test_broker_account_binding_refused(binding_fixture, field, value):
    f = binding_fixture
    f.broker[field] = value
    with pytest.raises(access.ObservationError, match="broker_binding"):
        access.Binding(f.config)


def test_rotation_and_late_approval_change_refused(binding_fixture):
    f = binding_fixture
    f.after_row = {**f.row, "credential_version": 4}
    with pytest.raises(access.ObservationError, match="account_changed"):
        access.Binding(f.config)
    f.after_row = None
    f.github_overrides["PRODUCTION_RELEASE_SHA"] = "f" * 40
    with pytest.raises(access.ObservationError, match="paper_approval_changed"):
        access.Binding(f.config)


def test_database_failure_restores_host_namespace_and_closes_descriptors(binding_fixture):
    f = binding_fixture
    bound = access.Binding(f.config)
    f.database_error = ValueError("SYNTHETIC-PRIVATE-ERROR")
    with pytest.raises(ValueError, match="SYNTHETIC-PRIVATE-ERROR"):
        bound.account_row()
    assert f.namespace == 10 and f.ns_calls[-2:] == [(72, 0), (71, 0)]
    assert f.closed[-2:] == [72, 71]


@pytest.mark.parametrize("path,body", [("/rest/v1/rpc/delete_account", {"acct": ACCOUNT}),
    ("/rest/v1/rpc/get_account_credentials", {"acct": BROKER}), ("/rest/v1/accounts", {"mode": "live"}),
    ("/rest/v1/profiles?select=*", None), ("/rest/v1/accounts?select=*", None),
    ("/rest/v1/accounts?id=eq." + BROKER, None)])
def test_database_write_or_unrelated_read_refused(binding_fixture, path, body):
    f = binding_fixture
    bound = access.Binding(f.config)
    calls = len(f.calls)
    with pytest.raises(access.ObservationError, match="database_read_path"):
        bound.database(path, body)
    assert len(f.calls) == calls


@pytest.mark.parametrize("path,params", [("/v2/orders", None), ("/v2/positions/AAA", None),
    ("/v2/account/configurations", None), ("https://api.alpaca.markets/v2/account", None),
    ("/v2/account?x=1", None), ("/v2/orders/" + "-" * 36, None),
    ("/v2/account", {"page_size": 1}), ("/v2/account/activities", {"url": "https://evil.invalid"})])
def test_paper_transport_has_no_live_or_mutation_or_unapproved_path(path, params):
    with pytest.raises((access.ObservationError, ValueError)):
        access.Paper(KEY, SECRET).get(path, params)


@pytest.mark.parametrize("path,params", [("/v2/account", None), ("/v2/positions", None),
    ("/v2/orders/" + ORDER, None),
    ("/v2/account/activities", {"after": "2026-09-15T00:00:00Z", "until": "2026-09-15T21:00:00Z",
                                "direction": "asc", "page_size": 100, "page_token": "id/with?characters"})])
def test_paper_read_urls_are_encoded_and_never_have_post_payload(monkeypatch, path, params):
    seen = []
    def fake(url, headers, **kwargs):
        seen.append((url, headers, kwargs))
        return b"[]"
    monkeypatch.setattr(access, "http_bytes", fake)
    assert access.Paper(KEY, SECRET).get(path, params) == []
    url, headers, kwargs = seen[0]
    assert urlsplit(url).scheme == "https" and urlsplit(url).netloc == "paper-api.alpaca.markets"
    assert urlsplit(url).path == path and "payload" not in kwargs
    assert headers == {"APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SECRET}
    if params:
        assert parse_qs(urlsplit(url).query)["page_token"] == [params["page_token"]]


@pytest.mark.parametrize("path", ["/actions/workflows/paper-production.yml/dispatches", "/issues",
    "/environments/live-production/variables/PRODUCTION_RELEASE_SHA", "/actions/runs/1/cancel",
    "/actions/runs/1/rerun", "/../OTHER/repo", "https://evil.invalid", "/actions/runs/1?url=https://evil.invalid"])
def test_github_refuses_mutating_or_foreign_routes(path):
    with pytest.raises(access.ObservationError, match="github_read_path"):
        access.GitHub(TOKEN).get(path)


@pytest.mark.parametrize("path", ["", "/actions/workflows/paper-production.yml",
    "/actions/workflows/paper-watchdog.yml/runs?per_page=100&page=1",
    "/actions/runs/123", "/actions/runs/123/jobs?per_page=100", "/actions/runs/123/attempts/2/jobs",
    "/git/ref/heads/main", "/environments/paper-production/variables/PRODUCTION_RELEASE_SHA"])
def test_github_read_callback_is_repository_scoped(monkeypatch, path):
    seen = []
    def fake(url, headers, **kwargs):
        seen.append((url, headers, kwargs))
        return b'{"ok":true}'
    monkeypatch.setattr(access, "http_bytes", fake)
    assert access.GitHub(TOKEN).get(path) == {"ok": True}
    assert seen == [("https://api.github.com/repos/" + access.REPOSITORY + path,
                     access.GitHub(TOKEN).headers, {})]


@pytest.mark.parametrize("url", ["https://job.logs.blob.core.windows.net/log?sig=synthetic",
                                "https://job.actions.githubusercontent.com/log?sig=synthetic"])
def test_signed_job_log_download_never_forwards_github_or_broker_headers(monkeypatch, url):
    calls = []
    def fake(target, headers, **kwargs):
        calls.append((target, dict(headers), kwargs))
        if len(calls) == 1:
            raise HTTPError(target, 302, "redirect", {"Location": url}, None)
        return b"SYNTHETIC LOG\n"
    monkeypatch.setattr(access, "http_bytes", fake)
    assert access.GitHub(TOKEN).job_log(123) == "SYNTHETIC LOG\n"
    assert calls[0][1]["Authorization"] == "Bearer " + TOKEN
    assert calls[1] == (url, {}, {"max_bytes": 2 * 1024 * 1024})


@pytest.mark.parametrize("url", ["http://job.blob.core.windows.net/log", "https://evil.invalid/log",
    "https://blob.core.windows.net.evil.invalid/log", "https://blob.core.windows.net/log",
    "https://user:password@job.blob.core.windows.net/log", "https://job.blob.core.windows.net:444/log"])
def test_unsigned_or_unapproved_log_redirect_refused(monkeypatch, url):
    seen = []
    def fake(target, headers, **kwargs):
        seen.append(target)
        raise HTTPError(target, 302, "redirect", {"Location": url}, None)
    monkeypatch.setattr(access, "http_bytes", fake)
    with pytest.raises(access.ObservationError, match="github_log_origin"):
        access.GitHub(TOKEN).job_log(123)
    assert len(seen) == 1


@pytest.mark.parametrize("job_id", [True, 0, -1, "123"])
def test_job_log_requires_positive_integer_id(job_id):
    with pytest.raises(access.ObservationError, match="github_job_id"):
        access.GitHub(TOKEN).job_log(job_id)


def test_source_digest_verifies_bytes_and_caches_exact_ref_path(monkeypatch):
    calls = []
    source = b"SYNTHETIC READ-ONLY WORKFLOW\n"
    path, ref = ".github/workflows/paper-production.yml", "a" * 40
    def fake(url, headers, **kwargs):
        calls.append(url)
        return json.dumps({"type": "file", "path": path, "encoding": "base64",
                           "size": len(source), "content": base64.b64encode(source).decode()}).encode()
    monkeypatch.setattr(access, "http_bytes", fake)
    github = access.GitHub(TOKEN)
    assert github.source_digest(ref, path) == hashlib.sha256(source).hexdigest()
    assert github.source_digest(ref, path) == hashlib.sha256(source).hexdigest()
    assert calls == [f"https://api.github.com/repos/{access.REPOSITORY}/contents/{path}?ref={ref}"]


@pytest.mark.parametrize("patch", [{"type": "symlink"}, {"path": "other.py"}, {"size": 99},
                                  {"encoding": "none"}, {"content": "%%%"}])
def test_source_shape_or_digest_input_refused(monkeypatch, patch):
    path = "ops/paper_cadence.py"
    row = {"type": "file", "path": path, "encoding": "base64", "size": 1, "content": "YQ==", **patch}
    monkeypatch.setattr(access, "http_bytes", lambda *args, **kwargs: json.dumps(row).encode())
    with pytest.raises((access.ObservationError, ValueError)):
        access.GitHub(TOKEN).source_digest("a" * 40, path)


@pytest.mark.parametrize("ref,path", [("main", "ops/paper_cadence.py"), ("a" * 40, ".env"),
                                     ("a" * 40, "../../credentials")])
def test_source_requires_exact_sha_and_three_public_paths(ref, path):
    with pytest.raises(access.ObservationError, match="github_source"):
        access.GitHub(TOKEN).source_digest(ref, path)


@pytest.mark.parametrize("raw", [b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":Infinity}'])
def test_strict_json_refuses_duplicate_and_nonfinite(raw):
    with pytest.raises(access.ObservationError):
        access.parse_json(raw)


def test_automatic_redirect_is_always_disabled():
    assert access.NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil.invalid") is None


def test_host_guard_requires_root_and_zero_swap_before_access(monkeypatch):
    limits = []
    monkeypatch.setattr(access.resource, "setrlimit", lambda *args: limits.append(args))
    uid = [1000]
    monkeypatch.setattr(access, "os", SimpleNamespace(geteuid=lambda: uid[0]))
    content = {"/proc/self/cgroup": "0::/synthetic.scope\n",
               "/sys/fs/cgroup/synthetic.scope/memory.swap.max": "0\n"}
    monkeypatch.setattr(access.Path, "read_text", lambda path: content[str(path)])
    with pytest.raises(access.ObservationError, match="root_required"):
        access.host_guard()
    uid[0] = 0
    access.host_guard()
    assert limits and all(value == (access.resource.RLIMIT_CORE, (0, 0)) for value in limits)
    content["/sys/fs/cgroup/synthetic.scope/memory.swap.max"] = "max"
    with pytest.raises(access.ObservationError, match="no_swap_required"):
        access.host_guard()


@pytest.mark.parametrize("field", ["id", "pid", "config", "network"])
def test_recheck_rejects_changed_app_instance_config_and_network(binding_fixture, field):
    f = binding_fixture
    bound = access.Binding(f.config)
    if field == "id":
        f.app["Id"] = "another-app"
    elif field == "pid":
        f.app["State"]["Pid"] = 988
    elif field == "config":
        f.app["Config"]["Env"].append("UNEXPECTED=changed")
    else:
        f.app["NetworkSettings"]["Networks"]["dokploy-network"]["IPAddress"] = "10.20.30.99"
    reads = f.row_reads
    with pytest.raises(access.ObservationError, match="app_changed"):
        bound.recheck()
    assert f.row_reads == reads


@pytest.mark.parametrize("patch", [{"status": "error"}, {"buildSha": "e" * 40}, {"dataMode": "demo"}])
def test_public_route_must_serve_the_same_account_scoped_build(binding_fixture, patch):
    f = binding_fixture
    f.public_health.update(patch)
    with pytest.raises(access.ObservationError, match="public_app_changed"):
        access.Binding(f.config)


def test_namespace_verification_failure_refuses_result_but_closes_fds(binding_fixture, monkeypatch):
    f = binding_fixture
    bound = access.Binding(f.config)
    monkeypatch.setattr(access.os, "stat", lambda _: SimpleNamespace(st_ino=999))
    with pytest.raises(access.ObservationError, match="namespace_restore"):
        bound.account_row()
    assert f.closed[-2:] == [72, 71]


@pytest.mark.parametrize("status,body,expected", [(200, b"ok", b"ok"), (201, b"ok", None), (200, b"12345", None)])
def test_http_bound_response_no_proxy_no_redirect(monkeypatch, status, body, expected):
    calls = []
    class Response(io.BytesIO):
        pass
    response = Response(body)
    response.status = status
    def build(*handlers):
        assert handlers[0].proxies == {}
        assert handlers[1] is access.NoRedirect
        def open_request(request, timeout):
            calls.append((request, timeout))
            return response
        return SimpleNamespace(open=open_request)
    monkeypatch.setattr(access, "build_opener", build)
    if expected is None:
        with pytest.raises(access.ObservationError, match="http_response"):
            HTTP_BYTES("https://paper-api.alpaca.markets/v2/account", {}, max_bytes=4)
    else:
        assert HTTP_BYTES("https://paper-api.alpaca.markets/v2/account", {}, max_bytes=4) == expected
    request, timeout = calls[0]
    assert request.get_method() == "GET" and request.data is None and timeout == 30


def test_second_log_redirect_is_not_followed(monkeypatch):
    calls = []
    def fake(target, headers, **kwargs):
        calls.append((target, dict(headers)))
        location = "https://job.blob.core.windows.net/log" if len(calls) == 1 else "https://evil.invalid/log"
        raise HTTPError(target, 302, "redirect", {"Location": location}, None)
    monkeypatch.setattr(access, "http_bytes", fake)
    with pytest.raises(HTTPError):
        access.GitHub(TOKEN).job_log(123)
    assert len(calls) == 2 and calls[1][1] == {}
