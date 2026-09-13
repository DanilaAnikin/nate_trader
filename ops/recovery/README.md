# Nate production recovery

`capture_restore.py` captures a consistent PostgreSQL snapshot and proves its
recovery in a separate container. It never applies production DDL/DML, starts a
trading process, or replaces the running production database. The resulting
container is intentionally kept for migration rehearsal.

Run only on the authorized `homelab` host, as root, with Python 3.12, GnuPG 2.4
with OCB, Docker, and rclone. The two existing backup passphrase files under
`/srv/homelab/secrets/` must be different regular files with mode `0600`.

Copy this directory's Python and SQL sources to a private operator directory.
Start the capture under a scope that prohibits process swapping:

```bash
sudo systemd-run --scope --quiet --property=MemorySwapMax=0 \
  python3 capture_restore.py --upload-existing-remotes
```

The tool fails if the process cgroup permits swapping, if a dedicated `noswap`
tmpfs cannot be mounted, or if GPG cannot produce authenticated OCB ciphertext.
The clone uses the source image ID, no network, no published ports, no Docker
log persistence, memory without swap, and tmpfs-backed data, configuration and
temporary files. Its labels include `nate.acceptance.clone=true` and the set ID.

Successful output identifies the clone, its tmpfs directory and the durable
recovery directory under `/var/lib/homelab/nt-cutover-recovery/`. The PostgreSQL
database is `postgres`; operators use `docker exec -i CLONE psql -X -w -qAt -U
supabase_admin -d postgres` over SSH. Application migration rehearsal must use
the intended migration role (`postgres`) and keep the clone isolated.

## What the proof covers

- `pg_dump -Fc`, all 63 currently observed user tables' row commitments, the
  security catalogue, database metadata and Vault plaintext commitment share
  one held, read-only, repeatable-read snapshot. Plaintext credentials never
  leave PostgreSQL: verification exports only a fresh keyed commitment.
- Globals, the actual `/etc/postgresql` configuration, custom configuration,
  root key, and reviewed supplemental platform metadata are captured too.
  Root-key capture uses a different encryption passphrase from other components.
- Every encrypted component passes an authenticated decrypt before its bytes
  replace the original capture. Those decrypted bytes are used for the restore.
- Corrupt encryption tags, a wrong root-component passphrase, and a truncated
  database archive must fail. The valid archive is fully consumed and restored
  with `--exit-on-error`; the restore cannot continue from an ignored SQL error.
- All table row commitments, role password commitments, effective captured
  security metadata and Vault plaintext commitments must match. The wrong Vault
  root key is installed only in the clone; a valid SQL connection must then fail
  specifically at decryption. Reinstalling the right key must recover the match.
- Uploads use only the existing `r2:homelab-backups` and
  `r2dr:homelab-backups-dr` remotes, beneath a distinct
  `natetrader-cutover-recovery-v1/` prefix. Every uploaded component is downloaded
  and compared before promotion. `COMPLETE` is published after both component
  sets verify. The old V2 last-success markers are not modified.

`MANIFEST.json`, `VERDICT.json`, source files, ciphertext and `COMPLETE` are safe
durable artifacts. Private diagnostic files and decrypted archive inputs remain
inside the protected tmpfs. A failed run emits `FAILURE.json`, never a successful
completion marker. Do not print diagnostics, SQL bodies, component plaintext or
environment values into issue logs or application logs.

## Restore an existing completed set

The standalone mode does not contact production. It validates `COMPLETE`, the
manifest, verdict, component allowlist, ciphertext digests, OCB authentication
and private plaintext bindings before provisioning a new isolated clone.

```bash
sudo systemd-run --scope --quiet --property=MemorySwapMax=0 \
  python3 capture_restore.py \
  --restore-existing-set /var/lib/homelab/nt-cutover-recovery/nt-cutover-20260913T110048Z
```

The original image ID must still be available on the host. An operator must
retrieve verified ciphertext from an existing backup remote first if the local
set is unavailable. This command restores a disposable clone; an actual
production replacement remains a separate controlled cutover.

After the consumer finishes with a clone, verify its exact set label and its
tmpfs mount path, remove only that disposable container, unmount only that
dedicated tmpfs, and remove the empty mountpoint. Never delete production paths
or unrelated Docker volumes. Keep encrypted recovery sets and their evidence.

## Catalogue provenance and limits

`nt-catalogue.sql` is adapted from the project's repaired Homelab R0 tooling
(`/home/anakin/wt/hl-r0/self-healing/lib/nt-catalogue.sql`). Recovery compares
logical visible-column order, sorted ACL entries, and sorted database-setting
entries; dropped-column ordinal gaps and array insertion order are not semantic
schema changes. Constraints, indexes, RLS, grants, function definitions and
settings otherwise remain exact comparisons.

The supplemental SQL covers actual observed platform drift omitted by
`pg_dump`: database ownership/ACL/settings, GraphQL schema grants, and the
`net.http_get` / `net.http_post` extension-member definitions and grants. An
additional unhandled drift fails full catalogue comparison; it is never
silently ignored. This proof covers PostgreSQL/Vault recovery, not object-store
payloads, external broker state, platform binaries absent from the recorded
image, or a service cutover. Database globals are captured outside the held
snapshot; concurrent role/schema changes must be excluded during this operation.
