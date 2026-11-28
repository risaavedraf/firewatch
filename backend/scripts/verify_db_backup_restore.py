#!/usr/bin/env python3
"""Local, fail-closed proof of the FireWatch backup/restore policy (V1-F-14).

``odd/entrega/acta-cierre.md`` §7 fixes the policy and two objectives: a full
logical backup (``pg_dump``) every 15 minutes, a monthly restore verified on an
isolated instance and recorded with its duration, RPO 15 minutes and RTO 1 hour.
The policy is written and, until this harness runs, unmeasured. This script
measures it and refuses to call anything measured that it did not observe.

What one run does, in order:

1. **Guards, before any mutation.** The scratch database names must match
   ``^firewatch_restore_drill_[a-z0-9_]{6,32}$`` and must never be a source
   database, ``firewatch``, ``postgres``, ``template0`` or ``template1``; the
   target host must be loopback; the archive must resolve inside the explicit
   scratch directory, without traversal or symbolic links. ``--dry-run`` runs
   these same guards instead of skipping them.
2. **An isolated PostGIS container**, named ``fw-v1f14-<run id>``, published on
   ``127.0.0.1::5432`` so its host port is ephemeral, and removed in a ``finally``.
   Nothing outside it is read or written.
3. **The three services migrated.** ``risk`` and ``prevention`` share the
   ``risk`` database and its ``schema_migrations`` ledger; ``jobs`` has its own
   database and ledger. The migration files are read from the repository and
   applied in ledger order in one transaction per database, mirroring
   ``cmd/server migrate``: the same guarded SQL, the same skip-by-version rule,
   the same ``schema_migrations(version)`` row per migration.
4. **Representative rows**, deterministic literals only: zones with real
   ``geometry(…,4326)`` polygons, a batch with a point, alerts, alert state,
   readings, jobs, outbox/inbox, audit events, preventive actions with their
   evidence, history and reassessment, and field observations with an adoption.
5. **The dump and its table of contents.** ``pg_dump -Fc`` into the scratch
   directory, then ``pg_restore --list``. An empty file, a file below the
   minimum size, a file that is not custom format, or a TOC that does not name
   every table's data fails the run *before* a scratch database exists.
6. **The restore** into a database this run created and names: ``pg_restore
   --clean --if-exists --no-owner``. A scratch database that already exists is a
   refusal, never a target.
7. **Two separate assertions.** Schema (relations, columns, constraints, indexes,
   extensions) and row equality (per-table row count plus a SHA-256 over the
   table's ordered row hashes, plus a PostGIS ``ST_AsBinary`` digest of every
   geometry column). One corrupted row or one missing row fails the run; both
   assertions fail closed.
8. **The measurement.** Wall-clock dump duration, the backup's age when recovery
   started, and the restore-plus-verification duration, contrasted with RPO 900 s
   and RTO 3600 s. A value above its objective is reported as a failure with its
   number, never rounded into compliance, and an unmeasured value is refused.

Honest limits, stated here so a green run is not read as more than it is:

* This proves the *local* mechanics against an isolated container. It does not
  implement, and must not be read as implementing, the Cloud Storage delivery,
  the 30-day retention, the encryption at rest or the scheduled ``CronJob`` the
  acta's policy names. Those remain unimplemented.
* It does not prove a restore in the authorised environment, and it does not
  sign the objectives: RPO/RTO remain agreed goals that one drill now contrasts
  with a number.
* ``spatial_ref_sys`` is excluded from the row digests: it is PostGIS extension
  reference data, re-created by ``CREATE EXTENSION``, not application data. The
  extension itself is compared as part of the schema assertion, and geometry is
  compared through ``ST_AsBinary``.
* Every command runs through ``docker exec`` inside the ephemeral container, so
  the drill needs Docker but no host ``pg_dump``/``pg_restore``/``psql``.

Exit codes: ``0`` every assertion held and the objectives were met, ``1`` a
guard, an assertion or an objective failed, ``130`` interrupted.

Run ``python backend/scripts/verify_db_backup_restore.py --help`` for the options.
"""
from __future__ import annotations

import argparse
import hashlib
import math
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVICES_ROOT = ROOT / "services"

# The acta's objectives. They are the input to the measurement, never its result,
# and they are also the hard ceilings: a CLI flag may tighten a threshold for a
# quicker run, never weaken what the acta fixed.
RPO_CEILING_SECONDS = 900
RTO_CEILING_SECONDS = 3600

# The image ``backend/docker-compose.yml`` and the schema inventory were taken
# with: PostgreSQL 17 with PostGIS 3.5.
POSTGIS_IMAGE = "postgis/postgis:17-3.5"
POSTGRES_PORT = 5432
DRILL_MOUNT = "/drill"
CONTAINER_PREFIX = "fw-v1f14-"
CONTAINER_PATTERN = re.compile(r"^fw-v1f14-[a-z0-9]{6,32}$")
RUN_ID_PATTERN = re.compile(r"^[a-z0-9]{6,16}$")

SCRATCH_DB_PREFIX = "firewatch_restore_drill_"
SCRATCH_DB_PATTERN = re.compile(r"^firewatch_restore_drill_[a-z0-9_]{6,32}$")
DATABASE_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,62}$")
SQL_IDENTIFIER = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")
RESERVED_DATABASES = frozenset({"firewatch", "postgres", "template0", "template1"})

LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1", "[::1]"})
LOOPBACK_IPV4 = re.compile(r"^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$")

DEFAULT_DATABASES = ("risk", "jobs")
LEDGER_EXPECTATIONS: dict[str, tuple[int, int]] = {"risk": (1, 19), "jobs": (1, 7)}

# pg_dump's custom-format magic and the smallest file that can hold a TOC.
PGDMP_MAGIC = b"PGDMP"
MIN_ARCHIVE_BYTES = 1024

# ``prevention`` is a schema of the risk database, not a database of its own, so
# both are read from the same connection. This one relation is PostGIS extension
# reference data, re-created by CREATE EXTENSION, so it is excluded from the row
# digests and kept in the schema assertion instead.
EXTENSION_RELATIONS = frozenset({"public.spatial_ref_sys"})

# Geometry columns compared through ST_AsBinary, per database and keyed by
# relation. Only the risk database stores geometry: ``prevention`` shares its
# schema set but owns no geometry, and jobs' ``zones`` has no geometry column at
# all, so a global map would demand a column a database never had.
GEOMETRY_COLUMNS: dict[str, dict[str, str]] = {
    "risk": {
        "public.zones": "geometry",
        "public.batches": "location",
    },
}

DEFAULT_TIMEOUT = 1800
DEFAULT_READY_TIMEOUT = 180
DEFAULT_POLL_INTERVAL = 1
HASH_BYTES = 64  # one SHA-256 rendered as hex

VERIFY_LABEL = "firewatch.verify"
RUN_LABEL = "firewatch.verify.run"


class DrillError(RuntimeError):
    """A bounded, operator-actionable refusal or failure that carries no secret."""


# ---------------------------------------------------------------------------
# Guards. Each one refuses; none of them warns and continues.
# ---------------------------------------------------------------------------
def validate_host(host: str | None, *, will_mutate: bool = True) -> str:
    """Return ``host`` when it is loopback, or when nothing is mutated."""
    text = (host or "").strip()
    if not text:
        raise DrillError("a target host is required: an empty host cannot be proven local")
    if LOOPBACK_IPV4.fullmatch(text):
        if any(not 0 <= int(octet) <= 255 for octet in text.split(".")[1:]):
            raise DrillError(f"refusing to treat {text!r} as loopback: the octets are out of range")
        return text
    if text in LOOPBACK_HOSTS:
        return text
    if will_mutate:
        raise DrillError(
            f"refusing to mutate a non-loopback target {text!r}: the drill only restores into its own "
            "ephemeral container reached through docker exec on 127.0.0.1"
        )
    return text


def parse_published_port(output: str, *, container: str, container_port: int) -> int:
    """Return the loopback host port Docker published for ``container_port``."""
    lines = [line.strip() for line in (output or "").splitlines() if line.strip()]
    if len(lines) != 1:
        raise DrillError(
            f"container {container} published {len(lines)} mappings for port {container_port}/tcp; "
            "the drill needs exactly one loopback mapping"
        )
    match = re.fullmatch(r"(?P<host>\[[0-9a-fA-F:]+\]|[^:]+):(?P<port>[0-9]{1,5})", lines[0])
    if match is None:
        raise DrillError(f"container {container} published an unreadable port mapping: {lines[0]!r}")
    validate_host(match.group("host"), will_mutate=True)
    port = int(match.group("port"))
    if port <= 0 or port > 65535:
        raise DrillError(f"container {container} published port {port}, which is not a usable host port")
    return port


def validate_container_name(name: str | None) -> str:
    text = (name or "").strip()
    if not CONTAINER_PATTERN.fullmatch(text):
        raise DrillError(
            f"refusing to use the container name {text or '<empty>'!r}: the name must match "
            f"{CONTAINER_PATTERN.pattern} so it cannot collide with a parallel worktree or an existing container"
        )
    return text


def validate_run_id(raw: str | None) -> str:
    text = (raw or "").strip()
    if not RUN_ID_PATTERN.fullmatch(text):
        raise DrillError(f"the run id {text or '<empty>'!r} must match {RUN_ID_PATTERN.pattern}")
    return text


def container_name_for(run_id: str) -> str:
    return validate_container_name(CONTAINER_PREFIX + validate_run_id(run_id))


def scratch_database_for(run_id: str, database: str) -> str:
    slug = re.sub(r"[^a-z0-9_]", "_", database.strip().lower())
    return SCRATCH_DB_PREFIX + validate_run_id(run_id) + "_" + slug


def validate_scratch_database(name: str | None, *, source_databases: Sequence[str] = ()) -> str:
    """Refuse every restore target that is not provably a scratch database."""
    if not isinstance(name, str) or not name:
        raise DrillError("a scratch database name is required")
    if name != name.strip():
        raise DrillError(f"the scratch database name {name!r} has surrounding whitespace")
    lowered = name.lower()
    if lowered in RESERVED_DATABASES:
        raise DrillError(f"refusing to restore into the reserved database {name!r}: it is never a drill target")
    sources = {source.lower() for source in source_databases}
    if lowered in sources:
        raise DrillError(f"refusing to restore into the source database {name!r}: a restore always targets a copy")
    if not SCRATCH_DB_PATTERN.fullmatch(name):
        raise DrillError(
            f"refusing to restore into {name!r}: the name must match {SCRATCH_DB_PATTERN.pattern}, "
            "which is what makes it a scratch database and not a real one"
        )
    return name


def _refuse_symlink_components(path: Path, *, label: str) -> None:
    """Refuse when any *unresolved* prefix of ``path`` is a symbolic link.

    Walking the resolved path would be useless: resolution has already
    dereferenced every link, so the link is not there to be inspected. The walk
    therefore starts from the path as the operator wrote it and rebuilds each
    prefix, which is the only form in which a link is still visible.
    """
    parts = path.parts
    if not parts:
        return
    start = 1 if path.anchor and parts[0] == path.anchor else 0
    current = Path(path.anchor) if start else Path()
    for part in parts[start:]:
        current = current / part
        if current.is_symlink():
            raise DrillError(f"{label} crosses the symbolic link {current}")


def validate_workdir(path: Path | str | None, *, must_exist: bool) -> Path:
    """Return the scratch/output directory, refusing one that cannot hold files."""
    if path is None:
        raise DrillError("a scratch/output directory is required")
    directory = Path(path)
    _refuse_symlink_components(directory, label=f"the scratch directory {directory}")
    if directory.exists() and not directory.is_dir():
        raise DrillError(f"the scratch directory {directory} is not a directory")
    if must_exist and not directory.is_dir():
        raise DrillError(f"the scratch directory {directory} does not exist; the drill never guesses one")
    # Canonical always: ``build_plan`` stores this value, and a relative
    # ``--workdir`` kept as written would not be a prefix of a canonical archive
    # path, so every containment and cleanup computation downstream would break.
    return directory.resolve(strict=must_exist)


def _is_within(candidate: Path, base: Path) -> bool:
    try:
        candidate.relative_to(base)
    except ValueError:
        return False
    return True


def resolve_archive_path(raw: str | None, *, workdir: Path | str | None) -> Path:
    """Resolve an archive inside the scratch directory, or refuse it."""
    if not isinstance(raw, str) or not raw.strip():
        raise DrillError("a backup archive path is required")
    if raw != raw.strip():
        raise DrillError(f"the backup archive path {raw!r} has surrounding whitespace")
    if raw.endswith(("/", "\\")):
        raise DrillError(f"the backup archive path {raw!r} must name a file, not a directory")
    parts = Path(raw).parts
    if ".." in parts:
        raise DrillError(f"the backup archive path {raw!r} traverses upwards; the drill never writes outside its scratch directory")
    base = validate_workdir(workdir, must_exist=False)
    candidate = Path(raw)
    absolute = candidate if candidate.is_absolute() else base / candidate
    if absolute.name in ("", ".", ".."):
        raise DrillError(f"the backup archive path {raw!r} does not name a file")
    _refuse_symlink_components(absolute, label=f"the backup archive path {raw!r}")
    resolved_base = base.resolve(strict=False)
    resolved = absolute.resolve(strict=False)
    if resolved == resolved_base:
        raise DrillError(f"the backup archive path {raw!r} is the scratch directory itself")
    if not _is_within(resolved, resolved_base):
        raise DrillError(f"the backup archive path {raw!r} escapes the scratch directory {base}")
    return resolved


def validate_archive_file(path: Path | str) -> int:
    """Return the archive size after every on-disk check, or refuse it."""
    archive = Path(path)
    if archive.is_symlink():
        raise DrillError(f"refusing to read the symbolic link {archive} as a backup archive")
    if not archive.exists():
        raise DrillError(f"the backup archive {archive} does not exist")
    if not archive.is_file():
        raise DrillError(f"the backup archive {archive} is not a regular file")
    size = archive.stat().st_size
    if size == 0:
        raise DrillError(f"the backup archive {archive} is empty: an empty dump is a failed backup, never a restorable one")
    if size < MIN_ARCHIVE_BYTES:
        raise DrillError(
            f"the backup archive {archive} is {size} bytes, below the {MIN_ARCHIVE_BYTES}-byte minimum: "
            "a truncated dump cannot hold a table of contents"
        )
    with archive.open("rb") as handle:
        magic = handle.read(len(PGDMP_MAGIC))
    if magic != PGDMP_MAGIC:
        raise DrillError(f"the backup archive {archive} is not a custom-format (pg_dump -Fc) archive")
    return size


# ---------------------------------------------------------------------------
# Archive table of contents
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class TocSummary:
    entries: int
    tables: frozenset[str]
    data: frozenset[str]


def summarise_toc(text: str) -> TocSummary:
    """Parse ``pg_restore --list`` output into the objects and their data."""
    entries = 0
    tables: set[str] = set()
    data: set[str] = set()
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith(";"):
            continue
        entries += 1
        _, _, description = line.partition(";")
        fields = description.split()
        for index, part in enumerate(fields):
            if part != "TABLE":
                continue
            if fields[index + 1 : index + 2] == ["DATA"]:
                if index + 3 >= len(fields):
                    continue
                data.add(f"{fields[index + 2]}.{fields[index + 3]}")
            elif index + 2 < len(fields):
                tables.add(f"{fields[index + 1]}.{fields[index + 2]}")
    return TocSummary(entries=entries, tables=frozenset(tables), data=frozenset(data))


def missing_toc_objects(summary: TocSummary, required: Iterable[str]) -> list[str]:
    """Return one human-readable line per object the TOC does not prove."""
    missing: list[str] = []
    for relation in required:
        if relation not in summary.data:
            missing.append(f"{relation} (no table data)")
        elif relation not in summary.tables:
            missing.append(f"{relation} (no table definition)")
    return missing


def evaluate_toc(summary: TocSummary, required: Iterable[str], *, archive: str) -> None:
    """Fail closed unless the archive proves it holds every required table."""
    wanted = list(required)
    if summary.entries == 0:
        raise DrillError(
            f"the table of contents of {archive} is empty: the archive is truncated, so it cannot be restored"
        )
    missing = missing_toc_objects(summary, wanted)
    if missing:
        raise DrillError(
            f"the archive {archive} does not hold the tables it must restore: " + "; ".join(missing)
        )


# ---------------------------------------------------------------------------
# Migrations: the repository is the source, the ledger is the order
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    path: Path

    @property
    def sql(self) -> str:
        return self.path.read_text(encoding="utf-8")


# A migration is registered in one of two shapes, and both are read from the
# repository instead of being assumed: risk and prevention list
# ``{Version: N, Name: "...", SQL: var}`` in their ``embed.go``, while jobs builds
# its list inline in the migrate branch of ``cmd/server/main.go`` as
# ``{version: N, sql: migrations.Var}``. Reading only the first shape would apply
# zero jobs migrations and report a green ledger it never checked.
_EMBED_FILE = re.compile(r"^//go:embed\s+(\S+)\s*\nvar\s+(\w+)\s+string", re.M)
_EMBED_ENTRY = re.compile(
    r'\{[^{}]*?Version:\s*(\d+)[^{}]*?Name:\s*"([^"]*)"[^{}]*?SQL:\s*(?:\w+\.)?(\w+)[^{}]*?\}', re.S
)
_INLINE_ENTRY = re.compile(r"\{[^{}]*?version:\s*(\d+)[^{}]*?sql:\s*(?:migrations\.)?(\w+)[^{}]*?\}", re.S)

# Where each service registers the migrations its migrator applies.
SERVICE_REGISTRATIONS: dict[str, tuple[str, ...]] = {
    "risk": ("migrations/embed.go",),
    "prevention": ("migrations/embed.go",),
    "jobs": ("migrations/embed.go", "cmd/server/main.go"),
}


def discover_migrations(
    directory: Path | str, *, registrations: Sequence[Path | str] | None = None
) -> list[Migration]:
    """Return the migrations a service registers, in the order it registers them."""
    root = Path(directory)
    embed = root / "embed.go"
    if not embed.is_file():
        raise DrillError(f"{root} holds no embed.go: the registered migrations are the only ones appliable")
    variables = {variable: file_name for file_name, variable in _EMBED_FILE.findall(embed.read_text(encoding="utf-8"))}
    sources = [embed] if registrations is None else [Path(entry) for entry in registrations]
    registered: list[tuple[int, str | None, str]] = []
    for source in sources:
        if not source.is_file():
            raise DrillError(f"the migration registration {source} is missing from the checkout")
        text = source.read_text(encoding="utf-8")
        registered += [(int(version), name, variable) for version, name, variable in _EMBED_ENTRY.findall(text)]
        registered += [(int(version), None, variable) for version, variable in _INLINE_ENTRY.findall(text)]
    if not registered:
        raise DrillError(f"no migration is registered for {root}: the ledger would be applied empty")

    migrations: list[Migration] = []
    for version, declared_name, variable in registered:
        file_name = variables.get(variable)
        if file_name is None:
            raise DrillError(f"{embed} registers {variable} without a //go:embed line")
        path = root / file_name
        if not path.is_file():
            raise DrillError(f"the embedded migration {path} is missing from the checkout")
        prefix = path.name.split("_", 1)[0]
        if not prefix.isdigit() or int(prefix) != version:
            raise DrillError(
                f"the migration {path.name} is registered as version {version}: the file name and the "
                "ledger must agree, or a version is applied under the wrong number"
            )
        name = declared_name if declared_name is not None else path.stem.split("_", 1)[-1]
        migrations.append(Migration(version=version, name=name, path=path))
    versions = [migration.version for migration in migrations]
    if len(set(versions)) != len(versions):
        raise DrillError(f"{root} registers a duplicate version: {sorted(versions)}")
    if versions != sorted(versions):
        raise DrillError(f"{root} registers its migrations out of order: {versions}")
    registered_files = {migration.path.name for migration in migrations}
    orphans = sorted(path.name for path in root.glob("*.sql") if path.name not in registered_files)
    if orphans:
        raise DrillError(
            f"{root} holds migration files that no registration names: {', '.join(orphans)}. "
            "Applying the directory instead of the ledger would run SQL no binary ever runs"
        )
    return migrations


def database_migration_plan(services_root: Path | str) -> dict[str, list[Migration]]:
    """Return the migrations per database: ``risk`` (with prevention) and ``jobs``."""
    root = Path(services_root)
    discovered: dict[str, list[Migration]] = {}
    for service in ("risk", "prevention", "jobs"):
        directory = root / service / "migrations"
        if not directory.is_dir():
            raise DrillError(f"{root} is not the services root: missing {service}/migrations")
        registrations = [
            root / service / relative
            for relative in SERVICE_REGISTRATIONS[service]
            if (root / service / relative).is_file()
        ]
        if not registrations:
            raise DrillError(f"{service} registers its migrations nowhere the drill can read")
        discovered[service] = discover_migrations(directory, registrations=registrations)
    shared = [migration.version for migration in discovered["risk"]] + [
        migration.version for migration in discovered["prevention"]
    ]
    collisions = sorted({version for version in shared if shared.count(version) > 1})
    if collisions:
        raise DrillError(
            f"risk and prevention both claim shared ledger version(s) {collisions}: whichever migrator runs "
            "second would skip its own schema in silence"
        )
    merged = sorted(discovered["risk"] + discovered["prevention"], key=lambda migration: migration.version)
    return {"risk": merged, "jobs": discovered["jobs"]}


# ---------------------------------------------------------------------------
# Census and comparison
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class TableDigest:
    rows: int
    digest: str


@dataclass(frozen=True)
class DatabaseCensus:
    database: str
    ledger: tuple[int, ...] = ()
    tables: Mapping[str, TableDigest] = field(default_factory=dict)
    geometry: Mapping[str, TableDigest] = field(default_factory=dict)
    schema: tuple[str, ...] = ()


def compare_content(before: DatabaseCensus, after: DatabaseCensus) -> list[str]:
    """Return every row-level difference between a dump and its restore."""
    if before.database != after.database:
        raise DrillError(
            f"refusing to compare the census of {before.database!r} with the census of {after.database!r}"
        )
    mismatches: list[str] = []
    if before.ledger != after.ledger:
        mismatches.append(
            f"ledger: {before.database} holds {list(before.ledger)} before the dump and "
            f"{list(after.ledger)} after the restore"
        )
    for relation in sorted(set(before.tables) | set(after.tables)):
        left = before.tables.get(relation)
        right = after.tables.get(relation)
        if left is None:
            mismatches.append(f"{relation}: missing from the restored database")
            continue
        if right is None:
            mismatches.append(f"{relation}: present before the dump and missing after the restore")
            continue
        if left.rows != right.rows:
            mismatches.append(f"{relation}: {left.rows} rows before the dump, {right.rows} after the restore")
        if left.digest != right.digest:
            mismatches.append(
                f"{relation}: content digest differs ({left.digest[:12]}… before, {right.digest[:12]}… after)"
            )
    for relation in sorted(set(before.geometry) | set(after.geometry)):
        left = before.geometry.get(relation)
        right = after.geometry.get(relation)
        if left is None or right is None:
            state = "before the dump" if left is None else "after the restore"
            mismatches.append(f"{relation}: PostGIS geometry digest is missing {state}")
            continue
        if left.rows != right.rows or left.digest != right.digest:
            mismatches.append(
                f"{relation}: PostGIS geometry digest differs ({left.rows} geometries before, "
                f"{right.rows} after the restore)"
            )
    return mismatches


def compare_schema(before: DatabaseCensus, after: DatabaseCensus) -> list[str]:
    """Return every schema object present on one side of the restore only."""
    if before.database != after.database:
        raise DrillError(
            f"refusing to compare the schema of {before.database!r} with the schema of {after.database!r}"
        )
    mismatches = [
        f"schema object missing after the restore: {line}" for line in sorted(set(before.schema) - set(after.schema))
    ]
    mismatches += [
        f"schema object present only after the restore: {line}" for line in sorted(set(after.schema) - set(before.schema))
    ]
    return mismatches


def check_ledger(database: str, versions: Sequence[int], expectation: tuple[int, int]) -> None:
    """Fail closed unless the ledger holds exactly the expected contiguous range."""
    observed = list(versions)
    minimum, maximum = expectation
    expected = list(range(minimum, maximum + 1))
    if observed == expected:
        return
    duplicated = sorted({version for version in observed if observed.count(version) > 1})
    raise DrillError(
        f"the {database} schema_migrations ledger does not match the repository: observed {observed}, "
        f"expected {minimum}..{maximum}; missing {sorted(set(expected) - set(observed))}, "
        f"unexpected {sorted(set(observed) - set(expected))}, duplicated {duplicated}"
    )


def parse_expectation(raw: str) -> tuple[str, tuple[int, int]]:
    database, separator, span = (raw or "").partition("=")
    match = re.fullmatch(r"([0-9]+)-([0-9]+)", span.strip())
    if not separator or not DATABASE_PATTERN.fullmatch(database.strip()) or match is None:
        raise DrillError(f"the ledger expectation {raw!r} must be written <database>=<from>-<to>, for example risk=1-19")
    minimum, maximum = int(match.group(1)), int(match.group(2))
    if minimum > maximum:
        raise DrillError(f"the ledger expectation {raw!r} names an empty range")
    return database.strip(), (minimum, maximum)


# ---------------------------------------------------------------------------
# Measurement
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Measurement:
    dump_seconds: float
    backup_age_seconds: float
    restore_seconds: float
    verification_seconds: float

    @property
    def recovery_seconds(self) -> float:
        return self.restore_seconds + self.verification_seconds


def _measured(value: float | None, *, label: str) -> float:
    if value is None:
        raise DrillError(f"the {label} was not measured: the drill fails closed instead of reporting a guess")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise DrillError(f"the {label} is not a number: {value!r}") from None
    if not math.isfinite(number) or number < 0:
        raise DrillError(f"the {label} is not a usable measurement: {value!r}")
    return number


def evaluate_rpo(measurement: Measurement, *, limit: int = RPO_CEILING_SECONDS) -> None:
    """Fail closed when the backup that was restored cannot meet the RPO."""
    dump = _measured(measurement.dump_seconds, label="dump duration")
    age = _measured(measurement.backup_age_seconds, label="backup age")
    breaches: list[str] = []
    if age > limit:
        breaches.append(f"the restored backup was {age:.3f}s old when recovery started (RPO {limit}s)")
    if dump > limit:
        breaches.append(
            f"the dump itself took {dump:.3f}s, longer than the RPO of {limit}s; a backup slower than the "
            "objective cannot sustain it"
        )
    if breaches:
        raise DrillError("RPO not met: " + "; ".join(breaches))


def evaluate_rto(measurement: Measurement, *, limit: int = RTO_CEILING_SECONDS) -> None:
    """Fail closed when restore plus verification exceeds the RTO."""
    restore = _measured(measurement.restore_seconds, label="restore duration")
    verification = _measured(measurement.verification_seconds, label="verification duration")
    recovery = restore + verification
    if recovery > limit:
        raise DrillError(
            f"RTO not met: recovery took {recovery:.3f}s ({restore:.3f}s restore + {verification:.3f}s "
            f"verification) against the objective of {limit}s"
        )


# ---------------------------------------------------------------------------
# Plan: every structural guard, before anything mutates
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Plan:
    run_id: str
    workdir: Path
    workdir_owned: bool
    host: str
    container_name: str
    image: str
    source_databases: tuple[str, ...]
    scratch_databases: Mapping[str, str]
    archives: Mapping[str, Path]
    ledger_expectations: Mapping[str, tuple[int, int]]
    max_rpo_seconds: int
    max_rto_seconds: int
    timeout: int
    ready_timeout: int
    poll_interval: int
    dry_run: bool
    keep: bool


def _within_ceiling(value: int | None, *, ceiling: int, label: str) -> int:
    """Return a threshold the acta allows: positive and never above its ceiling."""
    if not isinstance(value, int) or isinstance(value, bool):
        raise DrillError(f"the {label} threshold is not a whole number of seconds: {value!r}")
    number = value
    if number <= 0:
        raise DrillError(f"the {label} threshold must be a positive number of seconds, not {number}")
    if number > ceiling:
        raise DrillError(
            f"the {label} threshold {number}s is above the {ceiling}s ceiling acta-cierre section 7 fixed: a flag "
            "an objective for a quicker run, never weaken it"
        )
    return number


def build_plan(args: argparse.Namespace) -> Plan:
    """Validate every structural guard and return the run plan."""
    dry_run = bool(getattr(args, "dry_run", False))
    # The guard is always the mutating one: a dry run describes the plan that
    # would mutate, so it must never accept a target the live run would refuse.
    host = validate_host(getattr(args, "host", None), will_mutate=True)
    run_id = validate_run_id(getattr(args, "run_id", None)) if getattr(args, "run_id", None) else secrets.token_hex(4)
    container_name = validate_container_name(getattr(args, "container_name", None) or container_name_for(run_id))
    image = (getattr(args, "image", "") or "").strip()
    if not image:
        raise DrillError("a container image is required; the drill never guesses which PostgreSQL it restores into")

    databases = [str(name).strip() for name in (getattr(args, "database", None) or [])]
    if not databases:
        raise DrillError("at least one source database is required")
    for name in databases:
        if not name:
            raise DrillError("a source database name cannot be empty")
        if not DATABASE_PATTERN.fullmatch(name):
            raise DrillError(f"the source database {name!r} is not a plain lowercase identifier")
        if name in RESERVED_DATABASES:
            raise DrillError(f"the source database {name!r} is reserved and is never a drill source")
    if len(set(databases)) != len(databases):
        raise DrillError(f"the source databases {databases} repeat: each database is dumped and restored once")

    raw_scratch = [str(name).strip() for name in (getattr(args, "scratch_database", None) or [])]
    if raw_scratch and len(raw_scratch) != len(databases):
        raise DrillError(
            f"--scratch-database was given {len(raw_scratch)} time(s) for {len(databases)} database(s): "
            "each restore target must be named explicitly or derived, never guessed"
        )
    scratch: dict[str, str] = {}
    for index, database in enumerate(databases):
        requested = raw_scratch[index] if raw_scratch else scratch_database_for(run_id, database)
        scratch[database] = validate_scratch_database(requested, source_databases=tuple(databases))
    if len(set(scratch.values())) != len(scratch):
        raise DrillError(f"the restore targets {list(scratch.values())} repeat: one scratch database per source")

    workdir_option = getattr(args, "workdir", None)
    if workdir_option:
        workdir = validate_workdir(Path(workdir_option), must_exist=not dry_run)
        workdir_owned = False
    else:
        # The default is a directory this run owns: it is created only once every
        # preflight guard has passed and removed in teardown. Preflight proves the
        # system temporary directory is real and crosses no symbolic link - and it
        # proves it on the *unresolved* path, because resolving first would hide a
        # link behind whatever it points at.
        temp_raw = Path(tempfile.gettempdir())
        _refuse_symlink_components(temp_raw, label=f"the system temporary directory {temp_raw}")
        temp_root = validate_workdir(temp_raw, must_exist=True)
        # The derived name is inspected before any resolution: a dangling symlink
        # resolves to its absent target, so checking after ``resolve`` would pass
        # and a later mkdir would create the target outside the temporary
        # directory instead of refusing the entry.
        derived_lexical = temp_root / (CONTAINER_PREFIX + run_id)
        if derived_lexical.is_symlink() or derived_lexical.exists():
            raise DrillError(
                f"the derived scratch directory {derived_lexical} already exists; pass --workdir to choose another "
                "directory or --run-id to start a new run"
            )
        if derived_lexical.parent != temp_root:
            raise DrillError(
                f"the derived scratch directory {derived_lexical} is not a single entry under {temp_root}"
            )
        workdir = derived_lexical
        workdir_owned = True

    raw_archives = [str(name) for name in (getattr(args, "archive", None) or [])]
    if raw_archives and len(raw_archives) != len(databases):
        raise DrillError(
            f"--archive was given {len(raw_archives)} time(s) for {len(databases)} database(s): "
            "one archive per database, all inside the scratch directory"
        )
    archives = {
        database: resolve_archive_path(
            raw_archives[index] if raw_archives else f"{database}.dump", workdir=workdir
        )
        for index, database in enumerate(databases)
    }
    # Preflight, before anything is created: a planned archive path that already
    # exists may belong to the operator, and teardown only ever removes files this
    # run wrote. Refusing here is what makes that ownership rule provable instead
    # of hopeful, and it also stops a dump from overwriting an older archive.
    occupied = sorted(str(path) for path in archives.values() if path.exists() or path.is_symlink())
    if occupied:
        raise DrillError(
            "the drill never overwrites or removes an archive it did not write: "
            + ", ".join(occupied)
            + " already exists; move it away or pass a different --archive"
        )

    expectations: dict[str, tuple[int, int]] = {
        name: span for name, span in LEDGER_EXPECTATIONS.items() if name in databases
    }
    for raw in getattr(args, "expect_ledger", None) or []:
        database, span = parse_expectation(raw)
        if database not in databases:
            raise DrillError(f"the ledger expectation {raw!r} names {database!r}, which is not a source database")
        expectations[database] = span

    max_rpo = _within_ceiling(
        getattr(args, "max_rpo_seconds", RPO_CEILING_SECONDS), ceiling=RPO_CEILING_SECONDS, label="RPO"
    )
    max_rto = _within_ceiling(
        getattr(args, "max_rto_seconds", RTO_CEILING_SECONDS), ceiling=RTO_CEILING_SECONDS, label="RTO"
    )

    return Plan(
        run_id=run_id,
        workdir=workdir,
        workdir_owned=workdir_owned,
        host=host,
        container_name=container_name,
        image=image,
        source_databases=tuple(databases),
        scratch_databases=scratch,
        archives=archives,
        ledger_expectations=expectations,
        max_rpo_seconds=max_rpo,
        max_rto_seconds=max_rto,
        timeout=int(getattr(args, "timeout", DEFAULT_TIMEOUT)),
        ready_timeout=int(getattr(args, "ready_timeout", DEFAULT_READY_TIMEOUT)),
        poll_interval=int(getattr(args, "poll_interval", DEFAULT_POLL_INTERVAL)),
        dry_run=dry_run,
        keep=bool(getattr(args, "keep", False)),
    )


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class DatabaseRecord:
    database: str
    scratch: str
    tables: int
    archive_bytes: int
    toc_entries: int
    ledger: tuple[int, ...]


@dataclass(frozen=True)
class RecoveryReport:
    container: str
    workdir: Path
    host_port: int
    measurement: Measurement
    records: tuple[DatabaseRecord, ...]
    max_rpo_seconds: int
    max_rto_seconds: int


# ---------------------------------------------------------------------------
# SQL. Every script starts with a marker so the census of one call is
# attributable in an operator's log; the projection below is read back with
# psql -A -t -F '|', which is why no value may contain a newline.
# ---------------------------------------------------------------------------
SESSION_PREAMBLE = (
    "SET TIME ZONE 'UTC';\n"
    "SET DateStyle = 'ISO, YMD';\n"
    "SET INTERVALSTYLE = 'postgres';\n"
    "SET extra_float_digits = 3;\n"
)

ROLES_SCRIPT = """-- drill:roles
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'risk_app') THEN CREATE ROLE risk_app NOLOGIN; END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jobs_app') THEN CREATE ROLE jobs_app NOLOGIN; END IF;
END $$;
"""

TABLES_SCRIPT = """-- drill:tables
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_type = 'BASE TABLE'
  AND table_schema IN ('public', 'prevention')
  AND NOT (table_schema = 'public' AND table_name = 'spatial_ref_sys')
ORDER BY table_schema, table_name;
"""

LEDGER_SCRIPT = """-- drill:ledger
SELECT version FROM schema_migrations ORDER BY version;
"""

SCHEMA_SCRIPT = """-- drill:schema
SET TIME ZONE 'UTC';
SET DateStyle = 'ISO, YMD';
SET INTERVALSTYLE = 'postgres';
SET extra_float_digits = 3;
SELECT 'relation', n.nspname || '.' || c.relname || ':' || CASE c.relkind
        WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned' WHEN 'v' THEN 'view'
        WHEN 'm' THEN 'matview' WHEN 'S' THEN 'sequence' ELSE c.relkind::text END
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'prevention') AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
ORDER BY 2;
SELECT 'column', table_schema || '.' || table_name || '.' || column_name || ':' || data_type
        || ':' || is_nullable || ':' || coalesce(character_maximum_length::text, '-')
        || ':' || udt_schema || '.' || udt_name || ':' || ordinal_position::text
FROM information_schema.columns
WHERE table_schema IN ('public', 'prevention')
ORDER BY table_schema, table_name, ordinal_position;
SELECT 'constraint', n.nspname || '.' || c.relname || ':' || con.conname || ':' || pg_get_constraintdef(con.oid)
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'prevention')
ORDER BY 2;
SELECT 'index', schemaname || '.' || tablename || ':' || indexname || ':' || indexdef
FROM pg_indexes
WHERE schemaname IN ('public', 'prevention')
ORDER BY 2;
SELECT 'extension', extname || ':' || extversion FROM pg_extension ORDER BY 1;
"""


def sql_identifier(name: str) -> str:
    """Return a plain lowercase identifier, refusing anything that could be syntax.

    Relation names are discovered from ``information_schema``, never from an
    operator's argument, but the projection below interpolates them, so they are
    re-validated at the boundary instead of being trusted because of where they
    came from.
    """
    if not SQL_IDENTIFIER.fullmatch(name):
        raise DrillError(f"refusing to interpolate {name!r} into SQL: it is not a plain lowercase identifier")
    return name


def drop_script(database: str) -> str:
    """Return the DROP for a database this run created and named."""
    return f'-- drill:drop\nDROP DATABASE IF EXISTS "{validate_scratch_database(database)}";\n'


def create_script(database: str) -> str:
    return f'-- drill:create\nCREATE DATABASE "{validate_scratch_database(database)}";\n'


def exists_script(database: str) -> str:
    return (
        "-- drill:exists\n"
        f"SELECT count(*) FROM pg_database WHERE datname = '{validate_scratch_database(database)}';\n"
    )


def digest_script(relations: Sequence[tuple[str, str]]) -> str:
    """Return one statement per relation: its name, row count and hash chain.

    The chain is the concatenation, in canonical row order, of each row's own
    SHA-256 rendered as hex. Concatenation is unambiguous because every element
    is exactly ``HASH_BYTES`` long, and the caller recomputes the table's digest
    as a SHA-256 over that chain - so a different row, a different order or a
    different row count all change the digest.
    """
    statements = ["-- drill:digest", SESSION_PREAMBLE.rstrip("\n")]
    for schema, name in relations:
        qualified = f"{sql_identifier(schema)}.{sql_identifier(name)}"
        statements.append(
            f"SELECT '{qualified}', count(*), "  # noqa: S608 - both parts are validated identifiers

            "coalesce(string_agg(encode(sha256(convert_to(t::text, 'UTF8')), 'hex'), '' ORDER BY t::text), '') "
            f'FROM "{schema}"."{name}" t;'
        )
    return "\n".join(statements) + "\n"


def geometry_script(columns: Mapping[str, str]) -> str:
    """Return one statement per geometry column, hashed through ST_AsBinary."""
    statements = ["-- drill:geometry", SESSION_PREAMBLE.rstrip("\n")]
    for relation, column_name in columns.items():
        schema, name = relation.split(".")
        column = sql_identifier(column_name)
        qualified = f"{sql_identifier(schema)}.{sql_identifier(name)}"
        statements.append(
            f"SELECT '{qualified}', count(*), coalesce(string_agg("  # noqa: S608 - validated identifiers

            f"encode(ST_AsBinary(t.{column}), 'hex') || ':' || ST_SRID(t.{column})::text || ':' "
            f"|| GeometryType(t.{column}), ',' ORDER BY t::text), '') "
            f'FROM {qualified} t WHERE t.{column} IS NOT NULL;'  # noqa: S608 - validated identifiers
        )
    return "\n".join(statements) + "\n"


def migration_script(migrations: Sequence[Migration], database: str) -> str:
    """Return the ledger transaction for one database, mirroring the Go runner."""
    lines = [
        "-- drill:migrate",
        f"-- applying {len(migrations)} registered migration(s) to the {database} database",
        "BEGIN;",
        "SELECT pg_advisory_xact_lock(1);",
        "CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY);",
    ]
    for migration in migrations:
        lines.append(f"-- {migration.version:03d} {migration.name}")
        lines.append(migration.sql.strip())
        lines.append(
            f"INSERT INTO schema_migrations(version) VALUES ({int(migration.version)});"  # noqa: S608 - an int
        )
    lines.append("COMMIT;")
    return "\n".join(lines) + "\n"


SEED_SCRIPTS: dict[str, str] = {
    "risk": """-- drill:seed
INSERT INTO public.zones(code, name, province, kind, geometry) VALUES
    ('drill-quirill', 'Quirill (drill)', 'Valparaiso', 'comuna',
     ST_GeomFromText('POLYGON((-71.62 -33.04, -71.62 -33.09, -71.57 -33.09, -71.57 -33.04, -71.62 -33.04))', 4326)),
    ('drill-isla', 'Isla (drill)', 'Valparaiso', 'comuna',
     ST_GeomFromText('MULTIPOLYGON(((-71.90 -33.30, -71.90 -33.35, -71.85 -33.35, -71.85 -33.30, -71.90 -33.30)))', 4326))
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.readings(zone_id, variable, observed_at, value, unit, source_id, quality, ingested_at) VALUES
    ('drill-quirill', 'temperatura', '2026-11-20T11:45:00Z', 24.5, 'C', 'drill-source', 'ok', '2026-11-20T11:46:00Z'),
    ('drill-quirill', 'humedad_relativa', '2026-11-20T11:45:00Z', 38.25, '%', 'drill-source', 'ok', '2026-11-20T11:46:00Z')
ON CONFLICT (zone_id, variable, observed_at) DO NOTHING;

INSERT INTO public.batches(id, job_id, zone_id, requested_at, published_at, valid_until, model_version,
                           demo, location, risk_level, factors, rationale, policy_ref, scenario_id, evaluated_at) VALUES
    ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'valparaiso-demo',
     '2026-11-20T12:00:00Z', '2026-11-20T12:00:05Z', '2026-11-20T12:15:00Z', 'ml-fixture-v1', true,
     ST_GeomFromText('POINT(-71.6272 -33.0472)', 4326), 'medio',
     '{"temperatura": 24.5, "humedad_relativa": 38.25}'::jsonb, 'drill fixture',
     '{"policy_id": "academic-rule-v1", "parameters": {"temperatura": 30, "humedad_relativa": 30},
       "params_hash": "e17aaa5600eb67c9a91340e90057aec100f4e80ef0895662f373cffee66564c7"}'::jsonb,
     'mixed', '2026-11-20T12:00:04Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.risk_alerts(id, zone_id, batch_id, previous_level, new_level, threshold, occurred_at) VALUES
    ('33333333-3333-4333-8333-333333333333', 'valparaiso-demo',
     '11111111-1111-4111-8111-111111111111', 'bajo', 'medio', 1, '2026-11-20T12:00:05Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.risk_alert_state(id, alert_id, subject_key, state, marked_at) VALUES
    ('44444444-4444-4444-8444-444444444444', '33333333-3333-4333-8333-333333333333',
     repeat('a', 64), 'read', '2026-11-20T12:05:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.outbox(id, routing_key, payload, created_at, published_at) VALUES
    ('55555555-5555-4555-8555-555555555555', 'risk.batch.requested',
     '{"job_id": "22222222-2222-4222-8222-222222222222"}'::jsonb, '2026-11-20T11:59:00Z', '2026-11-20T11:59:01Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.inbox(id, processed_at) VALUES
    ('66666666-6666-4666-8666-666666666666', '2026-11-20T12:00:06Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO prevention.directory_users(id, display_name, synced_at) VALUES
    ('77777777-7777-4777-8777-777777777777', 'Drill Operator', '2026-11-20T10:00:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO prevention.actions(id, community_code, title, description, priority, status, assignee, due_date,
                               created_by, created_at, updated_at, assignee_id) VALUES
    ('88888888-8888-4888-8888-888888888888', 'drill-quirill', 'Despejar microbasural',
     'Retirar residuos vegetales secos', 'alta', 'asignada', 'legacy-text', '2026-12-01',
     'drill-operator', '2026-11-20T10:05:00Z', '2026-11-20T10:06:00Z',
     '77777777-7777-4777-8777-777777777777')
ON CONFLICT (id) DO NOTHING;

INSERT INTO prevention.action_history(action_id, from_status, to_status, actor_sub, note, created_at) VALUES
    ('88888888-8888-4888-8888-888888888888', 'propuesta', 'asignada', 'drill-operator', 'drill', '2026-11-20T10:06:00Z');

INSERT INTO prevention.action_evidence(action_id, criterion, evidence_references, created_by, created_at) VALUES
    ('88888888-8888-4888-8888-888888888888', 'criterion-1', ARRAY['drill://evidence/1', 'drill://evidence/2']::text[],
     'drill-operator', '2026-11-20T10:07:00Z');

INSERT INTO prevention.action_reassessment(action_id, job_id, batch_id, version, risk_level, zone_id, synthetic,
                                           batch_published_at, linked_by, linked_at) VALUES
    ('88888888-8888-4888-8888-888888888888', '99999999-9999-4999-8999-999999999999',
     '11111111-1111-4111-8111-111111111111', 'ml-fixture-v1', 'medio', 'valparaiso-demo', true,
     '2026-11-20T12:00:05Z', 'drill-operator', '2026-11-20T12:10:00Z');

INSERT INTO prevention.observations(id, type, zone_id, observed_on, description, created_by, created_at) VALUES
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'vegetacion_seca', 'drill-quirill', '2026-11-19',
     'Pasto seco junto al camino', 'drill-operator', '2026-11-20T10:08:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO prevention.observation_adoptions(observation_id, action_id, confirmed_by, confirmed_at) VALUES
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '88888888-8888-4888-8888-888888888888',
     'drill-operator', '2026-11-20T10:09:00Z')
ON CONFLICT (observation_id) DO NOTHING;
""",
    "jobs": """-- drill:seed
INSERT INTO public.zones(code, name, province, kind) VALUES
    ('drill-quirill', 'Quirill (drill)', 'Valparaiso', 'comuna')
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.jobs(id, actor_id, idempotency_key, zone_id, state, batch_id, requested_at,
                        scenario_id, evaluated_at, attempts, failure_reason, failed_at) VALUES
    ('22222222-2222-4222-8222-222222222222', 'drill-operator', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
     'valparaiso-demo', 'published', '11111111-1111-4111-8111-111111111111', '2026-11-20T11:59:00Z',
     'mixed', '2026-11-20T12:00:04Z', 0, NULL, NULL),
    ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'drill-operator', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
     'drill-quirill', 'failed', NULL, '2026-11-20T12:01:00Z',
     NULL, NULL, 3, 'dependency unavailable', '2026-11-20T12:02:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.outbox(id, routing_key, payload, created_at, published_at) VALUES
    ('55555555-5555-4555-8555-555555555555', 'risk.batch.requested',
     '{"job_id": "22222222-2222-4222-8222-222222222222"}'::jsonb, '2026-11-20T11:59:00Z', '2026-11-20T11:59:01Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.inbox(id, processed_at) VALUES
    ('66666666-6666-4666-8666-666666666666', '2026-11-20T12:00:06Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.audit(actor_id, actor_name, action, job_id, trace_id, event_kind, detail, occurred_at) VALUES
    ('drill-operator', 'Drill Operator', 'job.requested', '22222222-2222-4222-8222-222222222222',
     'ffffffff-ffff-4fff-8fff-ffffffffffff', 'mutation', 'drill', '2026-11-20T11:59:00Z'),
    ('drill-operator', 'Drill Operator', 'risk.compare.read', '22222222-2222-4222-8222-222222222222',
     'ffffffff-ffff-4fff-8fff-ffffffffffff', 'query', 'drill', '2026-11-20T12:00:10Z');
""",
}


# ---------------------------------------------------------------------------
# The drill
# ---------------------------------------------------------------------------
class Drill:
    """One isolated backup/restore drill. Subclassed in tests to fake the seams."""

    def __init__(self, args: argparse.Namespace, *, plan: Plan | None = None):
        self.args = args
        self.plan = plan or build_plan(args)
        self.run_id = self.plan.run_id
        self.docker: str | None = None
        self.deadline = time.monotonic() + self.plan.timeout
        self._tearing_down = False
        self.password = secrets.token_hex(16)
        self.host_port = 0
        # Ownership is recorded the moment Docker returns an id, not when the
        # start sequence finishes: a failure on the next step still lets teardown
        # remove exactly the container this run created.
        self.container_id: str | None = None
        # Set only when this run actually created the run-owned scratch
        # directory, so teardown never removes a directory it did not make.
        self.workdir_created = False
        # Archives this run wrote. Teardown unlinks exactly these and nothing
        # else, so a pre-existing file at a planned path is never deleted.
        self.created_archives: set[Path] = set()

    # -- process seams -----------------------------------------------------
    def _clock(self) -> float:
        return time.monotonic()

    def _sleep(self, seconds: float) -> None:
        time.sleep(seconds)

    def _remaining(self) -> float:
        remaining = self.deadline - self._clock()
        if self._tearing_down:
            return max(remaining, 60.0)
        return remaining

    def _docker(self, argv, *, timeout=None, stdin=None, env=None):
        remaining = self._remaining()
        limit = remaining if timeout is None else min(remaining, timeout)
        if limit <= 0:
            raise DrillError("the overall timeout was reached before a docker command could run")
        if self.docker is None:
            raise DrillError("the docker binary was not resolved before a command was run")
        child = dict(os.environ)
        if env:
            child.update(env)
        try:
            proc = subprocess.run(
                [self.docker, *argv],
                env=child,
                input=stdin.encode("utf-8") if stdin is not None else None,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=limit,
            )
        except subprocess.TimeoutExpired:
            raise DrillError("docker command timed out: " + " ".join(argv[:2])) from None
        except OSError as error:
            raise DrillError(f"docker command failed to start: {type(error).__name__}") from None
        output = proc.stdout.decode("utf-8", "replace") if proc.stdout else ""
        return proc.returncode, output

    def _docker_to_fd(self, argv, *, descriptor, timeout=None):
        """Run one docker command writing stdout straight into ``descriptor``.

        A custom-format dump is binary, so this path never decodes and never
        holds the archive in memory: the bytes go from the command into the file
        descriptor this run claimed, and only stderr is kept for the failure
        message. Buffering a dump here would mean two copies of every backup.
        """
        remaining = self._remaining()
        limit = remaining if timeout is None else min(remaining, timeout)
        if limit <= 0:
            raise DrillError("the overall timeout was reached before a docker command could run")
        if self.docker is None:
            raise DrillError("the docker binary was not resolved before a command was run")
        try:
            proc = subprocess.run(
                [self.docker, *argv],
                stdout=descriptor,
                stderr=subprocess.PIPE,
                timeout=limit,
            )
        except subprocess.TimeoutExpired:
            raise DrillError("docker command timed out: " + " ".join(argv[:2])) from None
        except OSError as error:
            raise DrillError(f"docker command failed to start: {type(error).__name__}") from None
        return proc.returncode, proc.stderr or b""

    def _exec_to_fd(self, container, argv, *, descriptor, timeout=None):
        """Run one command inside the container, streaming its stdout into a descriptor."""
        return self._docker_to_fd(["exec", container, *argv], descriptor=descriptor, timeout=timeout)

    def _exec(self, container, argv, *, timeout=None, stdin=None):
        return self._docker(["exec", "--interactive", container, *argv], timeout=timeout, stdin=stdin)

    def _psql(self, container, database, sql, *, single_transaction=False, cleanup=False):
        argv = ["psql", "-X", "-q", "-A", "-t", "-F", "|", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database]
        if single_transaction:
            argv.insert(1, "-1")
        argv += ["-f", "-"]
        if cleanup:
            self._tearing_down = True
        code, output = self._exec(container, argv, timeout=120 if cleanup else None, stdin=sql)
        if code != 0:
            raise DrillError(f"psql failed on the {database} database: {output.strip()[-800:]}")
        return output

    def _rows(self, output: str, *, fields: int) -> list[list[str]]:
        """Parse ``psql -A -t -F '|'`` output, refusing an unexpected shape."""
        rows: list[list[str]] = []
        for line in (output or "").splitlines():
            if not line.strip():
                continue
            parts = line.split("|", fields - 1)
            if len(parts) != fields:
                continue  # a psql command tag such as SET, never a row
            rows.append(parts)
        return rows

    # -- environment -------------------------------------------------------
    def check_environment(self) -> None:
        self.docker = shutil.which("docker")
        if self.docker is None:
            raise DrillError("the Docker CLI is not on PATH; the drill runs its PostgreSQL inside an isolated container")
        if not (ROOT / "docker-compose.yml").is_file():
            raise DrillError(f"{ROOT} is not the backend root: docker-compose.yml is missing")
        self.migrations = database_migration_plan(SERVICES_ROOT)
        for database in self.plan.source_databases:
            if database not in self.migrations:
                raise DrillError(
                    f"there is no migration plan for {database!r}; the drill migrates only the services it knows"
                )

    # -- lifecycle ---------------------------------------------------------
    def start_container(self) -> str:
        argv = [
            "run",
            "--detach",
            "--name",
            self.plan.container_name,
            "--label",
            VERIFY_LABEL + "=1",
            "--label",
            f"{RUN_LABEL}={self.run_id}",
            "--publish",
            f"127.0.0.1::{POSTGRES_PORT}",
            "--mount",
            f"type=bind,source={self._container_path(self.plan.workdir)},target={DRILL_MOUNT}",
            "-e",
            "POSTGRES_USER=postgres",
            "-e",
            "POSTGRES_PASSWORD",
            self.plan.image,
        ]
        env = {"POSTGRES_PASSWORD": self.password}
        code, output = self._docker(argv, env=env)
        if code != 0:
            raise DrillError(f"failed to start the drill container {self.plan.container_name}: {output.strip()[-800:]}")
        container_id = self._container_id_from(output)
        self.container_id = container_id
        code, ports = self._docker(["port", container_id, f"{POSTGRES_PORT}/tcp"])
        if code != 0:
            raise DrillError(f"failed to read the published port of {container_id}: {ports.strip()[-400:]}")
        self.host_port = parse_published_port(ports, container=container_id, container_port=POSTGRES_PORT)
        return container_id

    @staticmethod
    def _container_path(path: Path) -> str:
        return str(path.resolve()).replace("\\", "/")

    @staticmethod
    def _container_id_from(output: str) -> str:
        for line in reversed((output or "").splitlines()):
            candidate = line.strip()
            if re.fullmatch(r"[0-9a-f]{12,64}", candidate):
                return candidate
        raise DrillError("the container was created but Docker returned no container id to own it by")

    def wait_ready(self, container) -> None:
        deadline = self._clock() + min(self.plan.ready_timeout, max(1.0, self._remaining()))
        last = ""
        while self._clock() < deadline:
            code, output = self._exec(
                container,
                ["pg_isready", "-h", "127.0.0.1", "-p", str(POSTGRES_PORT), "-U", "postgres", "-d", "postgres"],
                timeout=30,
            )
            if code == 0:
                return
            last = output.strip()[-200:]
            self._sleep(self.plan.poll_interval)
        raise DrillError(
            f"the drill container did not accept a TCP connection within {self.plan.ready_timeout}s"
            + (f": {last}" if last else "")
        )

    def provision(self, container) -> None:
        self._psql(container, "postgres", ROLES_SCRIPT)
        database_script = "-- drill:databases\n" + "".join(
            f'CREATE DATABASE "{database}";\n' for database in self.plan.source_databases
        )
        self._psql(container, "postgres", database_script)

    def apply_migrations(self, container) -> None:
        for database in self.plan.source_databases:
            script = migration_script(self.migrations[database], database)
            self._psql(container, database, script)

    def seed(self, container) -> None:
        for database in self.plan.source_databases:
            script = SEED_SCRIPTS.get(database)
            if script is None:
                raise DrillError(f"there is no drill seed for {database!r}: the row comparison needs representative rows")
            self._psql(container, database, script)

    def dump(self, container, database, archive: Path) -> None:
        """Claim the archive on the host, then stream ``pg_dump`` into it.

        The claim is what makes the write safe. ``O_CREAT | O_EXCL`` fails if
        anything already occupies the path, so a file that appeared after the
        preflight is refused instead of overwritten and later deleted as if this
        run had written it. ``pg_dump`` writes to stdout and never to the bind
        mount, so no process inside the container can create the file either: the
        only creator is this descriptor.
        """
        _refuse_symlink_components(archive, label=f"the backup archive path {archive}")
        try:
            descriptor = os.open(
                archive,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0),
                0o600,
            )
        except FileExistsError:
            raise DrillError(
                f"refusing to overwrite {archive}: it appeared after the preflight and this run did not write it"
            ) from None
        except OSError as error:
            raise DrillError(f"could not claim the backup archive {archive}: {type(error).__name__}") from None
        # Recorded only after the exclusive claim succeeded: a path this run never
        # created is a path this run must never delete.
        self.created_archives.add(archive)
        try:
            code, error_output = self._exec_to_fd(
                container,
                ["pg_dump", "-Fc", "--no-owner", "-d", database, "-U", "postgres"],
                descriptor=descriptor,
            )
        finally:
            # The descriptor is still ours until here; ``pg_dump`` wrote into it
            # directly, so there is no buffered copy to flush.
            os.close(descriptor)
        if code != 0:
            detail = error_output.decode("utf-8", "replace").strip()[-800:]
            raise DrillError(f"pg_dump failed for {database}: {detail}")

    def list_archive(self, container, archive: Path, *, database: str) -> TocSummary:
        target = DRILL_MOUNT + "/" + archive.relative_to(self.plan.workdir).as_posix()
        code, output = self._exec(container, ["pg_restore", "--list", target])
        if code != 0:
            raise DrillError(
                f"pg_restore --list could not read {archive.name} for {database}: the archive is truncated "
                "or not a custom-format dump"
                + (f": {output.strip()[-400:]}" if output.strip() else "")
            )
        return summarise_toc(output)

    def create_scratch(self, container, database: str) -> None:
        rows = self._rows(self._psql(container, "postgres", exists_script(database)), fields=1)
        if not rows or not rows[0][0].isdigit():
            raise DrillError(f"could not read whether {database} exists: the drill never creates a database blind")
        if int(rows[0][0]) != 0:
            raise DrillError(
                f"the restore target {database} already exists; a restore never reuses or drops a database "
                "the drill did not create in this run"
            )
        self._psql(container, "postgres", create_script(database))

    def restore(self, container, database: str, archive: Path) -> None:
        target = DRILL_MOUNT + "/" + archive.relative_to(self.plan.workdir).as_posix()
        argv = ["pg_restore", "--clean", "--if-exists", "--no-owner", "-U", "postgres", "-d", database, target]
        code, output = self._exec(container, argv)
        if code != 0:
            raise DrillError(f"pg_restore failed for {database}: {output.strip()[-1200:]}")

    # -- census ------------------------------------------------------------
    def census(self, container, target: str, *, label: str | None = None) -> DatabaseCensus:
        """Read the schema and the row digests of ``target`` as ``label``."""
        database = label or target
        relations = [
            (row[0], row[1])
            for row in self._rows(self._psql(container, target, TABLES_SCRIPT), fields=2)
        ]
        if not relations:
            raise DrillError(
                f"the database {target} holds no service table: a restore that produced no schema is a failure, "
                "not an empty success"
            )
        relations = [relation for relation in relations if f"{relation[0]}.{relation[1]}" not in EXTENSION_RELATIONS]

        ledger_rows = self._rows(self._psql(container, target, LEDGER_SCRIPT), fields=1)
        versions: list[int] = []
        for row in ledger_rows:
            if not row[0].strip().isdigit():
                raise DrillError(f"the schema_migrations ledger of {target} holds a non-numeric version: {row[0]!r}")
            versions.append(int(row[0]))

        digest_rows = self._rows(self._psql(container, target, digest_script(relations)), fields=3)
        if len(digest_rows) != len(relations):
            raise DrillError(
                f"the digest census of {target} returned {len(digest_rows)} rows for {len(relations)} tables: "
                "a dropped statement would otherwise read as an equal digest"
            )
        tables: dict[str, TableDigest] = {}
        for relation, count, chain in digest_rows:
            rows_count = int(count)
            if len(chain) != HASH_BYTES * rows_count:
                raise DrillError(
                    f"the digest chain of {relation} in {target} holds {len(chain)} characters for {rows_count} "
                    f"rows: {HASH_BYTES} hex characters per row are expected, so the chain is corrupt"
                )
            tables[relation] = TableDigest(rows=rows_count, digest=hashlib.sha256(chain.encode("utf-8")).hexdigest())

        present = {f"{schema}.{name}" for schema, name in relations}
        configured_geometry = GEOMETRY_COLUMNS.get(database, {})
        missing_geometry = sorted(set(configured_geometry) - present)
        if missing_geometry:
            raise DrillError(
                f"the PostGIS geometry of {', '.join(missing_geometry)} cannot be verified in {target}: "
                "the relation is missing, so the geometry assertion would pass vacuously"
            )
        geometry: dict[str, TableDigest] = {}
        if configured_geometry:
            geometry_rows = self._rows(
                self._psql(container, target, geometry_script(configured_geometry)), fields=3
            )
            if len(geometry_rows) != len(configured_geometry):
                raise DrillError(
                    f"the geometry census of {target} returned {len(geometry_rows)} rows for "
                    f"{len(configured_geometry)} columns"
                )
            for relation, count, chain in geometry_rows:
                rows_count = int(count)
                geometry[relation] = TableDigest(
                    rows=rows_count, digest=hashlib.sha256(chain.encode("utf-8")).hexdigest()
                )

        schema_rows = self._rows(self._psql(container, target, SCHEMA_SCRIPT), fields=2)
        if not schema_rows:
            raise DrillError(f"the schema census of {target} returned no object: verification cannot be skipped")
        return DatabaseCensus(
            database=database,
            ledger=tuple(versions),
            tables=tables,
            geometry=geometry,
            schema=tuple(f"{kind}|{text}" for kind, text in schema_rows),
        )

    # -- teardown ----------------------------------------------------------
    def prepare_workdir(self) -> None:
        """Create the run-owned scratch directory, or prove an explicit one exists.

        This is deliberately not part of ``build_plan``: the plan is what
        ``--dry-run`` prints, and a dry run must not create anything. It runs
        after every preflight guard, immediately before the container that needs
        the directory as a bind mount.
        """
        workdir = self.plan.workdir
        if not self.plan.workdir_owned:
            if not workdir.is_dir():
                raise DrillError(
                    f"the scratch directory {workdir} does not exist; an explicit --workdir must already exist"
                )
            return
        if self.plan.workdir_owned:
            # Re-checked here, after every preflight guard and immediately before
            # the create: the entry can change between preflight and now.
            _refuse_symlink_components(workdir, label=f"the scratch directory {workdir}")
            if workdir.is_symlink() or workdir.exists():
                raise DrillError(
                    f"the derived scratch directory {workdir} appeared after the preflight; refusing to reuse or remove it"
                )
            try:
                # os.mkdir is atomic and never follows a symlink at the leaf: a
                # dangling link fails with FileExistsError instead of creating its
                # target, which Path.mkdir on a pre-resolved path could not promise.
                os.mkdir(workdir, 0o700)
            except FileExistsError:
                raise DrillError(
                    f"refusing to create {workdir}: a path appeared at that entry after the preflight"
                ) from None
            except OSError as error:
                raise DrillError(
                    f"the drill could not create its scratch directory {workdir}: {type(error).__name__}"
                ) from None
            self.workdir_created = True
            return

    def clean_workdir(self) -> list[str]:
        """Remove what this run wrote, and nothing else.

        A derived directory belongs to the run, so it is removed whole once it is
        proven to be the one this run created. An explicit ``--workdir`` belongs
        to the operator: only the archives this run wrote are unlinked, and the
        directory itself stays.
        """
        if self.plan.keep:
            return []
        workdir = self.plan.workdir
        if self.plan.workdir_owned:
            if not self.workdir_created:
                return []
            expected_parent = Path(tempfile.gettempdir()).resolve(strict=False)
            expected_name = CONTAINER_PREFIX + self.plan.run_id
            if workdir.name != expected_name or workdir.parent.resolve(strict=False) != expected_parent:
                return [f"refusing to remove {workdir}: it is not the directory this run created"]
            try:
                shutil.rmtree(workdir)
            except OSError as error:
                return [f"scratch directory {workdir}: {type(error).__name__}"]
            return []
        failures: list[str] = []
        for archive in self.plan.archives.values():
            if archive not in self.created_archives:
                continue
            try:
                if archive.is_symlink() or not archive.is_file():
                    continue
                archive.unlink()
            except OSError as error:
                failures.append(f"archive {archive}: {type(error).__name__}")
        return failures

    def teardown(self, container, owned: Sequence[str]) -> list[str]:
        failures: list[str] = []
        self._tearing_down = True
        if container:
            for database in reversed(list(owned)):
                try:
                    self._psql(container, "postgres", drop_script(database), cleanup=True)
                except DrillError as error:
                    failures.append(str(error))
            if not self.plan.keep:
                try:
                    code, output = self._docker(["rm", "--force", "--volumes", container], timeout=120)
                except DrillError as error:
                    failures.append(str(error))
                else:
                    if code != 0:
                        failures.append(f"container {container}: {output.strip()[-200:] or f'exit {code}'}")
        failures += self.clean_workdir()
        return failures

    # -- the run -----------------------------------------------------------
    def run(self) -> RecoveryReport:
        container = None
        owned: list[str] = []
        try:
            self.check_environment()
            self.prepare_workdir()
            container = self.start_container()
            self.wait_ready(container)
            self.provision(container)
            self.apply_migrations(container)
            self.seed(container)

            sources: dict[str, DatabaseCensus] = {}
            dumps: dict[str, tuple[float, float, int, int]] = {}
            for database in self.plan.source_databases:
                sources[database] = self.census(container, database)
                expectation = self.plan.ledger_expectations.get(database)
                if expectation is not None:
                    check_ledger(database, sources[database].ledger, expectation)
                archive = self.plan.archives[database]
                started = self._clock()
                self.dump(container, database, archive)
                finished = self._clock()
                size = validate_archive_file(archive)
                toc = self.list_archive(container, archive, database=database)
                evaluate_toc(toc, list(sources[database].tables), archive=archive.name)
                dumps[database] = (finished - started, finished, size, toc.entries)

            # The restore and the verification are timed apart, because the
            # report claims two different phases: a restore duration and a
            # verification duration. Reading both clocks on consecutive lines
            # would report a verification of 0.000s that never happened.
            restore_started = self._clock()
            for database in self.plan.source_databases:
                scratch = self.plan.scratch_databases[database]
                self.create_scratch(container, scratch)
                owned.append(scratch)
                self.restore(container, scratch, self.plan.archives[database])
            restores_completed = self._clock()

            records: list[DatabaseRecord] = []
            problems: list[str] = []
            for database in self.plan.source_databases:
                scratch = self.plan.scratch_databases[database]
                restored = self.census(container, scratch, label=database)
                expectation = self.plan.ledger_expectations.get(database)
                if expectation is not None:
                    try:
                        check_ledger(database, restored.ledger, expectation)
                    except DrillError as error:
                        problems.append(str(error))
                schema_differences = compare_schema(sources[database], restored)
                if schema_differences:
                    problems.append(
                        f"schema verification failed for {database}: " + "; ".join(schema_differences)
                    )
                content_differences = compare_content(sources[database], restored)
                if content_differences:
                    problems.append(
                        f"row verification failed for {database}: " + "; ".join(content_differences)
                    )
                dump_seconds, finished, size, toc_entries = dumps[database]
                records.append(
                    DatabaseRecord(
                        database=database,
                        scratch=scratch,
                        tables=len(sources[database].tables),
                        archive_bytes=size,
                        toc_entries=toc_entries,
                        ledger=sources[database].ledger,
                    )
                )
            verified_at = self._clock()
            if problems:
                raise DrillError("the restored database does not match its backup: " + " | ".join(problems))

            measurement = Measurement(
                dump_seconds=max(dumps[database][0] for database in dumps),
                backup_age_seconds=restore_started - min(dumps[database][1] for database in dumps),
                restore_seconds=restores_completed - restore_started,
                verification_seconds=verified_at - restores_completed,
            )
            evaluate_rpo(measurement, limit=self.plan.max_rpo_seconds)
            evaluate_rto(measurement, limit=self.plan.max_rto_seconds)
            return RecoveryReport(
                container=self.plan.container_name,
                workdir=self.plan.workdir,
                host_port=self.host_port,
                measurement=measurement,
                records=tuple(records),
                max_rpo_seconds=self.plan.max_rpo_seconds,
                max_rto_seconds=self.plan.max_rto_seconds,
            )
        finally:
            failures = self.teardown(self.container_id or container, owned)
            if failures:
                if sys.exc_info()[0] is not None:
                    print("WARN: teardown left resources behind: " + "; ".join(failures), file=sys.stderr)
                else:
                    raise DrillError("teardown left resources behind: " + "; ".join(failures))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _positive_seconds(raw: str) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise argparse.ArgumentTypeError("must be a positive whole number of seconds") from None
    if value <= 0:
        raise argparse.ArgumentTypeError("must be a positive whole number of seconds")
    return value


def _ceiling_seconds(ceiling: int):
    """Return an argparse type accepting 1..ceiling, so no flag can weaken the acta."""

    def parse(raw: str) -> int:
        try:
            value = int(raw)
        except (TypeError, ValueError):
            raise argparse.ArgumentTypeError(f"must be a whole number of seconds in 1..{ceiling}") from None
        if value <= 0 or value > ceiling:
            raise argparse.ArgumentTypeError(
                f"must be a whole number of seconds in 1..{ceiling}: acta-cierre section 7 fixes {ceiling}s as the ceiling "
                "and a flag may only tighten it"
            )
        return value

    return parse


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        prog="verify_db_backup_restore.py",
        description=(
            "Run the FireWatch backup/restore drill against an isolated PostGIS container: "
            "pg_dump -Fc, pg_restore --list, a scratch database the run creates, a restore, "
            "a schema assertion, a row and geometry equality assertion, and the measured "
            "dump and recovery durations against RPO 15 min / RTO 1 h."
        ),
    )
    parser.add_argument("--workdir", metavar="DIR", help="explicit scratch/output directory holding the archives and the dump")
    parser.add_argument("--run-id", metavar="ID", help="lowercase run id [a-z0-9]{6,16}; derived from the clock when omitted")
    parser.add_argument("--host", default="127.0.0.1", metavar="HOST", help="target host; must be loopback (default: 127.0.0.1)")
    parser.add_argument("--image", default=POSTGIS_IMAGE, metavar="IMAGE", help=f"PostGIS image (default: {POSTGIS_IMAGE})")
    parser.add_argument(
        "--database",
        action="append",
        metavar="NAME",
        help=f"source database to dump and restore; repeatable (default: {', '.join(DEFAULT_DATABASES)})",
    )
    parser.add_argument(
        "--scratch-database",
        action="append",
        metavar="NAME",
        help="restore target; must match ^firewatch_restore_drill_[a-z0-9_]{6,32}$; repeatable, one per --database",
    )
    parser.add_argument(
        "--archive",
        action="append",
        metavar="PATH",
        help="dump path inside --workdir; repeatable, one per --database (default: <database>.dump)",
    )
    parser.add_argument(
        "--expect-ledger",
        action="append",
        metavar="DATABASE=FROM-TO",
        help="expected contiguous schema_migrations range (default: risk=1-19, jobs=1-7)",
    )
    parser.add_argument(
        "--container-name",
        metavar="NAME",
        help=f"container name; must match {CONTAINER_PATTERN.pattern} (default: fw-v1f14-<run id>)",
    )
    parser.add_argument(
        "--max-rpo-seconds",
        type=_ceiling_seconds(RPO_CEILING_SECONDS),
        default=RPO_CEILING_SECONDS,
        metavar="SECONDS",
        help=(
            f"recovery point objective threshold, 1..{RPO_CEILING_SECONDS} (default: {RPO_CEILING_SECONDS}); "
            "a flag may only tighten the acta §7 ceiling"
        ),
    )
    parser.add_argument(
        "--max-rto-seconds",
        type=_ceiling_seconds(RTO_CEILING_SECONDS),
        default=RTO_CEILING_SECONDS,
        metavar="SECONDS",
        help=(
            f"recovery time objective threshold, 1..{RTO_CEILING_SECONDS} (default: {RTO_CEILING_SECONDS}); "
            "a flag may only tighten the acta §7 ceiling"
        ),
    )
    parser.add_argument("--timeout", type=_positive_seconds, default=DEFAULT_TIMEOUT, metavar="SECONDS", help="overall deadline")
    parser.add_argument(
        "--ready-timeout", type=_positive_seconds, default=DEFAULT_READY_TIMEOUT, metavar="SECONDS", help="PostgreSQL readiness deadline"
    )
    parser.add_argument("--poll-interval", type=_positive_seconds, default=DEFAULT_POLL_INTERVAL, metavar="SECONDS", help="readiness poll interval")
    parser.add_argument("--keep", action="store_true", help="leave the container in place for inspection instead of removing it")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="run every structural guard and print the plan without creating a container or touching a database",
    )
    args = parser.parse_args(argv)
    if not args.database:
        args.database = list(DEFAULT_DATABASES)
    if not args.scratch_database:
        args.scratch_database = []
    if not args.archive:
        args.archive = []
    if not args.expect_ledger:
        args.expect_ledger = []
    return args


def format_plan(plan: Plan) -> str:
    lines = [
        "drill plan",
        f"  run id:        {plan.run_id}",
        f"  container:     {plan.container_name}",
        f"  image:         {plan.image}",
        f"  host:          {plan.host}:<ephemeral> (published on 127.0.0.1::{POSTGRES_PORT})",
        f"  workdir:       {plan.workdir}",
        f"  objectives:    RPO <= {plan.max_rpo_seconds}s / RTO <= {plan.max_rto_seconds}s (acta-cierre section 7 ceilings)",
    ]
    for database in plan.source_databases:
        span = plan.ledger_expectations.get(database)
        expectation = f"{span[0]}..{span[1]}" if span else "not checked"
        lines.append(
            f"  {database}: dump {plan.archives[database].name} -> restore into "
            f"{plan.scratch_databases[database]} (ledger {expectation})"
        )
    return "\n".join(lines)


def format_report(report: RecoveryReport) -> str:
    measurement = report.measurement
    lines = [
        "PASS: the restore matched its backup and both objectives held.",
        f"  container:      {report.container} (127.0.0.1:{report.host_port} while it existed)",
        f"  workdir:        {report.workdir}",
        f"  dump duration:  {measurement.dump_seconds:.3f}s       (RPO ceiling {report.max_rpo_seconds}s)",
        f"  backup age:     {measurement.backup_age_seconds:.3f}s       (RPO ceiling {report.max_rpo_seconds}s)",
        f"  restore:        {measurement.restore_seconds:.3f}s",
        f"  verification:   {measurement.verification_seconds:.3f}s",
        f"  recovery total: {measurement.recovery_seconds:.3f}s       (RTO ceiling {report.max_rto_seconds}s)",
    ]
    for record in report.records:
        lines.append(
            f"  {record.database}: {record.tables} tables, ledger {record.ledger[0] if record.ledger else '-'}"
            f"..{record.ledger[-1] if record.ledger else '-'}, {record.archive_bytes} bytes, "
            f"{record.toc_entries} TOC entries, scratch {record.scratch}"
        )
    lines.append(
        "  limits: local isolated container only; Cloud Storage delivery, 30-day retention, "
        "encryption at rest and the scheduled CronJob remain unimplemented and are not measured here."
    )
    return "\n".join(lines)


def main(argv=None, *, drill_class=Drill) -> int:
    args = parse_args(argv)
    try:
        plan = build_plan(args)
    except DrillError as error:
        print("FAIL: " + str(error), file=sys.stderr)
        return 1
    if plan.dry_run:
        print(format_plan(plan))
        print("DRY-RUN: every structural guard passed; no container was created and no database was touched.")
        return 0
    drill = drill_class(args, plan=plan)
    try:
        report = drill.run()
    except DrillError as error:
        print("FAIL: " + str(error), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("FAIL: interrupted", file=sys.stderr)
        return 130
    print(format_report(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
