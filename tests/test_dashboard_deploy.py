"""Deployment boundary tests: real atomic files, simulated host/HTTP failures."""
import argparse
import importlib.util
import io
import json
from pathlib import Path

import pytest


spec = importlib.util.spec_from_file_location(
    'dashboard_deploy', Path(__file__).resolve().parents[1] / 'ops/deploy_dashboard.py'
)
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
OLD = 'natetrader-dashboard-bridge'
NEW = 'natetrader-dashboard-abcdef012345'
SHA = 'a' * 40
ORIGINAL = (b'auth: keep-auth-only\nrest: denied\n'
            b'url: "http://natetrader-dashboard-bridge:3000"\n')


def test_public_probe_identifies_itself_to_the_production_edge(monkeypatch):
    def edge(request, timeout):
        assert request.get_header('User-agent') == 'NateTrader-Deployment/1.0'
        response = io.BytesIO(b'{"ok":true}')
        response.status = 200
        return response
    monkeypatch.setattr(deploy.urllib.request, 'urlopen', edge)
    assert deploy.public_response(deploy.DASHBOARD + '/api/health') == (200, b'{"ok":true}')


def test_route_change_preserves_every_other_byte_and_refuses_ambiguity():
    candidate = deploy.route_candidate(ORIGINAL, OLD, NEW, deploy.digest(ORIGINAL))
    assert candidate.replace(NEW.encode(), OLD.encode()) == ORIGINAL
    with pytest.raises(deploy.Refusal, match='changed since review'):
        deploy.route_candidate(ORIGINAL + b'edited', OLD, NEW, deploy.digest(ORIGINAL))
    with pytest.raises(deploy.Refusal, match='exactly one'):
        deploy.route_candidate(ORIGINAL * 2, OLD, NEW, deploy.digest(ORIGINAL * 2))
    with pytest.raises(deploy.Refusal):
        deploy.route_candidate(ORIGINAL, OLD, '../foreign-container', deploy.digest(ORIGINAL))


@pytest.fixture
def cutover(monkeypatch, tmp_path):
    state = tmp_path / 'records'
    state.mkdir()
    route, expectation = tmp_path / 'route.yml', tmp_path / 'expect'
    route.write_bytes(ORIGINAL)
    expectation.write_bytes(b'previous monitor state\n')
    monkeypatch.setattr(deploy, 'STATE', state)
    monkeypatch.setattr(deploy, 'ROUTE', route)
    monkeypatch.setattr(deploy, 'EXPECT', expectation)
    monkeypatch.setattr(deploy, 'internal_probe', lambda *args: None)
    monkeypatch.setattr(deploy, 'container', lambda name: {
        'Config': {'Labels': {'org.opencontainers.image.revision': 'b' * 40}}
    })
    args = argparse.Namespace(sha=SHA, freeze='off', from_container=OLD,
                              to_container=NEW, route_sha256=deploy.digest(ORIGINAL))
    return args, route, expectation, state


def test_cutover_retains_rollback_material_and_updates_monitor(cutover, monkeypatch):
    args, route, expectation, state = cutover
    monkeypatch.setattr(deploy, 'public_probe', lambda *args: None)
    deploy.cutover(args)
    assert NEW.encode() in route.read_bytes()
    assert b'EXPECT_FREEZE=thawed' in expectation.read_bytes()
    record = next(state.iterdir())
    assert (record / 'route.before').read_bytes() == ORIGINAL
    assert json.loads((record / 'verdict.json').read_text())['result'] == 'accepted'


def test_failed_public_acceptance_restores_route_and_monitor(cutover, monkeypatch):
    args, route, expectation, state = cutover
    def fail(*_):
        raise deploy.Refusal('public target unhealthy')
    ticks = iter([0, 100])
    monkeypatch.setattr(deploy.time, 'monotonic', lambda: next(ticks))
    monkeypatch.setattr(deploy, 'public_probe', fail)
    with pytest.raises(deploy.Refusal, match='timed out'):
        deploy.cutover(args)
    assert route.read_bytes() == ORIGINAL
    assert expectation.read_bytes() == b'previous monitor state\n'
    record = next(state.iterdir())
    assert json.loads((record / 'verdict.json').read_text()) == {
        'result': 'configuration_restored', 'public_rollback_verified': False
    }


def test_rollback_does_not_destroy_a_concurrent_operator_edit(cutover, monkeypatch):
    args, route, _, _ = cutover
    concurrent = b'different operator route\n'
    def concurrent_change(*_):
        route.write_bytes(concurrent)
        raise KeyboardInterrupt
    monkeypatch.setattr(deploy, 'public_probe', concurrent_change)
    with pytest.raises(deploy.Refusal, match='Concurrent route edit'):
        deploy.cutover(args)
    assert route.read_bytes() == concurrent


def test_rollback_does_not_destroy_a_concurrent_monitor_edit(cutover, monkeypatch):
    args, _, expectation, _ = cutover
    concurrent = b'new operator monitor expectation\n'
    def concurrent_change(*_):
        expectation.write_bytes(concurrent)
        raise KeyboardInterrupt
    monkeypatch.setattr(deploy, 'public_probe', concurrent_change)
    with pytest.raises(deploy.Refusal, match='Concurrent monitor edit'):
        deploy.cutover(args)
    assert expectation.read_bytes() == concurrent


@pytest.mark.parametrize('handoff_pin', [None, 'd' * 64])
def test_stage_copies_only_needed_env_in_memory_and_never_prints_it(monkeypatch, capsys, handoff_pin):
    env = {key: 'private-value' for key in deploy.CARRY}
    env.update(GITHUB_REPO='DanilaAnikin/nate_trader', PRODUCTION_ACCOUNT_MODE='paper',
               SUPABASE_SERVER_URL='http://natetrader-supabase-kong:8000',
               ALPACA_API_KEY='must-not-reach-dashboard', BUILD_SHA='untrusted-source-value',
               V11_EPOCH_BASELINE='{"multiline":\ntrue}',
               PAPER_RUNTIME_HANDOFF_SHA256='obsolete-pin-must-not-be-inherited')
    monkeypatch.setattr(deploy, 'container', lambda name: {
        'Config': {'Env': [f'{key}={value}' for key, value in env.items()]}
    })
    calls = []
    def fake_docker(method, path, payload=None, **kwargs):
        calls.append((method, path, payload))
        if path.startswith('/images/'):
            return {'Id': 'sha256:immutable', 'Config': {
                'Labels': {'org.opencontainers.image.revision': SHA}}}
        return None
    monkeypatch.setattr(deploy, 'docker', fake_docker)
    monkeypatch.setattr(deploy, 'internal_probe', lambda *args: None)
    deploy.start(argparse.Namespace(sha=SHA, approved_trading_sha='c' * 40,
                                   name=NEW, source=OLD, image='image', freeze='on',
                                   paper_handoff_sha256=handoff_pin))
    payload = next(body for method, path, body in calls if path.startswith('/containers/create'))
    copied = dict(value.split('=', 1) for value in payload['Env'])
    assert 'ALPACA_API_KEY' not in copied and 'BUILD_SHA' not in copied
    assert copied['PRODUCTION_RELEASE_SHA'] == 'c' * 40
    assert copied['DASHBOARD_MAINTENANCE_MODE'] == 'on'
    assert copied['V11_EPOCH_BASELINE'] == env['V11_EPOCH_BASELINE']
    assert copied.get('PAPER_RUNTIME_HANDOFF_SHA256') == handoff_pin
    assert payload['Image'] == 'sha256:immutable'
    assert 'PortBindings' not in payload['HostConfig']
    output = capsys.readouterr().out
    assert 'private-value' not in output and 'must-not-reach-dashboard' not in output


@pytest.mark.parametrize('pin', ['', 'not-a-hash', 'd' * 63, 'D' * 64, 'd' * 65])
def test_invalid_handoff_pin_is_rejected_before_docker_access(monkeypatch, pin):
    monkeypatch.setattr(deploy, 'container', lambda *_: pytest.fail('unexpected Docker access'))
    with pytest.raises(deploy.Refusal, match='manifest SHA-256'):
        deploy.start(argparse.Namespace(sha=SHA, approved_trading_sha='c' * 40,
                                       paper_handoff_sha256=pin))


def test_paper_handoff_pin_cannot_be_attached_to_live_account(monkeypatch):
    env = {key: 'private-value' for key in deploy.CARRY}
    env.update(GITHUB_REPO='DanilaAnikin/nate_trader', PRODUCTION_ACCOUNT_MODE='live',
               SUPABASE_SERVER_URL='http://natetrader-supabase-kong:8000')
    monkeypatch.setattr(deploy, 'container', lambda _: {
        'Config': {'Env': [f'{key}={value}' for key, value in env.items()]}
    })
    def read_only_docker(method, path, **_):
        assert method == 'GET'
        return {'Id': 'sha256:immutable', 'Config': {
            'Labels': {'org.opencontainers.image.revision': SHA}}} if path.startswith('/images/') else None
    monkeypatch.setattr(deploy, 'docker', read_only_docker)
    with pytest.raises(deploy.Refusal, match='cannot authorize a live account'):
        deploy.start(argparse.Namespace(sha=SHA, approved_trading_sha='c' * 40,
                                       name=NEW, source=OLD, image='image', freeze='on',
                                       paper_handoff_sha256='d' * 64))


def test_stage_missing_config_cannot_create_container(monkeypatch):
    monkeypatch.setattr(deploy, 'container', lambda name: {'Config': {'Env': []}})
    calls = []
    def fake_docker(method, path, **kwargs):
        calls.append(method)
        if path.startswith('/images/'):
            return {'Id': 'sha256:image', 'Config': {
                'Labels': {'org.opencontainers.image.revision': SHA}}}
        return None
    monkeypatch.setattr(deploy, 'docker', fake_docker)
    with pytest.raises(deploy.Refusal, match='environment variable is absent'):
        deploy.start(argparse.Namespace(sha=SHA, approved_trading_sha='c' * 40,
                                       name=NEW, source=OLD, image='image', freeze='on'))
    assert 'POST' not in calls


@pytest.mark.parametrize('bad_status', [200, 401, 404, 500, 502, 503])
def test_public_probe_requires_actual_403_denial(monkeypatch, bad_status):
    def response(url, method='GET'):
        if url.endswith('/api/health'):
            return 200, json.dumps({'buildSha': SHA, 'writes_enabled': True}).encode()
        if url.endswith('/login'):
            return 200, b''
        if url.startswith(deploy.DASHBOARD):
            return 401, b''
        return bad_status, b''
    monkeypatch.setattr(deploy, 'public_response', response)
    with pytest.raises(deploy.Refusal, match='Data-plane denial failed'):
        deploy.public_probe(SHA, False)
