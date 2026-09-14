"""Read-only transports and existing production-account binding for observation.

Credentials remain in this process. The only POST is the existing SELECT-only
Vault RPC; broker and GitHub transports do not expose a mutation operation.
"""
from __future__ import annotations

import base64
import hashlib
import http.client
import ipaddress
import json
import os
import re
import resource
import socket
import time
from copy import deepcopy
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from uuid import UUID

REPOSITORY = "DanilaAnikin/nate_trader"
PAPER_ORIGIN = "https://paper-api.alpaca.markets"
SOURCE_PATHS = frozenset({".github/workflows/paper-production.yml",
                          ".github/workflows/paper-watchdog.yml", "ops/paper_cadence.py"})


class ObservationError(ValueError):
    """Only fixed error codes may reach the operator log."""


def require(condition, code):
    if not condition:
        raise ObservationError(code)


def parse_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "duplicate_json_key")
            result[key] = value
        return result

    def invalid(_):
        raise ObservationError("nonfinite_json")

    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http_bytes(url, headers, *, payload=None, max_bytes=8 * 1024 * 1024):
    request = Request(url, headers=headers, data=payload,
                      method="GET" if payload is None else "POST")
    with build_opener(ProxyHandler({}), NoRedirect).open(request, timeout=30) as response:
        raw = response.read(max_bytes + 1)
        require(response.status == 200 and len(raw) <= max_bytes, "http_response")
        return raw


class Docker(http.client.HTTPConnection):
    def __init__(self):
        super().__init__("localhost", timeout=15)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect("/var/run/docker.sock")


def docker_get(path):
    require(path == "/containers/json?all=0" or
            re.fullmatch(r"/containers/natetrader-dashboard-[a-z0-9-]+/json", path),
            "docker_read_path")
    connection = Docker()
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        raw = response.read(4 * 1024 * 1024 + 1)
        require(response.status == 200 and len(raw) <= 4 * 1024 * 1024, "docker_response")
        return parse_json(raw)
    finally:
        connection.close()


def host_guard():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    require(os.geteuid() == 0, "root_required")
    groups = [line.split(":", 2)[2] for line in Path("/proc/self/cgroup").read_text().splitlines()
              if line.startswith("0::")]
    require(len(groups) == 1, "cgroup_required")
    require((Path("/sys/fs/cgroup") / groups[0].lstrip("/") / "memory.swap.max")
            .read_text().strip() == "0", "no_swap_required")


class Paper:
    def __init__(self, key, secret):
        self.headers = {"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret}
        self.last_request = 0.0

    def get(self, path, params=None):
        require(path in {"/v2/account", "/v2/positions", "/v2/account/activities"} or
                bool(re.fullmatch(r"/v2/orders/[0-9a-f-]{36}", path)), "paper_read_path")
        if path.startswith("/v2/orders/"):
            require(str(UUID(path.rsplit("/", 1)[1])) == path.rsplit("/", 1)[1], "order_uuid")
        require(not params or path == "/v2/account/activities", "paper_query_path")
        if params:
            require(set(params) <= {"after", "until", "direction", "page_size", "page_token"},
                    "paper_query_keys")
        time.sleep(max(0.0, 0.36 - (time.monotonic() - self.last_request)))
        self.last_request = time.monotonic()
        return parse_json(http_bytes(PAPER_ORIGIN + path + ("?" + urlencode(params) if params else ""),
                                     self.headers))


class GitHub:
    def __init__(self, token):
        self.headers = {"Authorization": "Bearer " + token,
                        "Accept": "application/vnd.github+json",
                        "X-GitHub-Api-Version": "2026-03-10"}
        self._digests = {}

    def get(self, path):
        require(path == "" or bool(re.fullmatch(
            r"/(?:actions/(?:workflows/[A-Za-z0-9_.-]+(?:/runs)?|runs/[1-9][0-9]*(?:/(?:attempts/[1-9][0-9]*/)?jobs)?)"
            r"|environments/paper-production/variables/(?:PRODUCTION_RELEASE_SHA|PAPER_RUNTIME_HANDOFF_SHA256)"
            r"|git/ref/heads/main)(?:\?[A-Za-z0-9_=&%:.,+\-]*)?", path)), "github_read_path")
        return parse_json(http_bytes("https://api.github.com/repos/" + REPOSITORY + path, self.headers))

    def source_digest(self, ref, path):
        require(bool(re.fullmatch(r"[0-9a-f]{40}", ref)) and path in SOURCE_PATHS, "github_source")
        key = (ref, path)
        if key not in self._digests:
            url = "https://api.github.com/repos/" + REPOSITORY + "/contents/" + path + "?ref=" + ref
            result = parse_json(http_bytes(url, self.headers))
            require(result.get("type") == "file" and result.get("path") == path and
                    result.get("encoding") == "base64", "github_source_shape")
            content = base64.b64decode(result["content"].replace("\n", ""), validate=True)
            require(len(content) <= 131072 and result.get("size") == len(content), "github_source_size")
            self._digests[key] = hashlib.sha256(content).hexdigest()
        return self._digests[key]

    def job_log(self, job_id):
        require(type(job_id) is int and job_id > 0, "github_job_id")
        url = f"https://api.github.com/repos/{REPOSITORY}/actions/jobs/{job_id}/logs"
        try:
            raw = http_bytes(url, self.headers, max_bytes=2 * 1024 * 1024)
        except HTTPError as error:
            require(error.code == 302, "github_log_redirect")
            signed = error.headers.get("Location", "")
            parts = urlsplit(signed)
            require(parts.scheme == "https" and not parts.username and not parts.password and
                    parts.port in (None, 443) and parts.hostname and
                    any(parts.hostname.endswith(suffix) for suffix in
                        (".blob.core.windows.net", ".actions.githubusercontent.com")), "github_log_origin")
            # No GitHub or broker credential accompanies the signed download.
            raw = http_bytes(signed, {}, max_bytes=2 * 1024 * 1024)
        return raw.decode("utf-8", errors="strict")


class Binding:
    def __init__(self, config):
        self.config = config
        self._protected_approval_evidence = None
        self.app = docker_get("/containers/" + config["app_container"] + "/json")
        require(self.app["State"]["Running"] and self.app["Image"] == config["app_image"] and
                self.app["Config"]["Labels"]["org.opencontainers.image.revision"] == config["app_sha"],
                "app_identity")
        env = {}
        for item in self.app["Config"]["Env"]:
            key, separator, value = item.partition("=")
            require(separator and key not in env, "app_environment")
            env[key] = value
        require(env["GITHUB_REPO"] == REPOSITORY and env["PRODUCTION_ACCOUNT_MODE"] == "paper" and
                env["SUPABASE_SERVER_URL"] == "http://natetrader-supabase-kong:8000" and
                env["PRODUCTION_RELEASE_SHA"] == config["approved_release_sha"] and
                env["PAPER_RUNTIME_HANDOFF_SHA256"] == config["paper_handoff_sha256"], "production_binding")
        self.owner, self.account = (str(UUID(env[name])) for name in
                                   ("PRODUCTION_OWNER_USER_ID", "PRODUCTION_ACCOUNT_ID"))
        self.account_query = "/rest/v1/accounts?" + urlencode({"id": "eq." + self.account,
            "select": "id,owner_id,mode,deleted_at,status,is_active,alpaca_account_number,credential_version"})
        self.number = env["PRODUCTION_ALPACA_ACCOUNT_NUMBER"]
        require(bool(self.number), "account_number_required")
        service = env["SUPABASE_SERVICE_ROLE_KEY"]
        self.github = GitHub(env["GITHUB_TOKEN"])
        self.headers = {"apikey": service, "Authorization": "Bearer " + service,
                        "Content-Type": "application/json", "Host": "natetrader-supabase-kong:8000"}
        gateways = [row for row in docker_get("/containers/json?all=0")
                    if set(row.get("Names", [])) & {"/natetrader-supabase-kong", "/natetrader-supabase-kong-1"}]
        require(len(gateways) == 1, "gateway_ambiguous")
        self.network = gateways[0]["NetworkSettings"]["Networks"]["dokploy-network"]
        require(self.network["NetworkID"] == self.app["NetworkSettings"]["Networks"]["dokploy-network"]["NetworkID"],
                "gateway_network")
        ip = ipaddress.ip_address(self.network["IPAddress"])
        require(ip.version == 4 and ip.is_private, "gateway_address")
        self.origin = "http://" + str(ip) + ":8000"
        self.before = self.account_row()
        rows = self.database("/rest/v1/rpc/get_account_credentials", {"acct": self.account})
        require(isinstance(rows, list) and len(rows) == 1, "credentials_shape")
        key, secret = (rows[0][name] for name in ("api_key", "api_secret"))
        require(all(isinstance(value, str) and 8 <= len(value) <= 1024 and
                    not any(c in value for c in "\x00\r\n") for value in (key, secret)), "credential_value")
        self.paper = Paper(key, secret)
        self.broker_account = self.paper.get("/v2/account")
        self.check_broker(self.broker_account)
        self.account_digest = hashlib.sha256(json.dumps(
            {"broker": "alpaca", "mode": "paper", "account_id": str(UUID(self.broker_account["id"]))},
            sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        self.recheck()

    def check_app(self):
        current = docker_get("/containers/" + self.config["app_container"] + "/json")
        require(current["Id"] == self.app["Id"] and current["Image"] == self.config["app_image"] and
                current["State"]["Running"] and current["State"]["Pid"] == self.app["State"]["Pid"] and
                current["Config"] == self.app["Config"] and
                current["NetworkSettings"]["Networks"]["dokploy-network"] ==
                self.app["NetworkSettings"]["Networks"]["dokploy-network"],
                "app_changed")

    def check_public_app(self):
        health = parse_json(http_bytes("https://nate-trader.anikin.cz/api/health",
                            {"User-Agent": "NateTrader-ForwardObserver/1.0"}, max_bytes=8192))
        require(health.get("status") == "ok" and health.get("buildSha") == self.config["app_sha"] and
                health.get("dataMode") == "account-scoped", "public_app_changed")

    def database(self, path, body=None):
        require((body is None and path == self.account_query) or
                (path == "/rest/v1/rpc/get_account_credentials" and body == {"acct": self.account}),
                "database_read_path")
        self.check_app()
        host = os.open("/proc/self/ns/net", os.O_RDONLY | os.O_CLOEXEC)
        app = os.open(f"/proc/{self.app['State']['Pid']}/ns/net", os.O_RDONLY | os.O_CLOEXEC)
        try:
            os.setns(app, 0)
            try:
                raw = http_bytes(self.origin + path, self.headers,
                                 payload=None if body is None else json.dumps(body).encode(), max_bytes=262144)
            finally:
                os.setns(host, 0)
                require(os.stat("/proc/self/ns/net").st_ino == os.fstat(host).st_ino, "namespace_restore")
        finally:
            os.close(app)
            os.close(host)
        return parse_json(raw)

    def account_row(self):
        rows = self.database(self.account_query)
        require(isinstance(rows, list) and len(rows) == 1, "account_ambiguous")
        row = rows[0]
        require(row["id"] == self.account and row["owner_id"] == self.owner and row["mode"] == "paper" and
                row["deleted_at"] is None and row["status"] == "connected" and row["is_active"] is True and
                row["alpaca_account_number"] == self.number and type(row["credential_version"]) is int and
                row["credential_version"] > 0,
                "account_binding")
        return row

    def check_broker(self, account):
        require(account.get("account_number") == self.number and account.get("currency") == "USD" and
                account.get("status") == "ACTIVE" and all(account.get(k) is False for k in
                ("account_blocked", "trading_blocked", "trade_suspended_by_user")), "broker_binding")

    @property
    def protected_approval_evidence(self):
        """Report observed approval visibility without authorizing execution."""
        return deepcopy(self._protected_approval_evidence)

    def _read_protected_approval(self):
        variables = {}
        for name, expected in (("PRODUCTION_RELEASE_SHA", self.config["approved_release_sha"]),
                               ("PAPER_RUNTIME_HANDOFF_SHA256", self.config["paper_handoff_sha256"])):
            try:
                observed = self.github.get("/environments/paper-production/variables/" + name)
            except HTTPError as error:
                # This exception applies only to these two read-only metadata
                # requests. 403 proves neither the configured value nor why
                # GitHub refused it (permissions and rate limits can both do so).
                if error.code != 403:
                    raise
                variables[name] = "HTTP_403"
                continue
            require(isinstance(observed, dict) and observed.get("value") == expected,
                    "paper_approval_changed")
            variables[name] = "VERIFIED"
        verified = all(value == "VERIFIED" for value in variables.values())
        return {"status": "VERIFIED" if verified else "UNAVAILABLE", "verified": verified,
                "reason": None if verified else "github_environment_read_forbidden",
                "variables": variables}

    def recheck(self):
        require(self.account_row() == self.before, "account_changed")
        evidence = self._read_protected_approval()
        require(self._protected_approval_evidence is None or evidence == self._protected_approval_evidence,
                "paper_approval_evidence_changed")
        self.check_app()
        self.check_public_app()
        self._protected_approval_evidence = evidence
