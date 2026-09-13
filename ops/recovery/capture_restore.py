#!/usr/bin/env python3
"""Explicit one-shot Nate recovery capture and isolated restore.

Run as root on the authorized homelab. Production is accessed only by SELECT,
pg_dump, pg_dumpall and reading its existing config/key. Secrets and restored
data stay on a dedicated noswap tmpfs. Only authenticated ciphertext, this
source, a public manifest and a redacted verdict survive on disk.

This is a distinct cutover protocol, not an implementation of the old V2
COMPLETE semantics. It deliberately does not update the old last-success state.
The successful clone remains available for a separately authorized rehearsal.
"""
import argparse
import collections
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import select
import shutil
import subprocess
import sys
import tarfile
import time

SOURCE = "natetrader-supabase-db-1"
KEY_DB = Path("/srv/homelab/secrets/nt-v2-db-key.txt")
KEY_ROOT = Path("/srv/homelab/secrets/nt-v2-rootkey-key.txt")
RCLONE_CONFIG = "/srv/homelab/secrets/rclone.conf"
REMOTES = ("r2:homelab-backups", "r2dr:homelab-backups-dr")
ROOT_PATH = "/etc/postgresql-custom/pgsodium_root.key"


class Failure(Exception):
    pass


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def sql_literal(value):
    return "'" + value.replace("'", "''") + "'"


def ident(value):
    return '"' + value.replace('"', '""') + '"'


class Recovery:
    def __init__(self, upload, existing_set=None):
        os.umask(0o077)
        if os.geteuid() != 0:
            raise Failure("root_required")
        self.set_id = "nt-cutover-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self.work = Path("/run") / self.set_id
        self.durable = Path("/var/lib/homelab/nt-cutover-recovery") / self.set_id
        self.clone = self.set_id + "-db"
        self.upload = upload
        self.existing_set = Path(existing_set) if existing_set else None
        self.seq = 0
        self.stage = "preconditions"
        self.snapshot_process = None
        self.env = os.environ.copy()
        self.checks = {}
        self.manifest = {"protocol": "nate-cutover-recovery-v1", "set_id": self.set_id,
                         "source_container": SOURCE, "components": {}}

    def event(self, stage, **metadata):
        self.stage = stage
        print(json.dumps({"stage": stage, "set_id": self.set_id, **metadata}), flush=True)

    def run(self, label, args, *, data=None, output=None, timeout=180, ok=(0,)):
        self.seq += 1
        errpath = self.work / ("diagnostic-%04d.txt" % self.seq)
        with errpath.open("wb") as err:
            if output is None:
                result = subprocess.run(args, input=data, stdout=subprocess.PIPE,
                                        stderr=err, timeout=timeout, env=self.env)
            else:
                with Path(output).open("wb") as out:
                    result = subprocess.run(args, input=data, stdout=out,
                                            stderr=err, timeout=timeout, env=self.env)
        if result.returncode not in ok:
            raise Failure(f"{label}:exit_{result.returncode}:private_diagnostic_{self.seq}")
        return result

    def sql(self, container, sql, db="postgres", role="supabase_admin", *, output=None, ok=(0,)):
        return self.run("sql", ["docker", "exec", "-i", container, "psql", "-X", "-w", "-qAt",
                               "-v", "ON_ERROR_STOP=1", "-U", role, "-d", db],
                        data=sql.encode(), output=output, ok=ok)

    def setup(self):
        # tmpfs noswap protects files; the process cgroup protects Python/GPG
        # buffers and child processes. Invoke under systemd-run --scope with
        # MemorySwapMax=0. Container process memory has its own no-swap limit.
        group = next((line.split(':', 2)[2] for line in Path('/proc/self/cgroup').read_text().splitlines()
                      if line.startswith('0::')), None)
        if group is None or (Path('/sys/fs/cgroup') / group.lstrip('/') / 'memory.swap.max').read_text().strip() != '0':
            raise Failure('process_cgroup_swap_must_be_disabled')
        for p in (KEY_DB, KEY_ROOT):
            if not p.is_file() or p.is_symlink() or p.stat().st_mode & 0o777 != 0o600:
                raise Failure("backup_key_missing_or_mode_not_0600")
        if KEY_DB.read_bytes() == KEY_ROOT.read_bytes():
            raise Failure("encryption_key_separation_violated")
        self.work.mkdir(mode=0o700)
        # noswap is mandatory even if the host happens to have free RAM today.
        result = subprocess.run(["mount", "-t", "tmpfs", "-o",
                                 "size=4G,mode=0700,noswap,nosuid,nodev", "tmpfs", str(self.work)],
                                capture_output=True)
        if result.returncode:
            self.work.rmdir()
            raise Failure("noswap_tmpfs_mount_failed")
        mount = self.run("findmnt", ["findmnt", "-n", "-o", "FSTYPE,OPTIONS", "-T", str(self.work)]).stdout.decode().strip()
        if not mount.startswith("tmpfs ") or "noswap" not in mount.split(","):
            raise Failure("noswap_tmpfs_not_verified")
        for d in ("gnupg", "data", "cfg", "basecfg", "scratch", "quarantine"):
            (self.work / d).mkdir(mode=0o700)
        (self.work / "scratch").chmod(0o1777)
        self.env.update(GNUPGHOME=str(self.work / "gnupg"), TMPDIR=str(self.work / "scratch"))
        opts = self.run("gpg_options", ["gpg", "--dump-options"]).stdout.decode().splitlines()
        if "--force-ocb" not in opts:
            raise Failure("gpg_ocb_unavailable")
        self.durable.mkdir(parents=True, mode=0o700)
        for name in ("capture_restore.py", "nt-catalogue.sql"):
            shutil.copyfile(Path(__file__).with_name(name), self.durable / name)
        self.manifest["source_sha256"] = sha(Path(__file__))
        self.manifest["catalogue_sql_sha256"] = sha(Path(__file__).with_name("nt-catalogue.sql"))
        if self.existing_set:
            marker = json.loads((self.existing_set / 'COMPLETE').read_text())
            if marker['manifest_sha256'] != sha(self.existing_set / 'MANIFEST.json') or marker['verdict_sha256'] != sha(self.existing_set / 'VERDICT.json'):
                raise Failure('existing_set_completion_digest_mismatch')
            self.original_manifest = json.loads((self.existing_set / 'MANIFEST.json').read_text())
            verdict = json.loads((self.existing_set / 'VERDICT.json').read_text())
            if verdict.get('status') != 'VERIFIED' or not verdict.get('checks') or not all(verdict['checks'].values()):
                raise Failure('existing_set_not_verified')
            self.image = self.original_manifest['image_id']
            if not re.fullmatch(r'sha256:[0-9a-f]{64}', self.image):
                raise Failure('existing_set_image_id_invalid')
        else:
            inspect = json.loads(self.run("source_inspect", ["docker", "inspect", SOURCE]).stdout)[0]
            if not inspect["State"]["Running"]:
                raise Failure("source_not_running")
            self.image = inspect["Image"]
        self.manifest["image_id"] = self.image
        self.event("preconditions_verified", noswap=True, image_id=self.image,
                   work=str(self.work), durable=str(self.durable))

    def load_existing(self):
        """Recover solely from a verified encrypted set; never contact production."""
        self.event('load_existing_verified_set')
        required = {'db.dump.gpg', 'globals.sql.gpg', 'dbconfig.tar.gz.gpg', 'baseconfig.tar.gz.gpg',
                    'rootkey.bin.gpg', 'supplemental.sql.gpg', 'verification.json.gpg'}
        if set(self.original_manifest['components']) != required:
            raise Failure('existing_set_component_allowlist_mismatch')
        for name, binding in self.original_manifest['components'].items():
            source = self.existing_set / name
            if source.is_symlink() or sha(source) != binding['sha256'] or source.stat().st_size != binding['bytes']:
                raise Failure('existing_ciphertext_binding_mismatch')
            if not self.is_ocb(source):
                raise Failure('existing_ciphertext_not_ocb')
            shutil.copyfile(source, self.durable / name)
        # No consumer receives decrypted metadata until the cipher returns success.
        private_path = self.work / 'verification.json'
        self.gpg(self.durable / 'verification.json.gpg', KEY_DB, private_path, decrypt=True)
        private = json.loads(private_path.read_text())
        for name in sorted(required - {'verification.json.gpg'}):
            plain_name = name[:-4]
            q = self.work / 'quarantine' / plain_name
            self.gpg(self.durable / name, KEY_ROOT if name == 'rootkey.bin.gpg' else KEY_DB, q, decrypt=True)
            if sha(q) != private['plaintext_sha256'][plain_name]:
                q.unlink()
                raise Failure('existing_plaintext_binding_mismatch')
            q.replace(self.work / plain_name)
        self.mac_key = private['mac_key']
        self.tables = private['tables']
        self.rows = private['row_commitments']
        self.vault = private['vault_commitment']
        self.root_owner = tuple(private['root_owner'])
        self.source_catalogue = private['source_catalogue']
        self.database_acl = private['database_acl']
        self.manifest['components'] = self.original_manifest['components']
        self.manifest['restored_from_set'] = self.original_manifest['set_id']
        self.manifest['original_manifest_sha256'] = sha(self.existing_set / 'MANIFEST.json')
        (self.durable / 'MANIFEST.json').write_text(json.dumps(self.manifest, indent=2, sort_keys=True) + '\n')
        self.checks['existing_set_authenticated_without_production'] = True

    def begin_snapshot(self):
        self.snapshot_error = (self.work / "snapshot-diagnostic.txt").open("wb")
        self.snapshot_process = subprocess.Popen(
            ["docker", "exec", "-i", SOURCE, "psql", "-X", "-w", "-qAt", "-v", "ON_ERROR_STOP=1",
             "-U", "supabase_admin", "-d", "postgres"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=self.snapshot_error, env=self.env)
        self.snapshot_process.stdin.write(
            b"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n"
            b"SET LOCAL idle_in_transaction_session_timeout='10min';\nSELECT pg_export_snapshot();\n")
        self.snapshot_process.stdin.flush()
        if not select.select([self.snapshot_process.stdout], [], [], 15)[0]:
            raise Failure("snapshot_timeout")
        self.snapshot = self.snapshot_process.stdout.readline().decode().strip()
        if not re.fullmatch(r"[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+", self.snapshot):
            raise Failure("snapshot_invalid")

    def snapshot_sql(self, body):
        return ("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET TRANSACTION SNAPSHOT "
                + sql_literal(self.snapshot) + ";\n" + body + "\nROLLBACK;\n")

    def end_snapshot(self):
        if self.snapshot_process is not None:
            p = self.snapshot_process
            self.snapshot_process = None
            try:
                p.communicate(b"ROLLBACK;\n", timeout=15)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                p.kill()
                p.wait()
                raise Failure("snapshot_close_failed")
            finally:
                self.snapshot_error.close()
            if p.returncode:
                raise Failure("snapshot_session_failed")

    def catalogue(self, container, filename, snapshot=False):
        body = "\\set ntv_pw_salt " + self.mac_key + "\n" + Path(__file__).with_name("nt-catalogue.sql").read_text()
        if snapshot:
            body = self.snapshot_sql(body)
        else:
            body = "BEGIN READ ONLY;\n" + body + "\nROLLBACK;\n"
        self.sql(container, body, output=self.work / filename)
        lines = (self.work / filename).read_text().splitlines()
        if len(lines) < 100 or any(not re.match(r"^[a-z]+\|", line) for line in lines):
            raise Failure("catalogue_empty_or_malformed")
        return lines

    def row_commitments(self, container, tables, snapshot=False):
        statements = []
        for schema, name in tables:
            statements.append("SELECT json_build_object('table'," + sql_literal(schema + "." + name)
                + ",'rows',count(*),'digest',encode(extensions.hmac("
                + "coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),''),"
                + sql_literal(self.mac_key) + ",'sha256'),'hex')) FROM " + ident(schema) + "." + ident(name) + " t;")
        body = "\n".join(statements)
        if snapshot:
            body = self.snapshot_sql(body)
        else:
            body = "BEGIN READ ONLY;\n" + body + "\nROLLBACK;\n"
        output = self.sql(container, body).stdout.decode().splitlines()
        if len(output) != len(tables):
            raise Failure("row_commitment_count_mismatch")
        return [json.loads(line) for line in output]

    def vault_commitment(self, container, snapshot=False, expect_failure=False):
        body = ("SELECT json_build_object('rows',count(*),'digest',encode(extensions.hmac("
                "coalesce(string_agg(id::text||':'||decrypted_secret,E'\\n' ORDER BY id),''),"
                + sql_literal(self.mac_key) + ",'sha256'),'hex')) FROM vault.decrypted_secrets;")
        body = self.snapshot_sql(body) if snapshot else "BEGIN READ ONLY;\n" + body + "\nROLLBACK;\n"
        r = self.sql(container, body, ok=(0, 3) if expect_failure else (0,))
        if expect_failure:
            diagnostic = (self.work / ("diagnostic-%04d.txt" % self.seq)).read_text()
            # Reject failures at connection/SQL setup: the negative must reach decryption.
            return r.returncode == 3 and bool(re.search(r"invalid ciphertext|decryption failed|invalid (?:mac|nonce)|crypto.*decrypt", diagnostic, re.I))
        return json.loads(r.stdout)

    def capture(self):
        self.event("capture_snapshot")
        self.mac_key = secrets.token_hex(32)
        self.begin_snapshot()
        try:
            self.run("pg_dump", ["docker", "exec", SOURCE, "pg_dump", "-U", "supabase_admin",
                                  "-Fc", "-Z6", "--snapshot=" + self.snapshot, "postgres"],
                     output=self.work / "db.dump")
            if (self.work / "db.dump").stat().st_size < 1024:
                raise Failure("archive_implausibly_small")
            self.source_catalogue = self.catalogue(SOURCE, "source-catalogue.txt", snapshot=True)
            table_sql = "SELECT json_build_array(n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%' ORDER BY n.nspname,c.relname;"
            self.tables = [json.loads(line) for line in self.sql(SOURCE, self.snapshot_sql(table_sql)).stdout.decode().splitlines()]
            self.rows = self.row_commitments(SOURCE, self.tables, snapshot=True)
            self.vault = self.vault_commitment(SOURCE, snapshot=True)
            acl_sql = "SELECT CASE WHEN grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(grantee)) END,privilege_type,is_grantable FROM pg_database d CROSS JOIN LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) WHERE datname=current_database() ORDER BY 1,2;"
            self.database_acl = self.sql(SOURCE, self.snapshot_sql(acl_sql)).stdout.decode().splitlines()
            # pg_dump without --create omits database metadata; extension members
            # may also carry platform changes omitted from CREATE EXTENSION dumps.
            # These reviewed statements are captured into the encrypted set, never
            # reconstructed from live production during restoration.
            supplement = r"""
SELECT format('ALTER DATABASE postgres OWNER TO %I;',pg_get_userbyid(datdba)) FROM pg_database WHERE datname=current_database();
SELECT format('ALTER %s SET %I TO %L;',CASE WHEN s.setrole=0 THEN 'DATABASE postgres' ELSE format('ROLE %I IN DATABASE postgres',pg_get_userbyid(s.setrole)) END,split_part(setting,'=',1),substring(setting FROM position('=' IN setting)+1))
FROM pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) setting WHERE s.setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database()) ORDER BY s.setrole,setting;
SELECT format('SET ROLE %I; GRANT %s ON DATABASE postgres TO %s%s; RESET ROLE;',pg_get_userbyid(a.grantor),a.privilege_type,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END,CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END)
FROM pg_database d CROSS JOIN LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a WHERE d.datname=current_database() ORDER BY a.grantee,a.privilege_type;
SELECT format('SET ROLE %I; GRANT %s ON SCHEMA %I TO %s%s; RESET ROLE;',pg_get_userbyid(a.grantor),a.privilege_type,n.nspname,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END,CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END)
FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a WHERE n.nspname IN ('graphql','graphql_public') ORDER BY n.nspname,a.grantee,a.privilege_type;
SELECT pg_get_functiondef(p.oid)||';' FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='net' AND p.proname IN ('http_get','http_post') ORDER BY p.proname,p.oid;
SELECT format('SET ROLE %I; GRANT %s ON FUNCTION %I.%I(%s) TO %s%s; RESET ROLE;',pg_get_userbyid(a.grantor),a.privilege_type,n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END,CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END)
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE n.nspname='net' AND p.proname IN ('http_get','http_post') ORDER BY p.proname,a.grantee,a.privilege_type;
"""
            self.sql(SOURCE, self.snapshot_sql(supplement), output=self.work / 'supplemental.sql')
        finally:
            self.end_snapshot()
        self.run("globals_capture", ["docker", "exec", SOURCE, "pg_dumpall", "-U", "supabase_admin", "--globals-only"],
                 output=self.work / "globals.sql")
        self.run("config_capture", ["docker", "exec", SOURCE, "tar", "-czf", "-", "-C", "/etc/postgresql-custom",
                                    "--exclude=pgsodium_root.key", "."], output=self.work / "dbconfig.tar.gz")
        self.run("base_config_capture", ["docker", "exec", SOURCE, "tar", "-czf", "-", "-C", "/etc/postgresql", "."],
                 output=self.work / "baseconfig.tar.gz")
        root_stat = self.run("root_key_metadata", ["docker", "exec", SOURCE, "stat", "-c", "%a %u %g %F", ROOT_PATH]).stdout.decode().split()
        if root_stat[0] != "600" or " ".join(root_stat[3:]) != "regular file":
            raise Failure("root_key_unsafe_metadata")
        self.root_owner = (int(root_stat[1]), int(root_stat[2]))
        self.run("root_key_capture", ["docker", "exec", SOURCE, "cat", ROOT_PATH], output=self.work / "rootkey.bin")
        if not re.fullmatch(rb"[0-9a-f]{64}\n?", (self.work / "rootkey.bin").read_bytes()):
            raise Failure("root_key_invalid_format")
        source_hash = self.run("root_key_digest", ["docker", "exec", SOURCE, "sha256sum", ROOT_PATH]).stdout.decode().split()[0]
        if source_hash != sha(self.work / "rootkey.bin"):
            raise Failure("root_key_capture_digest_mismatch")
        private = {"mac_key": self.mac_key, "tables": self.tables, "row_commitments": self.rows,
                   "vault_commitment": self.vault, "root_owner": self.root_owner,
                   "database_acl": self.database_acl,
                   "source_catalogue": self.source_catalogue,
                   "plaintext_sha256": {p: sha(self.work / p) for p in ("db.dump", "globals.sql", "dbconfig.tar.gz", "baseconfig.tar.gz", "rootkey.bin", "supplemental.sql")}}
        (self.work / "verification.json").write_text(json.dumps(private, sort_keys=True))
        self.checks["source_snapshot_capture"] = True
        self.event("capture_complete", archive_bytes=(self.work / "db.dump").stat().st_size,
                   captured_table_count=len(self.tables))

    def gpg(self, ciphertext, key, output, decrypt=False, ok=(0,)):
        args = ["gpg", "--batch", "--yes", "--quiet", "--no-tty", "--pinentry-mode", "loopback",
                "--no-symkey-cache", "--passphrase-file", str(key), "-o", str(output)]
        if decrypt:
            args += ["--decrypt", str(ciphertext)]
        else:
            args += ["--symmetric", "--cipher-algo", "AES256", "--force-ocb", "--s2k-mode", "3",
                     "--s2k-digest-algo", "SHA512", "--s2k-count", "65011712", str(ciphertext)]
        return self.run("gpg", args, ok=ok)

    @staticmethod
    def is_ocb(path):
        with open(path, "rb") as f:
            header = f.read(2)
            if len(header) != 2 or header[0] != 0x8C:
                return False
            f.seek(2 + header[1])
            return f.read(1) == b"\xd4"

    def encrypt_and_validate(self):
        self.event("encrypt_and_negative_controls")
        for name in ("db.dump", "globals.sql", "dbconfig.tar.gz", "baseconfig.tar.gz", "rootkey.bin", "supplemental.sql", "verification.json"):
            key = KEY_ROOT if name == "rootkey.bin" else KEY_DB
            plain = self.work / name
            ciphertext = self.durable / (name + ".gpg")
            quarantine = self.work / "quarantine" / name
            self.gpg(plain, key, ciphertext)
            if not self.is_ocb(ciphertext):
                raise Failure("ciphertext_not_ocb")
            self.gpg(ciphertext, key, quarantine, decrypt=True)
            if sha(quarantine) != sha(plain) or quarantine.stat().st_size != plain.stat().st_size:
                raise Failure("authenticated_roundtrip_mismatch")
            # The restore consumes decrypted archive bytes, not the capture originals.
            quarantine.replace(plain)
            self.manifest["components"][name + ".gpg"] = {"sha256": sha(ciphertext), "bytes": ciphertext.stat().st_size,
                                                               "key": "root" if name == "rootkey.bin" else "db"}
        # A corruption must be rejected by gpg itself, before a consumer is allowed to see the output.
        original = self.durable / "db.dump.gpg"
        corrupt = self.work / "corrupt.gpg"
        payload = bytearray(original.read_bytes())
        payload[-8] ^= 1
        corrupt.write_bytes(payload)
        for label, source, key in (("corrupt_tag_rejected", corrupt, KEY_DB),
                                   ("wrong_root_passphrase_rejected", self.durable / "rootkey.bin.gpg", KEY_DB)):
            q = self.work / "quarantine" / "negative"
            result = self.gpg(source, key, q, decrypt=True, ok=(0, 2))
            q.unlink(missing_ok=True)
            if result.returncode != 2:
                raise Failure(label + "_failed")
            self.checks[label] = True
        self.checks["ocb_authenticated_roundtrip"] = True
        self.manifest["captured_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
        (self.durable / "MANIFEST.json").write_text(json.dumps(self.manifest, indent=2, sort_keys=True) + "\n")

    def provision(self):
        self.event("provision_isolated_clone")
        # Config is restored only from authenticated, round-tripped archive bytes.
        for component, target in (("dbconfig.tar.gz", "cfg"), ("baseconfig.tar.gz", "basecfg")):
            with tarfile.open(self.work / component) as archive:
                for item in archive.getmembers():
                    path = Path(item.name)
                    if path.is_absolute() or ".." in path.parts or item.issym() or item.islnk():
                        raise Failure("config_archive_unsafe_member")
                archive.extractall(self.work / target, filter="data")
            # Python's data filter intentionally drops directory metadata. The
            # containing host workdir stays 0700; the DB UID must traverse its bind mounts.
            for directory in [self.work / target, *(p for p in (self.work / target).rglob('*') if p.is_dir())]:
                directory.chmod(0o755)
        for required in ("postgresql.conf", "pg_hba.conf"):
            if not (self.work / "basecfg" / required).is_file():
                raise Failure("config_required_member_missing")
        root = self.work / "cfg" / "pgsodium_root.key"
        shutil.copyfile(self.work / "rootkey.bin", root)
        os.chown(root, *self.root_owner)
        root.chmod(0o600)
        envfile = self.work / "clone.env"
        envfile.write_text("POSTGRES_PASSWORD=" + secrets.token_hex(32) + "\n")
        args = ["docker", "run", "-d", "--name", self.clone, "--network", "none", "--log-driver", "none",
                "--memory", "1g", "--memory-swap", "1g",
                "--label", "nate.recovery.set=" + self.set_id, "--label", "nate.acceptance.clone=true", "--env-file", str(envfile),
                "--mount", "type=bind,src=" + str(self.work / "data") + ",dst=/var/lib/postgresql/data",
                "--mount", "type=bind,src=" + str(self.work / "cfg") + ",dst=/etc/postgresql-custom",
                "--mount", "type=bind,src=" + str(self.work / "basecfg") + ",dst=/etc/postgresql",
                "--mount", "type=bind,src=" + str(self.work / "scratch") + ",dst=/tmp",
                "--mount", "type=bind,src=" + str(self.work) + ",dst=/recovery,readonly",
                self.image]
        self.run("clone_create", args)
        self.wait_ready()
        info = json.loads(self.run("clone_inspect", ["docker", "inspect", self.clone]).stdout)[0]
        if info["HostConfig"]["NetworkMode"] != "none" or info["HostConfig"]["PortBindings"]:
            raise Failure("clone_network_isolation_failed")
        if info["HostConfig"]["LogConfig"]["Type"] != "none":
            raise Failure("clone_logs_not_disabled")
        if not info['HostConfig']['Memory'] or info['HostConfig']['MemorySwap'] != info['HostConfig']['Memory']:
            raise Failure('clone_process_swap_not_disabled')
        paths = json.loads(self.sql(self.clone, "SELECT json_build_object('data',current_setting('data_directory'),'log',current_setting('log_directory'),'collector',current_setting('logging_collector'),'temp',current_setting('temp_tablespaces'));").stdout)
        if paths['data'] != '/var/lib/postgresql/data' or paths['temp']:
            raise Failure("clone_data_or_temp_path_outside_tmpfs")
        if paths['collector'] != 'off' and Path(paths['log']).is_absolute() and not paths['log'].startswith('/var/lib/postgresql/data/'):
            raise Failure("clone_log_path_outside_tmpfs")
        self.checks["clone_network_none"] = True
        self.checks["clone_data_log_temp_paths_tmpfs"] = True
        self.checks['clone_process_swap_disabled'] = True

    def wait_ready(self):
        deadline = time.monotonic() + 240
        stable_start = None
        consecutive = 0
        while time.monotonic() < deadline:
            state = json.loads(self.run("clone_state", ["docker", "inspect", self.clone]).stdout)[0]['State']
            if not state['Running']:
                raise Failure("clone_exited_during_bootstrap")
            r = self.run("clone_ready", ["docker", "exec", self.clone, "psql", "-X", "-w", "-qAt", "-U", "supabase_admin", "-d", "postgres",
                                        "-c", "SELECT pg_postmaster_start_time() FROM pg_roles WHERE rolname='supabase_admin' AND rolsuper AND NOT pg_is_in_recovery() AND current_setting('server_version_num')='170006'"], ok=(0, 1, 2))
            tcp = self.run("clone_tcp_ready", ["docker", "exec", self.clone, "pg_isready", "-h", "127.0.0.1", "-q"], ok=(0, 1, 2))
            if r.returncode == 0 and r.stdout.strip() and tcp.returncode == 0:
                # The image's temporary init server is socket-only. Require TCP and
                # a stable postmaster through five independent semantic observations.
                current_start = r.stdout.strip()
                consecutive = consecutive + 1 if current_start == stable_start else 1
                stable_start = current_start
                if consecutive >= 5:
                    return
            else:
                consecutive = 0
            time.sleep(2)
        raise Failure("clone_bootstrap_timeout")

    def restore(self):
        self.event("strict_restore")
        # Exhaust the entire custom archive, then confirm a truncated archive fails the same parser.
        self.run("archive_full_consumption", ["docker", "exec", self.clone, "pg_restore", "--file=/dev/null", "/recovery/db.dump"])
        truncated = self.work / "halfdump"
        data = (self.work / "db.dump").read_bytes()
        truncated.write_bytes(data[:len(data) // 2])
        result = self.run("archive_truncation", ["docker", "exec", self.clone, "pg_restore", "--file=/dev/null", "/recovery/halfdump"], ok=(0, 1))
        truncated.unlink()
        if result.returncode != 1:
            raise Failure("truncated_archive_accepted")
        self.checks["truncated_archive_rejected"] = True
        src = (self.work / "globals.sql").read_text()
        lines = []
        for line in src.splitlines(keepends=True):
            match = re.fullmatch(r"CREATE ROLE ([a-zA-Z_][a-zA-Z0-9_]*);\s*", line)
            if match:
                role = match.group(1)
                line = ("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname=" + sql_literal(role)
                        + ") THEN CREATE ROLE " + ident(role) + "; END IF; END $$;\n")
            elif line.startswith("CREATE ROLE "):
                raise Failure("globals_role_name_requires_review")
            lines.append(line)
        self.sql(self.clone, "".join(lines))
        self.sql(self.clone, "CREATE DATABASE natetrader_restore OWNER supabase_admin TEMPLATE template0;")
        self.run("pg_restore", ["docker", "exec", self.clone, "pg_restore", "-U", "supabase_admin", "-d", "natetrader_restore",
                                "--exit-on-error", "/recovery/db.dump"])
        # Platform background workers can hold the bootstrap DB open. Disallow
        # new connections and terminate only that disposable database's sessions.
        self.sql(self.clone, "ALTER DATABASE postgres ALLOW_CONNECTIONS false;\nSELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='postgres';", db="template1")
        self.sql(self.clone, "ALTER DATABASE postgres RENAME TO recovery_bootstrap;\nALTER DATABASE natetrader_restore RENAME TO postgres;", db="template1")
        # pg_dump does not carry database ACLs without --create. Reconstruct the captured
        # source database ACL explicitly (metadata only) for the canonical target name.
        self.sql(self.clone, "REVOKE ALL ON DATABASE postgres FROM PUBLIC;\n" + (self.work / 'supplemental.sql').read_text())
        self.checks["strict_restore"] = True

    def verify(self):
        self.event("verify_restored_state")
        restored_rows = self.row_commitments(self.clone, self.tables)
        if restored_rows != self.rows:
            failures = [a["table"] for a, b in zip(self.rows, restored_rows) if a != b]
            raise Failure("restored_row_commitment_mismatch:" + ",".join(failures))
        if self.vault_commitment(self.clone) != self.vault:
            raise Failure("restored_vault_commitment_mismatch")
        clone_cat = self.catalogue(self.clone, "clone-catalogue.txt")
        if clone_cat != self.source_catalogue:
            src = set(self.source_catalogue)
            dst = set(clone_cat)
            domains = collections.Counter(line.split("|", 1)[0] for line in src.symmetric_difference(dst))
            raise Failure("restored_catalogue_mismatch_domains:" + json.dumps(dict(domains), sort_keys=True))
        self.checks.update(all_table_row_commitments_equal=True, vault_plaintext_commitment_equal=True,
                           security_catalogue_equal=True)
        self.event("wrong_root_key_negative_control")
        root = self.work / "cfg" / "pgsodium_root.key"
        root.write_text(secrets.token_hex(32))
        self.run("wrong_key_restart", ["docker", "restart", self.clone])
        self.wait_ready()
        wrong_key_rejected = self.vault_commitment(self.clone, expect_failure=True)
        shutil.copyfile(self.work / "rootkey.bin", root)
        os.chown(root, *self.root_owner)
        root.chmod(0o600)
        self.run("correct_key_restart", ["docker", "restart", self.clone])
        self.wait_ready()
        if not wrong_key_rejected:
            raise Failure("wrong_root_key_not_rejected_by_decryption")
        if self.vault_commitment(self.clone) != self.vault:
            raise Failure("vault_correct_key_recovery_failed")
        self.checks["wrong_root_key_rejected"] = True

    def publish(self):
        self.event("publish_verified_ciphertext")
        evidence = {"set_id": self.set_id, "status": "VERIFIED", "completed_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
                    "checks": self.checks, "clone": self.clone, "clone_database": "postgres", "clone_role": "supabase_admin",
                    "clone_network": "none", "tmpfs": str(self.work), "durable": str(self.durable),
                    "table_count": len(self.tables), "manifest_sha256": sha(self.durable / "MANIFEST.json")}
        (self.durable / "VERDICT.json").write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
        files = sorted(p for p in self.durable.iterdir() if p.is_file())
        if self.upload:
            prefix = "natetrader-cutover-recovery-v1/" + self.set_id
            rc = ["rclone", "--config", RCLONE_CONFIG, "--retries", "2", "--low-level-retries", "3", "--contimeout", "15s", "--timeout", "60s"]
            for index, remote in enumerate(REMOTES):
                for path in files:
                    dest = remote + "/" + prefix + "/" + path.name
                    self.run("remote_upload", rc + ["copyto", str(path), dest + ".part", "-q"], timeout=180)
                    download = self.work / "remote-roundtrip"
                    self.run("remote_download", rc + ["cat", dest + ".part"], output=download, timeout=180)
                    if sha(download) != sha(path) or download.stat().st_size != path.stat().st_size:
                        raise Failure("remote_ciphertext_roundtrip_mismatch")
                    self.run("remote_promote", rc + ["moveto", dest + ".part", dest, "-q"], timeout=180)
                self.event("remote_components_verified", remote_index=index)
            marker = self.durable / "COMPLETE"
            marker.write_text(json.dumps({"set_id": self.set_id, "manifest_sha256": sha(self.durable / "MANIFEST.json"),
                                          "verdict_sha256": sha(self.durable / "VERDICT.json")}, sort_keys=True) + "\n")
            for remote in REMOTES:
                dest = remote + "/" + prefix + "/COMPLETE"
                self.run("remote_complete", rc + ["copyto", str(marker), dest, "-q"], timeout=180)
                download = self.work / "remote-marker"
                self.run("remote_complete_verify", rc + ["cat", dest], output=download, timeout=180)
                if sha(download) != sha(marker):
                    raise Failure("remote_complete_mismatch")
            evidence["verified_remote_copies"] = len(REMOTES)
        else:
            evidence["verified_remote_copies"] = 0
        self.event("complete", **{k: v for k, v in evidence.items() if k != "set_id"})

    def execute(self):
        try:
            self.setup()
            if self.existing_set:
                self.load_existing()
            else:
                self.capture()
                self.encrypt_and_validate()
            self.provision()
            self.restore()
            self.verify()
            self.publish()
        except Exception as exc:
            if self.snapshot_process is not None:
                try:
                    self.end_snapshot()
                except Exception:
                    pass
            # Never expose subprocess arguments, stdout, stderr, SQL or private rows.
            reason = str(exc) if isinstance(exc, Failure) else type(exc).__name__
            result = {"status": "FAILED", "set_id": self.set_id, "stage": self.stage, "reason": reason,
                      "checks": self.checks, "tmpfs": str(self.work), "clone": self.clone}
            if self.durable.is_dir():
                (self.durable / "FAILURE.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
            print(json.dumps(result), flush=True)
            return 1
        return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upload-existing-remotes", action="store_true")
    parser.add_argument("--restore-existing-set", metavar="DIRECTORY",
                        help="Restore a completed encrypted set without contacting production")
    args = parser.parse_args()
    sys.exit(Recovery(args.upload_existing_remotes, args.restore_existing_set).execute())
