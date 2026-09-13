#!/usr/bin/env python3
"""Dedicated Auth identity probe. Credentials and session cookies stay in RAM."""
from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import re
import resource
import shlex
import stat
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

CHECKS = ("login", "auth_user", "dashboard_accounts", "dashboard_profile", "logout")


def parse_credentials(text):
    values = {}
    allowed = {"PROBE_EMAIL", "PROBE_PASSWORD", "PROBE_ANON"}
    for line in text.splitlines():
        fields = shlex.split(line, comments=True, posix=True)
        if fields[:1] == ["export"]:
            fields = fields[1:]
        if not fields:
            continue
        if len(fields) != 1 or "=" not in fields[0]:
            raise ValueError("Invalid credentials file")
        key, value = fields[0].split("=", 1)
        if key not in allowed or key in values or not value:
            raise ValueError("Invalid credentials file")
        values[key] = value
    if values.keys() != allowed:
        raise ValueError("Incomplete credentials file")
    return values


def read_credentials(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != 0:
        raise ValueError("Private root-owned credentials file required")
    return parse_credentials(path.read_text())


def origin(value):
    parsed = urllib.parse.urlsplit(value)
    local = parsed.hostname in ("localhost", "127.0.0.1", "::1")
    if (parsed.scheme != "https" and not (parsed.scheme == "http" and local)) or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise ValueError("HTTPS or loopback origin required")
    return value.rstrip("/")


def cookie_name(container, api):
    if not re.fullmatch(r"natetrader-dashboard-[a-z0-9-]+", container):
        raise ValueError("Invalid dashboard container")
    result = subprocess.run(["docker", "inspect", container], capture_output=True, timeout=10, check=True)
    info = json.loads(result.stdout)[0]
    env = dict(item.split("=", 1) for item in info["Config"]["Env"] if "=" in item)
    if origin(env["NEXT_PUBLIC_SUPABASE_URL"]) != api:
        raise ValueError("Auth origin mismatch")
    name = env.get("NEXT_PUBLIC_SUPABASE_AUTH_COOKIE_NAME") or "sb-" + urllib.parse.urlsplit(api).hostname.split(".")[0] + "-auth-token"
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
        raise ValueError("Invalid cookie name")
    return name


def session_cookie(name, session):
    # @supabase/ssr 0.10 uses base64url JSON and 3180-byte cookie chunks.
    encoded = "base64-" + base64.urlsafe_b64encode(json.dumps(session, ensure_ascii=False, separators=(",", ":")).encode()).decode().rstrip("=")
    parts = [encoded[index:index + 3180] for index in range(0, len(encoded), 3180)]
    if len(parts) == 1:
        return name + "=" + encoded
    return "; ".join(f"{name}.{index}={part}" for index, part in enumerate(parts))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http(method, url, headers, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(url, data=data, method=method,
                                     headers={**headers, 'User-Agent': 'NateTrader-Monitor/1.0'})
    try:
        response = urllib.request.build_opener(NoRedirect()).open(request, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read(65537)
        if len(raw) > 65536:
            raise ValueError("Oversized response")
        try:
            body = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            body = None
        return response.status, body


def probe(credentials, api, dashboard, name, request=http):
    results = {check: (0, False) for check in CHECKS}
    token = None
    headers = {"apikey": credentials["PROBE_ANON"], "Content-Type": "application/json"}
    try:
        status, session = request("POST", api + "/auth/v1/token?grant_type=password", headers,
                                  {"email": credentials["PROBE_EMAIL"], "password": credentials["PROBE_PASSWORD"]})
        token = session.get("access_token") if isinstance(session, dict) else None
        valid = status == 200 and isinstance(token, str) and bool(token) and isinstance(session.get("refresh_token"), str) and isinstance(session.get("user"), dict) and bool(session["user"].get("id"))
        results["login"] = (status, valid)
        if not valid:
            return results
        session = dict(session)
        if "expires_at" not in session:
            session["expires_at"] = int(time.time()) + int(session["expires_in"])
        authorized = {**headers, "Authorization": "Bearer " + token}
        status, user = request("GET", api + "/auth/v1/user", authorized)
        results["auth_user"] = (status, status == 200 and isinstance(user, dict) and user.get("id") == session["user"]["id"])
        # No raw-JWT cookie shortcut: exercise the actual SSR session parser.
        cookie = {"Cookie": session_cookie(name, session)}
        status, accounts = request("GET", dashboard + "/api/accounts", cookie)
        results["dashboard_accounts"] = (status, status == 200 and isinstance(accounts, dict) and accounts.get("accounts") == [])
        status, profile = request("GET", dashboard + "/api/profile", cookie)
        results["dashboard_profile"] = (status, status == 200 and isinstance(profile, dict) and isinstance(profile.get("profile"), dict))
    except Exception:
        # Network errors, malformed responses and invalid session shape are
        # failures. Never include their text, URL, headers or payload in output.
        pass
    finally:
        if isinstance(token, str) and token:
            try:
                status, _ = request("POST", api + "/auth/v1/logout?scope=local", {**headers, "Authorization": "Bearer " + token})
                results["logout"] = (status, status in (200, 204))
            except Exception:
                pass
    return results


def main():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    parser = argparse.ArgumentParser(description=__doc__)
    for field in ("credentials", "api", "dashboard", "container"):
        parser.add_argument("--" + field, required=True)
    args = parser.parse_args()
    results = {check: (0, False) for check in CHECKS}
    try:
        if os.geteuid() != 0:
            raise ValueError("Root required")
        api, dashboard = origin(args.api), origin(args.dashboard)
        results = probe(read_credentials(Path(args.credentials)), api, dashboard, cookie_name(args.container, api))
    except Exception:
        pass
    for check in CHECKS:
        status, passed = results[check]
        print(f"{check} {status:03d} {'PASS' if passed else 'FAIL'}")
    return 0 if all(passed for _, passed in results.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
