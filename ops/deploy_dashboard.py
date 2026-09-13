#!/usr/bin/env python3
"""Stage an immutable dashboard image and atomically change only its route.

Run on the Docker host as root. Database migration/recovery acceptance is a
separate prerequisite. No broker credentials, database changes or image builds.
Container environment values travel only in memory over the local Docker socket.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

STATE = Path('/var/lib/homelab/nate-trader/deployments')
ROUTE = Path('/etc/dokploy/traefik/dynamic/natetrader.yml')
EXPECT = Path('/var/lib/homelab/nt-containment-expect')
DASHBOARD = 'https://nate-trader.anikin.cz'
API = 'https://ntapi.anikin.cz'
NETWORK = 'dokploy-network'
CARRY = (
    'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'NEXT_PUBLIC_SUPABASE_AUTH_COOKIE_NAME', 'SUPABASE_SERVER_URL',
    'SUPABASE_SERVICE_ROLE_KEY', 'GITHUB_TOKEN', 'GITHUB_REPO',
    'GITHUB_STATE_REF', 'PRODUCTION_OWNER_USER_ID', 'PRODUCTION_ACCOUNT_ID',
    'PRODUCTION_ALPACA_ACCOUNT_NUMBER', 'PRODUCTION_ACCOUNT_MODE', 'V11_EPOCH_BASELINE',
)
OPTIONAL = {'V11_EPOCH_BASELINE', 'PRODUCTION_ACCOUNT_MODE'}


class Refusal(RuntimeError):
    pass


def require(value, message):
    if not value:
        raise Refusal(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def valid_sha(value):
    require(bool(re.fullmatch('[0-9a-f]{40}', value)), 'Full source SHA required')
    return value


def valid_name(value):
    require(bool(re.fullmatch(r'natetrader-dashboard-[a-z0-9-]+', value)),
            'Expected a dedicated Nate dashboard container name')
    return value


class DockerConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect('/var/run/docker.sock')


def docker(method, path, payload=None, missing_ok=False):
    conn = DockerConnection('localhost', timeout=60)
    try:
        conn.request(method, path, body=json.dumps(payload) if payload is not None else None,
                     headers={'Content-Type': 'application/json'})
        response = conn.getresponse()
        body = response.read()
        if response.status == 404 and missing_ok:
            return None
        # Docker error bodies may include environment values; never print them.
        require(200 <= response.status < 300, f'Docker operation refused ({response.status})')
        return json.loads(body) if body else None
    finally:
        conn.close()


def container(name):
    valid_name(name)
    result = docker('GET', f'/containers/{name}/json')
    require(result['State']['Running'], 'Dashboard container is not running')
    require(not any(result['NetworkSettings'].get('Ports', {}).values()),
            'Dashboard must have no published ports')
    require(NETWORK in result['NetworkSettings']['Networks'], 'Dashboard network missing')
    return result


def public_response(url, method='GET'):
    request = urllib.request.Request(url, method=method,
                                     headers={'User-Agent': 'NateTrader-Deployment/1.0'})
    try:
        response = urllib.request.urlopen(request, timeout=10)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, response.read(65536)


def internal_probe(name, sha, freeze):
    info = container(name)
    require(info['Config'].get('Labels', {}).get('org.opencontainers.image.revision') == sha,
            'Running image revision differs from expected source')
    script = """(async () => {
      const paths = ['/api/health', '/login', '/api/accounts', '/api/profile'];
      const out = [];
      for (const path of paths) {
        const r = await fetch('http://127.0.0.1:3000' + path, {
          method: path === '/api/profile' ? 'PATCH' : 'GET',
          redirect: 'manual', signal: AbortSignal.timeout(10000)
        });
        out.push({path, status:r.status,
          health:path === '/api/health' ? await r.json() : null});
      }
      process.stdout.write(JSON.stringify(out));
    })().catch(() => process.exit(1));"""
    result = subprocess.run(['docker', 'exec', name, 'node', '-e', script],
                            capture_output=True, text=True, timeout=50)
    require(result.returncode == 0, 'Internal HTTP probe failed')
    try:
        rows = json.loads(result.stdout)
        require([row['status'] for row in rows] == [200, 200, 401, 503 if freeze else 401],
                'Internal HTTP status contract failed')
        require(rows[0]['health']['buildSha'] == sha, 'Internal build SHA mismatch')
        require(rows[0]['health']['writes_enabled'] is (not freeze), 'Write-freeze state mismatch')
    except (ValueError, KeyError, TypeError) as error:
        raise Refusal('Invalid internal HTTP probe evidence') from error


def public_probe(sha, freeze):
    status, body = public_response(DASHBOARD + '/api/health')
    require(status == 200, 'Public health failed')
    try:
        health = json.loads(body)
        require(health['buildSha'] == sha, 'Public build SHA mismatch')
        require(health['writes_enabled'] is (not freeze), 'Public freeze state mismatch')
    except (ValueError, KeyError, TypeError) as error:
        raise Refusal('Invalid public health evidence') from error
    for path, method, wanted in [('/login', 'GET', 200), ('/api/accounts', 'GET', 401),
                                  ('/api/profile', 'PATCH', 503 if freeze else 401)]:
        require(public_response(DASHBOARD + path, method)[0] == wanted,
                f'Public {path} contract failed')
    for path in ('/rest/v1/accounts', '/graphql/v1', '/storage/v1/bucket',
                 '/realtime/v1/', '/functions/v1', '/auth/v1evil', '/'):
        require(public_response(API + path)[0] == 403, f'Data-plane denial failed: {path}')
    require(public_response(API + '/auth/v1/verify')[0] == 400, 'Auth route unavailable')


def atomic_write(path, data, mode=0o600):
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def route_candidate(original, before, after, expected_digest):
    require(digest(original) == expected_digest, 'Live route changed since review')
    old = f'http://{valid_name(before)}:3000'.encode()
    new = f'http://{valid_name(after)}:3000'.encode()
    require(old != new and original.count(old) == 1 and new not in original,
            'Expected exactly one unambiguous dashboard backend replacement')
    return original.replace(old, new)


def start(args):
    valid_sha(args.sha)
    valid_sha(args.approved_trading_sha)
    valid_name(args.name)
    source = container(args.source)
    image = docker('GET', f'/images/{args.image}/json')
    require(image['Config'].get('Labels', {}).get('org.opencontainers.image.revision') == args.sha,
            'Image does not bind expected source SHA')
    require(docker('GET', f'/containers/{args.name}/json', missing_ok=True) is None,
            'Target container already exists; will not replace it implicitly')
    source_env = dict(item.split('=', 1) for item in source['Config']['Env'] if '=' in item)
    env = {key: source_env[key] for key in CARRY if source_env.get(key)}
    env.setdefault('PRODUCTION_ACCOUNT_MODE', 'paper')
    require(all(key in env for key in CARRY if key not in OPTIONAL),
            'Required source environment variable is absent')
    require(env['GITHUB_REPO'] == 'DanilaAnikin/nate_trader', 'Unexpected repository binding')
    require(env['PRODUCTION_ACCOUNT_MODE'] in ('paper', 'live'), 'Invalid production account mode')
    require(env['SUPABASE_SERVER_URL'] == 'http://natetrader-supabase-kong:8000',
            'Unexpected internal Supabase origin')
    env['PRODUCTION_RELEASE_SHA'] = args.approved_trading_sha
    env['DASHBOARD_MAINTENANCE_MODE'] = args.freeze
    # Pass values only in memory, never in command arguments, files or output.
    docker('POST', f'/containers/create?name={args.name}', {
        'Image': image['Id'], 'Env': [f'{key}={value}' for key, value in env.items()],
        'HostConfig': {'NetworkMode': NETWORK,
                       'RestartPolicy': {'Name': 'unless-stopped'},
                       'Ulimits': [{'Name': 'core', 'Soft': 0, 'Hard': 0}],
                       'SecurityOpt': ['no-new-privileges:true'], 'CapDrop': ['ALL'],
                       'LogConfig': {'Type': 'json-file', 'Config': {'max-size': '10m', 'max-file': '3'}}},
    })
    docker('POST', f'/containers/{args.name}/start')
    deadline = time.monotonic() + 60
    while True:
        try:
            internal_probe(args.name, args.sha, args.freeze == 'on')
            break
        except (Refusal, subprocess.TimeoutExpired):
            if time.monotonic() >= deadline:
                # Only the newly created unserved container is stopped.
                docker('POST', f'/containers/{args.name}/stop?t=10')
                raise Refusal('Candidate readiness failed; new container stopped')
            time.sleep(1)
    print(json.dumps({'result': 'staged', 'container': args.name, 'sha': args.sha,
                      'image_id': image['Id'], 'freeze': args.freeze}))


def cutover(args):
    valid_sha(args.sha)
    freeze = args.freeze == 'on'
    internal_probe(args.to_container, args.sha, freeze)
    original = ROUTE.read_bytes()
    old_expect = EXPECT.read_bytes()
    candidate = route_candidate(original, args.from_container, args.to_container, args.route_sha256)
    old_container = container(args.from_container)
    old_sha = old_container['Config']['Labels']['org.opencontainers.image.revision']
    valid_sha(old_sha)
    record = STATE / (time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + args.sha[:12])
    record.mkdir(mode=0o700)
    atomic_write(record / 'route.before', original)
    atomic_write(record / 'expect.before', old_expect)
    atomic_write(record / 'route.after', candidate)
    atomic_write(record / 'release.json', json.dumps({
        'sha': args.sha, 'from': args.from_container, 'to': args.to_container,
        'old_sha': old_sha, 'route_before_sha256': digest(original),
        'route_after_sha256': digest(candidate), 'freeze': args.freeze,
    }, indent=2).encode())
    require(ROUTE.read_bytes() == original and EXPECT.read_bytes() == old_expect,
            'Route or monitor expectation changed before cutover')
    expected = (f'EXPECT_BUILD_SHA={args.sha}\nEXPECT_REST=denied\n'
                f'EXPECT_FREEZE={"frozen" if freeze else "thawed"}\n'
                f'EXPECT_DASHBOARD_CONTAINER={valid_name(args.to_container)}\n').encode()
    try:
        atomic_write(ROUTE, candidate)
        atomic_write(EXPECT, expected, 0o644)
        deadline = time.monotonic() + 60
        while True:
            try:
                public_probe(args.sha, freeze)
                break
            except (Refusal, OSError):
                if time.monotonic() >= deadline:
                    raise Refusal('Public acceptance timed out')
                time.sleep(2)
    except BaseException:
        require(ROUTE.read_bytes() in (original, candidate),
                'Concurrent route edit detected; refusing to overwrite it during rollback')
        require(EXPECT.read_bytes() in (old_expect, expected),
                'Concurrent monitor edit detected; refusing to overwrite it during rollback')
        atomic_write(ROUTE, original)
        atomic_write(EXPECT, old_expect, 0o644)
        # This verdict attests restored configuration, not eventual propagation
        # through Traefik. The operator must verify the previous public build.
        atomic_write(record / 'verdict.json', b'{"result":"configuration_restored","public_rollback_verified":false}\n')
        raise
    atomic_write(record / 'verdict.json', b'{"result":"accepted"}\n')
    print(json.dumps({'result': 'accepted', 'sha': args.sha, 'container': args.to_container,
                      'evidence': str(record), 'previous_container_retained': True}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    staging = commands.add_parser('start')
    for name in ('name', 'source', 'image', 'sha', 'approved-trading-sha'):
        staging.add_argument('--' + name, required=True)
    staging.add_argument('--freeze', choices=('on', 'off'), required=True)
    activation = commands.add_parser('cutover')
    for name in ('from-container', 'to-container', 'sha', 'route-sha256'):
        activation.add_argument('--' + name, required=True)
    activation.add_argument('--freeze', choices=('on', 'off'), required=True)
    args = parser.parse_args()
    require(os.geteuid() == 0, 'Run as root on the deployment host')
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (STATE / '.lock').open('a') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        (start if args.command == 'start' else cutover)(args)


if __name__ == '__main__':
    try:
        main()
    except (Refusal, OSError, KeyError, ValueError, subprocess.TimeoutExpired) as error:
        # Never echo arbitrary Docker/environment/HTTP payloads.
        print(json.dumps({'result': 'refused', 'reason': str(error) if isinstance(error, Refusal)
                          else type(error).__name__}))
        raise SystemExit(1)
