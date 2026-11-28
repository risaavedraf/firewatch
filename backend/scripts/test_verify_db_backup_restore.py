"""Contracts for ``verify_db_backup_restore.py``, without Docker.

``verify_db_backup_restore.py`` is the local, fail-closed automation of the
backup policy written in ``acta-cierre.md`` §7: ``pg_dump``/``pg_restore`` with
destructive-target guards, a schema assertion and a row-equality assertion, and
a measured recovery time contrasted with RPO 15 min / RTO 1 h.

The destructive half of that sentence is the part this file pins. A restore
harness that guesses wrong once destroys a database, so every guard is tested
for the *refusal* it must produce, not only for its happy path:

* the restore target must match the strict scratch shape and must never be a
  source database, ``firewatch``, ``postgres``, ``template0`` or ``template1``;
* the host must be loopback, and a non-loopback target is allowed only when
  nothing is mutated;
* the archive must resolve inside the explicit scratch directory, must not be a
  symlink and must not be empty or below the minimum size, and its TOC must
  list the tables it claims to hold;
* the ledger, the schema fingerprint, the row digests and the PostGIS geometry
  digests must all compare equal, and a single corrupted or missing row must
  fail the comparison;
* the measured dump duration, backup age and recovery duration must be real
  numbers, and a value above its objective is a failure rather than a rounded
  success;
* the structural guards run **before** any container is created, and
  ``--dry-run`` runs the very same guards instead of skipping them.

Two layers are exercised. The pure functions are tested directly. The drill
itself is driven in-process against a fake Docker seam that models the census
of a source and a restored database, so the ordering the drill depends on -
guards, dump, TOC, scratch create, restore, compare, teardown - is observed as
a command log rather than assumed.

What is *not* covered here: the real Docker/PostGIS round trip. That is the live
drill the script performs, and no test in this file starts a container.

Run with::

    python -m pytest backend/scripts/test_verify_db_backup_restore.py
"""
from __future__ import annotations

import hashlib
import os
import re
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from typing import cast
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_db_backup_restore as drill  # noqa: E402  (the module under test)

RUN_ID = "abcd1234"
SCRATCH = "firewatch_restore_drill_" + RUN_ID + "_risk"


def symlink_supported() -> bool:
    """Return whether this host lets the process create a symlink."""
    with tempfile.TemporaryDirectory() as tmp:
        try:
            os.symlink(os.path.join(tmp, "target"), os.path.join(tmp, "link"))
        except (OSError, NotImplementedError):
            return False
        return True


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def table(rows: int, seed: str) -> drill.TableDigest:
    return drill.TableDigest(rows=rows, digest=digest(f"{seed}:{rows}"))


def census(database: str = "risk", **overrides) -> drill.DatabaseCensus:
    base = {
        "database": database,
        "ledger": (1, 2, 3),
        "tables": {"public.zones": table(2, "zones")},
        "geometry": {"public.zones": table(2, "zones-geometry")},
        "schema": ("relation|public.zones:BASE TABLE",),
    }
    base.update(overrides)
    return drill.DatabaseCensus(**base)



class ScratchDatabaseGuardTests(unittest.TestCase):
    """The restore target is refused unless it is provably a scratch name."""

    def test_accepts_the_strict_scratch_shape(self):
        self.assertEqual(drill.validate_scratch_database(SCRATCH, source_databases=("risk", "jobs")), SCRATCH)

    def test_accepts_six_and_thirty_two_character_suffixes(self):
        for suffix in ("abcdef", "a" * 32, "abc_123", "0" * 32):
            name = "firewatch_restore_drill_" + suffix
            self.assertEqual(drill.validate_scratch_database(name), name)

    def test_rejects_the_production_and_cluster_database_names(self):
        for name in ("firewatch", "postgres", "template0", "template1"):
            with self.subTest(name=name), self.assertRaises(drill.DrillError):
                drill.validate_scratch_database(name)

    def test_rejects_the_source_databases(self):
        for name in ("risk", "jobs", "prevention"):
            with self.subTest(name=name), self.assertRaises(drill.DrillError):
                drill.validate_scratch_database(name, source_databases=("risk", "jobs"))

    def test_rejects_a_scratch_name_that_is_also_a_source_database(self):
        with self.assertRaises(drill.DrillError):
            drill.validate_scratch_database(SCRATCH, source_databases=(SCRATCH,))

    def test_rejects_short_suffix(self):
        with self.assertRaises(drill.DrillError):
            drill.validate_scratch_database("firewatch_restore_drill_abcde")

    def test_rejects_long_suffix(self):
        with self.assertRaises(drill.DrillError):
            drill.validate_scratch_database("firewatch_restore_drill_" + "a" * 33)

    def test_rejects_empty_missing_and_blank_names(self):
        for name in ("", "   ", None):
            with self.subTest(name=name), self.assertRaises(drill.DrillError):
                drill.validate_scratch_database(name)

    def test_rejects_uppercase_dashes_and_spaces(self):
        for name in (
            "Firewatch_restore_drill_abc123",
            "firewatch_restore_drill_ABC123",
            "firewatch_restore_drill_abc-123",
            "firewatch restore drill abc123",
        ):
            with self.subTest(name=name), self.assertRaises(drill.DrillError):
                drill.validate_scratch_database(name)

    def test_rejects_the_prefix_anywhere_but_the_start(self):
        for name in ("xfirewatch_restore_drill_abc123", "public.firewatch_restore_drill_abc123"):
            with self.subTest(name=name), self.assertRaises(drill.DrillError):
                drill.validate_scratch_database(name)

    def test_rejects_quotes_semicolons_and_newlines(self):
        for name in (
            'firewatch_restore_drill_abc123";DROP DATABASE risk;--',
            "firewatch_restore_drill_abc123\nDROP DATABASE risk",
            "firewatch_restore_drill_abc123;",
        ):
            with self.subTest(name=name), self.assertRaises(drill.DrillError):
                drill.validate_scratch_database(name)

    def test_rejects_reserved_names_case_insensitively(self):
        with self.assertRaises(drill.DrillError):
            drill.validate_scratch_database("POSTGRES")


class HostGuardTests(unittest.TestCase):
    """A mutating drill may only address loopback."""

    def test_accepts_loopback_spellings(self):
        for host in ("127.0.0.1", "localhost", "::1", "[::1]"):
            with self.subTest(host=host):
                self.assertEqual(drill.validate_host(host, will_mutate=True), host)

    def test_rejects_non_loopback_when_mutating(self):
        for host in (
            "0.0.0.0",  # noqa: S104 - the guard must refuse it
            "10.1.2.3",
            "db.example.com",
            "host.docker.internal",
            "127.0.0.1.nip.io",
            "localhost.evil.example",
            "",
            None,
        ):
            with self.subTest(host=host), self.assertRaises(drill.DrillError):
                drill.validate_host(host, will_mutate=True)

    def test_allows_non_loopback_only_when_nothing_is_mutated(self):
        self.assertEqual(drill.validate_host("db.example.com", will_mutate=False), "db.example.com")

    def test_published_port_mapping_must_be_loopback(self):
        self.assertEqual(drill.parse_published_port("127.0.0.1:55432\n", container="c", container_port=5432), 55432)
        for output in ("0.0.0.0:55432\n", "172.17.0.2:55432\n", "", "garbage\n", "127.0.0.1:0\n"):
            with self.subTest(output=output), self.assertRaises(drill.DrillError):
                drill.parse_published_port(output, container="c", container_port=5432)

    def test_published_port_refuses_an_ambiguous_mapping(self):
        with self.assertRaises(drill.DrillError):
            drill.parse_published_port(
                "127.0.0.1:55432\n127.0.0.1:55433\n", container="c", container_port=5432
            )


class ContainerNameTests(unittest.TestCase):
    def test_accepts_the_drill_shape(self):
        for name in ("fw-v1f14-abcd1234", "fw-v1f14-" + "a" * 32):
            with self.subTest(name=name):
                self.assertEqual(drill.validate_container_name(name), name)

    def test_rejects_names_outside_the_drill_prefix(self):
        for name in ("firewatch-synthetic-verify-abc", "postgres", "fw-v14f-abc123", "fw-v1f14-", "fw-v1f14-ABC123"):
            with self.subTest(name=name), self.assertRaises(drill.DrillError):
                drill.validate_container_name(name)

    def test_derived_names_are_unique_per_run(self):
        first = drill.container_name_for("abcd1234")
        second = drill.container_name_for("abcd1235")
        self.assertNotEqual(first, second)
        self.assertEqual(first, "fw-v1f14-abcd1234")
        self.assertEqual(drill.validate_container_name(first), first)


class WorkdirAndArchiveContainmentTests(unittest.TestCase):
    """The backup archive resolves inside the scratch directory, or not at all."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.workdir = self.root / "work"
        self.workdir.mkdir()

    def test_resolves_a_bare_file_name_inside_the_workdir(self):
        resolved = drill.resolve_archive_path("risk.dump", workdir=self.workdir)
        self.assertEqual(resolved, (self.workdir / "risk.dump").resolve(strict=False))
        self.assertEqual(resolved.name, "risk.dump")

    def test_resolves_a_relative_subdirectory_inside_the_workdir(self):
        resolved = drill.resolve_archive_path("backups/risk.dump", workdir=self.workdir)
        self.assertEqual(resolved, (self.workdir / "backups" / "risk.dump").resolve(strict=False))

    def test_resolves_an_absolute_path_inside_the_workdir(self):
        target = self.workdir / "risk.dump"
        self.assertEqual(drill.resolve_archive_path(str(target), workdir=self.workdir), target.resolve(strict=False))

    def test_returns_a_canonical_path_inside_the_canonical_workdir(self):
        resolved = drill.resolve_archive_path("risk.dump", workdir=self.workdir)
        self.assertTrue(resolved.is_relative_to(self.workdir.resolve()))

    def test_rejects_an_absolute_path_outside_the_workdir(self):
        with self.assertRaises(drill.DrillError):
            drill.resolve_archive_path(str(self.root / "elsewhere.dump"), workdir=self.workdir)

    def test_rejects_traversal_even_when_it_lands_inside(self):
        with self.assertRaises(drill.DrillError):
            drill.resolve_archive_path("nested/../risk.dump", workdir=self.workdir)

    def test_rejects_traversal_out_of_the_workdir(self):
        with self.assertRaises(drill.DrillError):
            drill.resolve_archive_path("../risk.dump", workdir=self.workdir)

    def test_rejects_empty_and_blank_names(self):
        for raw in ("", "   ", None):
            with self.subTest(raw=raw), self.assertRaises(drill.DrillError):
                drill.resolve_archive_path(raw, workdir=self.workdir)

    def test_rejects_the_workdir_itself_and_a_trailing_separator(self):
        with self.assertRaises(drill.DrillError):
            drill.resolve_archive_path(str(self.workdir), workdir=self.workdir)
        with self.assertRaises(drill.DrillError):
            drill.resolve_archive_path("nested/", workdir=self.workdir)

    def test_rejects_a_workdir_that_is_a_file(self):
        file_path = self.root / "file"
        file_path.write_text("x", encoding="utf-8")
        with self.assertRaises(drill.DrillError):
            drill.validate_workdir(file_path, must_exist=True)

    def test_rejects_a_missing_workdir_when_it_must_exist(self):
        with self.assertRaises(drill.DrillError):
            drill.validate_workdir(self.root / "absent", must_exist=True)

    @unittest.skipUnless(symlink_supported(), "creating symlinks is not permitted on this host")
    def test_rejects_a_symlinked_archive(self):
        real = self.workdir / "real.dump"
        real.write_bytes(drill.PGDMP_MAGIC + b"\0" * (drill.MIN_ARCHIVE_BYTES + 8))
        link = self.workdir / "link.dump"
        os.symlink(real, link)
        with self.assertRaises(drill.DrillError):
            drill.resolve_archive_path("link.dump", workdir=self.workdir)

    @unittest.skipUnless(symlink_supported(), "creating symlinks is not permitted on this host")
    def test_rejects_a_symlinked_parent_directory(self):
        real_dir = self.root / "outside"
        real_dir.mkdir()
        link_dir = self.workdir / "linked"
        os.symlink(real_dir, link_dir)
        with self.assertRaises(drill.DrillError):
            drill.resolve_archive_path("linked/risk.dump", workdir=self.workdir)


class ArchiveFileTests(unittest.TestCase):
    """``pg_dump`` output is checked before it is ever offered to ``pg_restore``."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)

    def write(self, name: str, payload: bytes) -> Path:
        path = self.root / name
        path.write_bytes(payload)
        return path

    def test_accepts_a_custom_format_archive(self):
        path = self.write("ok.dump", drill.PGDMP_MAGIC + b"\0" * (drill.MIN_ARCHIVE_BYTES + 8))
        self.assertEqual(drill.validate_archive_file(path), len(path.read_bytes()))

    def test_rejects_a_missing_archive(self):
        with self.assertRaises(drill.DrillError):
            drill.validate_archive_file(self.root / "absent.dump")

    def test_rejects_a_zero_byte_archive(self):
        with self.assertRaises(drill.DrillError) as caught:
            drill.validate_archive_file(self.write("empty.dump", b""))
        self.assertIn("empty", str(caught.exception).lower())

    def test_rejects_an_archive_below_the_minimum_size(self):
        with self.assertRaises(drill.DrillError):
            drill.validate_archive_file(self.write("tiny.dump", drill.PGDMP_MAGIC + b"\0" * 8))

    def test_rejects_an_archive_that_is_not_custom_format(self):
        with self.assertRaises(drill.DrillError) as caught:
            drill.validate_archive_file(self.write("sql.dump", b"-- PostgreSQL database dump\n" + b"\0" * 4096))
        self.assertIn("custom-format", str(caught.exception).lower())

    def test_rejects_a_directory(self):
        directory = self.root / "dir.dump"
        directory.mkdir()
        with self.assertRaises(drill.DrillError):
            drill.validate_archive_file(directory)

    @unittest.skipUnless(symlink_supported(), "creating symlinks is not permitted on this host")
    def test_rejects_a_symlink_that_points_at_a_valid_archive(self):
        real = self.write("real.dump", drill.PGDMP_MAGIC + b"\0" * (drill.MIN_ARCHIVE_BYTES + 8))
        link = self.root / "link.dump"
        os.symlink(real, link)
        with self.assertRaises(drill.DrillError):
            drill.validate_archive_file(link)


class TocTests(unittest.TestCase):
    """A truncated archive is caught by its own table of contents."""

    TOC = textwrap.dedent(
        """
        ;
        ; Archive created at 2026-11-20 12:00:00 UTC
        ;     dbname: risk
        ;     TOC Entries: 8
        ;
        215; 1259 16389 TABLE public zones postgres
        216; 1259 16390 TABLE prevention actions postgres
        3495; 0 0 TABLE DATA public zones postgres
        3496; 0 0 TABLE DATA prevention actions postgres
        ; dummy comment
        """
    )

    def test_summarises_table_and_data_entries(self):
        summary = drill.summarise_toc(self.TOC)
        self.assertEqual(summary.entries, 4)
        self.assertEqual(summary.tables, frozenset({"public.zones", "prevention.actions"}))
        self.assertEqual(summary.data, frozenset({"public.zones", "prevention.actions"}))

    def test_reports_missing_data_entries(self):
        summary = drill.summarise_toc(self.TOC)
        missing = drill.missing_toc_objects(summary, ["public.zones", "public.batches"])
        self.assertEqual(missing, ["public.batches (no table data)"])

    def test_reports_missing_definitions(self):
        summary = drill.summarise_toc("3495; 0 0 TABLE DATA public zones postgres\n")
        missing = drill.missing_toc_objects(summary, ["public.zones"])
        self.assertEqual(missing, ["public.zones (no table definition)"])

    def test_a_comment_only_toc_is_refused(self):
        summary = drill.summarise_toc(";\n; Archive created at 2026-11-20\n; TOC Entries: 0\n")
        self.assertEqual(summary.entries, 0)
        with self.assertRaises(drill.DrillError):
            drill.evaluate_toc(summary, ["public.zones"], archive="risk.dump")

    def test_a_complete_toc_passes(self):
        drill.evaluate_toc(drill.summarise_toc(self.TOC), ["public.zones", "prevention.actions"], archive="risk.dump")

    def test_a_missing_entry_fails_closed_with_the_archive_name(self):
        with self.assertRaises(drill.DrillError) as caught:
            drill.evaluate_toc(drill.summarise_toc(self.TOC), ["public.batches"], archive="risk.dump")
        message = str(caught.exception)
        self.assertIn("risk.dump", message)
        self.assertIn("public.batches", message)

    def test_names_are_parsed_with_schema_qualification(self):
        summary = drill.summarise_toc("1; 1259 1 TABLE public zones postgres\n2; 0 0 TABLE DATA public zones postgres\n")
        self.assertEqual(drill.missing_toc_objects(summary, ["public.zones"]), [])


class MigrationDiscoveryTests(unittest.TestCase):
    """The drill applies the migrations the repository actually registers."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)

    def service(self, name: str, files: dict[str, str]):
        directory = self.root / name / "migrations"
        directory.mkdir(parents=True)
        versions = [(int(file_name.split("_", 1)[0]), file_name) for file_name in files]
        (directory / "embed.go").write_text(self.embed(versions), encoding="utf-8")
        for file_name, sql in files.items():
            (directory / file_name).write_text(sql, encoding="utf-8")
        return directory

    @staticmethod
    def embed(registered: list[tuple[int, str]]) -> str:
        lines = ["package migrations", "", 'import _ "embed"', ""]
        for version, file_name in registered:
            lines += [f"//go:embed {file_name}", f"var m{version} string", ""]
        lines += ["func All() []Migration {", "\treturn []Migration{"]
        for version, file_name in registered:
            name = file_name.split("_", 1)[1].rsplit(".", 1)[0]
            lines.append(f'\t\t{{Version: {version}, Name: "{name}", SQL: m{version}}},')
        lines += ["\t}", "}", ""]
        return "\n".join(lines)

    def test_discovers_embedded_migrations_in_ascending_order(self):
        directory = self.service("risk", {"001_a.sql": "SELECT 1;", "007_b.sql": "SELECT 2;"})
        migrations = drill.discover_migrations(directory)
        self.assertEqual([m.version for m in migrations], [1, 7])
        self.assertEqual([m.name for m in migrations], ["a", "b"])
        self.assertEqual([m.path.name for m in migrations], ["001_a.sql", "007_b.sql"])

    def test_refuses_a_file_named_version_that_differs_from_the_ledger(self):
        directory = self.service("risk", {"001_a.sql": "SELECT 1;"})
        drifted = textwrap.dedent(
            """
            package migrations

            import _ "embed"

            //go:embed 001_a.sql
            var m0 string

            func All() []Migration {
            \treturn []Migration{
            \t\t{Version: 0, Name: "a", SQL: m0},
            \t}
            }
            """
        )
        (directory / "embed.go").write_text(drifted, encoding="utf-8")
        with self.assertRaises(drill.DrillError) as caught:
            drill.discover_migrations(directory)
        self.assertIn("001_a.sql", str(caught.exception))

    def test_refuses_a_sql_file_that_is_not_embedded(self):
        directory = self.service("risk", {"001_a.sql": "SELECT 1;"})
        (directory / "002_orphan.sql").write_text("SELECT 2;", encoding="utf-8")
        with self.assertRaises(drill.DrillError) as caught:
            drill.discover_migrations(directory)
        self.assertIn("002_orphan.sql", str(caught.exception))

    def test_refuses_an_embedded_file_missing_from_disk(self):
        directory = self.service("risk", {"001_a.sql": "SELECT 1;"})
        (directory / "001_a.sql").unlink()
        with self.assertRaises(drill.DrillError):
            drill.discover_migrations(directory)

    def test_refuses_duplicate_versions(self):
        directory = self.service("risk", {"001_a.sql": "SELECT 1;", "001_b.sql": "SELECT 2;"})
        with self.assertRaises(drill.DrillError):
            drill.discover_migrations(directory)

    def test_refuses_a_directory_without_embed_go(self):
        directory = self.root / "empty" / "migrations"
        directory.mkdir(parents=True)
        with self.assertRaises(drill.DrillError):
            drill.discover_migrations(directory)


class MigrationPlanTests(unittest.TestCase):
    """risk and prevention share one ledger; jobs has its own."""

    def build(self, root: Path, services: dict[str, list[tuple[int, str]]]):
        for name, versions in services.items():
            directory = root / name / "migrations"
            directory.mkdir(parents=True)
            lines = ["package migrations", "", 'import _ "embed"', ""]
            for version, label in versions:
                lines += [f"//go:embed {version:03d}_{label}.sql", f"var m{version} string", ""]
            lines += ["func All() []Migration {", "\treturn []Migration{"]
            for version, label in versions:
                lines.append(f'\t\t{{Version: {version}, Name: "{label}", SQL: m{version}}},')
            lines += ["\t}", "}", ""]
            (directory / "embed.go").write_text("\n".join(lines), encoding="utf-8")
            for version, label in versions:
                (directory / f"{version:03d}_{label}.sql").write_text(f"SELECT {version};", encoding="utf-8")
        return root

    def test_merges_risk_and_prevention_into_the_shared_ledger(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.build(Path(tmp), {"risk": [(1, "a"), (3, "c")], "prevention": [(2, "b")], "jobs": [(1, "j")]})
            plan = drill.database_migration_plan(root)
        self.assertEqual([m.version for m in plan["risk"]], [1, 2, 3])
        self.assertEqual([m.version for m in plan["jobs"]], [1])

    def test_refuses_a_version_collision_between_risk_and_prevention(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.build(Path(tmp), {"risk": [(1, "a"), (2, "c")], "prevention": [(2, "b")], "jobs": [(1, "j")]})
            with self.assertRaises(drill.DrillError):
                drill.database_migration_plan(root)

    def test_refuses_a_missing_service(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.build(Path(tmp), {"risk": [(1, "a")], "prevention": [(2, "b")]})
            with self.assertRaises(drill.DrillError):
                drill.database_migration_plan(root)

    def test_the_repository_plan_matches_the_migration_ledger(self):
        services = Path(__file__).resolve().parent.parent / "services"
        plan = drill.database_migration_plan(services)
        self.assertEqual(sorted(m.version for m in plan["risk"]), list(range(1, 20)))
        self.assertEqual(sorted(m.version for m in plan["jobs"]), list(range(1, 8)))


class LedgerTests(unittest.TestCase):
    def test_accepts_a_contiguous_ledger(self):
        drill.check_ledger("risk", tuple(range(1, 20)), (1, 19))

    def test_rejects_a_ledger_with_a_gap(self):
        with self.assertRaises(drill.DrillError) as caught:
            drill.check_ledger("risk", tuple(range(1, 19)), (1, 20))
        self.assertIn("risk", str(caught.exception))

    def test_rejects_a_missing_version(self):
        versions = tuple(v for v in range(1, 20) if v != 9)
        with self.assertRaises(drill.DrillError):
            drill.check_ledger("risk", versions, (1, 19))

    def test_rejects_an_unexpected_version(self):
        with self.assertRaises(drill.DrillError):
            drill.check_ledger("risk", tuple(range(1, 21)), (1, 19))

    def test_rejects_a_duplicate(self):
        with self.assertRaises(drill.DrillError):
            drill.check_ledger("jobs", (1, 1, 2, 3), (1, 3))

    def test_rejects_an_empty_ledger(self):
        with self.assertRaises(drill.DrillError):
            drill.check_ledger("jobs", (), (1, 7))

    def test_the_declared_expectations_match_the_repository_ledger(self):
        self.assertEqual(drill.LEDGER_EXPECTATIONS["risk"], (1, 19))
        self.assertEqual(drill.LEDGER_EXPECTATIONS["jobs"], (1, 7))


class ContentComparisonTests(unittest.TestCase):
    """Row equality is the assertion that a restore actually restored."""

    def test_identical_censuses_are_equal(self):
        self.assertEqual(drill.compare_content(census(), census()), [])

    def test_a_corrupted_row_fails(self):
        restored = census(tables={"public.zones": drill.TableDigest(rows=2, digest="0" * 64)})
        mismatches = drill.compare_content(census(), restored)
        self.assertEqual(len(mismatches), 1)
        self.assertIn("public.zones", mismatches[0])

    def test_a_missing_row_fails(self):
        restored = census(tables={"public.zones": table(1, "zones")})
        mismatches = drill.compare_content(census(), restored)
        self.assertTrue(any("public.zones" in m and "1" in m for m in mismatches))

    def test_a_missing_table_fails(self):
        restored = census(tables={})
        mismatches = drill.compare_content(census(), restored)
        self.assertTrue(any("public.zones" in m for m in mismatches))

    def test_an_unexpected_table_fails(self):
        restored = census(tables={"public.zones": table(2, "zones"), "public.extra": table(0, "extra")})
        mismatches = drill.compare_content(census(), restored)
        self.assertTrue(any("public.extra" in m for m in mismatches))

    def test_a_geometry_digest_mismatch_fails(self):
        restored = census(geometry={"public.zones": drill.TableDigest(rows=2, digest="f" * 64)})
        mismatches = drill.compare_content(census(), restored)
        self.assertTrue(any("geometry" in m and "public.zones" in m for m in mismatches))

    def test_a_ledger_mismatch_fails(self):
        mismatches = drill.compare_content(census(), census(ledger=(1, 2)))
        self.assertTrue(any("ledger" in m for m in mismatches))

    def test_comparing_two_different_databases_is_refused(self):
        with self.assertRaises(drill.DrillError):
            drill.compare_content(census("risk"), census("jobs"))


class SchemaComparisonTests(unittest.TestCase):
    """The schema assertion is separate from the row assertion, as the spec asks."""

    def test_identical_schemas_are_equal(self):
        self.assertEqual(drill.compare_schema(census(), census()), [])

    def test_a_missing_relation_fails(self):
        mismatches = drill.compare_schema(census(), census(schema=()))
        self.assertTrue(any("public.zones" in m for m in mismatches))

    def test_an_extra_relation_fails(self):
        mismatches = drill.compare_schema(
            census(), census(schema=("relation|public.zones:BASE TABLE", "relation|public.extra:BASE TABLE"))
        )
        self.assertTrue(any("public.extra" in m for m in mismatches))


class MeasurementTests(unittest.TestCase):
    """RPO and RTO are contrasted with the acta's numbers, never rounded into them."""

    def test_accepts_a_measurement_inside_both_objectives(self):
        measurement = drill.Measurement(
            dump_seconds=1.5, backup_age_seconds=0.25, restore_seconds=2.0, verification_seconds=0.5
        )
        drill.evaluate_rpo(measurement, limit=drill.RPO_CEILING_SECONDS)
        drill.evaluate_rto(measurement, limit=drill.RTO_CEILING_SECONDS)

    def test_recovery_seconds_is_restore_plus_verification(self):
        measurement = drill.Measurement(
            dump_seconds=1.0, backup_age_seconds=2.0, restore_seconds=3.0, verification_seconds=4.0
        )
        self.assertEqual(measurement.recovery_seconds, 7.0)

    def test_rpo_accepts_exactly_the_limit(self):
        measurement = drill.Measurement(dump_seconds=900.0, backup_age_seconds=900.0, restore_seconds=1.0, verification_seconds=1.0)
        drill.evaluate_rpo(measurement, limit=900)

    def test_rpo_rejects_a_backup_older_than_the_limit(self):
        measurement = drill.Measurement(dump_seconds=1.0, backup_age_seconds=900.001, restore_seconds=1.0, verification_seconds=1.0)
        with self.assertRaises(drill.DrillError) as caught:
            drill.evaluate_rpo(measurement, limit=900)
        self.assertIn("900", str(caught.exception))

    def test_rpo_rejects_a_dump_longer_than_the_limit(self):
        measurement = drill.Measurement(dump_seconds=901.0, backup_age_seconds=1.0, restore_seconds=1.0, verification_seconds=1.0)
        with self.assertRaises(drill.DrillError):
            drill.evaluate_rpo(measurement, limit=900)

    def test_rto_accepts_exactly_the_limit(self):
        measurement = drill.Measurement(dump_seconds=1.0, backup_age_seconds=1.0, restore_seconds=3599.0, verification_seconds=1.0)
        drill.evaluate_rto(measurement, limit=3600)

    def test_rto_rejects_a_recovery_longer_than_the_limit(self):
        measurement = drill.Measurement(dump_seconds=1.0, backup_age_seconds=1.0, restore_seconds=3600.0, verification_seconds=1.0)
        with self.assertRaises(drill.DrillError) as caught:
            drill.evaluate_rto(measurement, limit=3600)
        self.assertIn("3601", str(caught.exception))

    def test_an_unmeasured_value_is_refused(self):
        for bad in (None, float("nan"), float("inf"), -1.0):
            with self.subTest(bad=bad), self.assertRaises(drill.DrillError):
                drill.evaluate_rto(
                    drill.Measurement(
                        dump_seconds=1.0,
                        backup_age_seconds=1.0,
                        restore_seconds=cast(float, bad),
                        verification_seconds=1.0,
                    ),
                    limit=3600,
                )


class PlanTests(unittest.TestCase):
    """Every structural guard runs before the first mutating command."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.workdir = self.root / "work"
        self.workdir.mkdir()

    def plan(self, argv):
        return drill.build_plan(drill.parse_args(argv))

    def test_a_valid_plan_derives_scratch_names_and_archives(self):
        plan = self.plan(["--workdir", str(self.workdir), "--run-id", RUN_ID])
        self.assertEqual(plan.run_id, RUN_ID)
        self.assertEqual(plan.container_name, "fw-v1f14-" + RUN_ID)
        self.assertEqual(plan.scratch_databases["risk"], SCRATCH)
        self.assertEqual(plan.archives["risk"], (self.workdir / "risk.dump").resolve(strict=False))
        self.assertFalse(plan.workdir_owned)

    def test_a_relative_workdir_is_canonicalized_and_archives_stay_inside_it(self):
        cwd = os.getcwd()
        self.addCleanup(os.chdir, cwd)
        (self.root / "rel-drill").mkdir()
        os.chdir(self.root)
        plan = self.plan(["--workdir", "rel-drill", "--run-id", RUN_ID])
        self.assertTrue(plan.workdir.is_absolute())
        self.assertEqual(plan.workdir, (self.root / "rel-drill").resolve())
        for archive in plan.archives.values():
            self.assertTrue(archive.is_absolute())
            self.assertEqual(archive.relative_to(plan.workdir).parent.as_posix(), ".")

    def test_a_relative_workdir_runs_end_to_end(self):
        cwd = os.getcwd()
        self.addCleanup(os.chdir, cwd)
        (self.root / "rel-drill-run").mkdir()
        os.chdir(self.root)
        fake = FakeDrill(drill.parse_args(["--workdir", "rel-drill-run", "--run-id", RUN_ID]))
        report = fake.run()
        self.assertEqual(report.workdir, (self.root / "rel-drill-run").resolve())
        self.assertEqual(sorted(path.name for path in (self.root / "rel-drill-run").iterdir()), [])

    def test_a_plan_with_an_invalid_scratch_name_is_refused(self):
        with self.assertRaises(drill.DrillError):
            self.plan(
                [
                    "--workdir",
                    str(self.workdir),
                    "--database",
                    "risk",
                    "--scratch-database",
                    "firewatch",
                ]
            )

    def test_a_plan_with_a_non_loopback_host_is_refused(self):
        with self.assertRaises(drill.DrillError):
            self.plan(["--workdir", str(self.workdir), "--host", "10.0.0.9"])

    def test_a_plan_whose_archive_escapes_the_workdir_is_refused(self):
        with self.assertRaises(drill.DrillError):
            self.plan(
                [
                    "--workdir",
                    str(self.workdir),
                    "--database",
                    "risk",
                    "--archive",
                    str(self.root / "escape.dump"),
                ]
            )

    def test_a_plan_with_mismatched_database_and_archive_counts_is_refused(self):
        with self.assertRaises(drill.DrillError):
            self.plan(
                [
                    "--workdir",
                    str(self.workdir),
                    "--database",
                    "risk",
                    "--archive",
                    "a.dump",
                    "--archive",
                    "b.dump",
                ]
            )

    def test_a_plan_with_duplicate_databases_is_refused(self):
        with self.assertRaises(drill.DrillError):
            self.plan(["--workdir", str(self.workdir), "--database", "risk", "--database", "risk"])

    def test_a_plan_with_no_database_is_refused(self):
        with self.assertRaises(drill.DrillError):
            self.plan(["--workdir", str(self.workdir), "--database", ""])

    def test_a_missing_workdir_is_refused_for_a_live_run(self):
        with self.assertRaises(drill.DrillError):
            self.plan(["--workdir", str(self.root / "absent")])

    def test_dry_run_still_runs_every_structural_guard(self):
        # No workdir exists, yet the plan is built: dry-run validates
        # structurally and never creates anything.
        plan = drill.build_plan(drill.parse_args(["--dry-run", "--run-id", RUN_ID]))
        self.assertTrue(plan.dry_run)
        self.assertEqual(plan.scratch_databases["risk"], SCRATCH)
        self.assertFalse(plan.workdir.exists())
        with self.assertRaises(drill.DrillError):
            drill.build_plan(drill.parse_args(["--dry-run", "--host", "0.0.0.0"]))  # noqa: S104 - asserting the refusal
        with self.assertRaises(drill.DrillError):
            drill.build_plan(
                drill.parse_args(["--dry-run", "--database", "risk", "--scratch-database", "postgres"])
            )
        with self.assertRaises(drill.DrillError):
            drill.build_plan(drill.parse_args(["--dry-run", "--database", "risk", "--archive", "../x.dump"]))
        with self.assertRaises(drill.DrillError):
            drill.build_plan(drill.parse_args(["--dry-run", "--container-name", "postgres"]))


class FakeDrill(drill.Drill):
    """A ``Drill`` whose Docker, exec and psql seams are an in-memory model.

    The model follows the drill's contract rather than the tests' wishes: the
    source censuses and the restored censuses are the same dict unless a test
    widens one, ``pg_dump`` writes a real custom-format archive into the planned
    path, and ``pg_restore --list`` answers with a TOC derived from the source
    census. Every command is recorded so a test can assert the order.
    """

    def __init__(self, args, *, restored=None, archive_bytes=None, published_port="127.0.0.1:55432",
                 toc=None, existing=(), clock_steps=None):
        super().__init__(args)
        self.calls: list[tuple[str, list[str]]] = []
        self.psql_scripts: list[tuple[str, str]] = []
        self.clock_value = 1000.0
        self._clock = self.now
        self._sleep = lambda seconds: None
        self.restored = restored or {}
        self.archive_bytes = archive_bytes
        self.published_port = published_port
        self.toc = toc
        self.existing = set(existing)
        self.clock_steps = dict(clock_steps or {})
        self.observed_workdir_exists: bool | None = None

    def now(self) -> float:
        return self.clock_value

    def advance(self, seconds: float) -> None:
        self.clock_value += seconds

    def source_census(self, database: str) -> drill.DatabaseCensus:
        """The census the real migrated databases would report, modelled per database."""
        source = {
            "risk": census(
                "risk",
                ledger=tuple(range(1, 20)),
                tables={"public.zones": table(2, "zones"), "public.batches": table(1, "batches")},
                geometry={
                    "public.zones": table(2, "zones-geometry"),
                    "public.batches": table(1, "batches-geometry"),
                },
                schema=("relation|public.batches:BASE TABLE", "relation|public.zones:BASE TABLE"),
            ),
            "jobs": census(
                "jobs",
                ledger=tuple(range(1, 8)),
                tables={"public.jobs": table(2, "jobs"), "public.audit": table(2, "audit")},
                schema=("relation|public.audit:BASE TABLE", "relation|public.jobs:BASE TABLE"),
            ),
        }
        return source[database]

    # -- seams -------------------------------------------------------------
    def _docker(self, argv, *, timeout=None, stdin=None, env=None) -> tuple[int, str]:
        self.calls.append(("docker", list(argv)))
        verb = argv[0]
        if verb == "run":
            return 0, "a" * 64 + "\n"
        if verb == "port":
            return 0, self.published_port + "\n"
        return 0, ""

    def _exec_to_fd(self, container, argv, *, descriptor, timeout=None) -> tuple[int, bytes]:
        self.calls.append(("exec_to_fd", list(argv)))
        if argv[0] != "pg_dump":
            return 0, b""
        self.observed_workdir_exists = self.plan.workdir.is_dir()
        payload = self.archive_bytes
        if payload is None:
            payload = drill.PGDMP_MAGIC + b"\0" * (drill.MIN_ARCHIVE_BYTES + 32)
        os.write(descriptor, payload)
        self.advance(1.25)
        return 0, b""

    def _exec(self, container, argv, *, timeout=None, stdin=None) -> tuple[int, str]:
        self.calls.append(("exec", list(argv)))
        if argv[0] == "pg_isready":
            return 0, "accepting connections\n"
        if argv[0] == "pg_restore" and "--list" in argv:
            return 0, self.toc if self.toc is not None else self.toc_for(list(self.args.database))
        if argv[0] == "pg_restore":
            self.advance(2.5)
            return 0, ""
        return 0, ""

    def toc_for(self, databases) -> str:
        lines = [";", "; Archive created at 2026-11-20 12:00:00 UTC", ";"]
        for database in databases:
            for rel in self.source_census(database).tables:
                schema, name = rel.split(".")
                lines.append(f"215; 1259 1 TABLE {schema} {name} postgres")
                lines.append(f"3495; 0 0 TABLE DATA {schema} {name} postgres")
        return "\n".join(lines) + "\n"

    def _psql(self, container, database, sql, *, single_transaction=False, cleanup=False) -> str:
        self.psql_scripts.append((database, sql))
        marker = sql.splitlines()[0].strip()
        if marker == "-- drill:exists":
            target = sql.rsplit("'", 2)[1]
            return "1\n" if target in self.existing else "0\n"
        if marker in ("-- drill:create", "-- drill:drop", "-- drill:roles", "-- drill:databases",
                      "-- drill:migrate", "-- drill:seed"):
            return ""
        model = self.census_for(database)
        if marker == "-- drill:tables":
            return "".join(rel.replace(".", "|") + "\n" for rel in model.tables)
        if marker == "-- drill:ledger":
            return "".join(f"{version}\n" for version in model.ledger)
        if marker == "-- drill:digest":
            return "".join(f"{rel}|{fp.rows}|{fp.digest * fp.rows}\n" for rel, fp in model.tables.items())
        if marker == "-- drill:geometry":
            return "".join(f"{rel}|{fp.rows}|{fp.digest * fp.rows}\n" for rel, fp in model.geometry.items())
        if marker == "-- drill:schema":
            return "".join(line + "\n" for line in model.schema)
        raise AssertionError("unexpected psql script: " + marker)


    def census_for(self, database: str) -> drill.DatabaseCensus:
        """Return the modelled census, by source name or by scratch name."""
        if database in self.restored:
            return self.restored[database]
        for source, scratch in self.plan.scratch_databases.items():
            if scratch == database:
                return self.source_census(source)
        return self.source_census(database)


class SlowDumpDrill(FakeDrill):
    """A drill whose dump outlives the RPO window."""

    def _exec_to_fd(self, container, argv, *, descriptor, timeout=None) -> tuple[int, bytes]:
        result = super()._exec_to_fd(container, argv, descriptor=descriptor, timeout=timeout)
        if argv[0] == "pg_dump":
            self.clock_value += 1200
        return result


class SlowRestoreDrill(FakeDrill):
    """A drill whose restore outlives the RTO window."""

    def _exec(self, container, argv, *, timeout=None, stdin=None) -> tuple[int, str]:
        result = super()._exec(container, argv, timeout=timeout, stdin=stdin)
        if argv[0] == "pg_restore" and "--list" not in argv:
            self.clock_value += 4000
        return result


class FailingDumpDrill(FakeDrill):
    """A drill whose ``pg_dump`` fails before writing anything."""

    def _exec_to_fd(self, container, argv, *, descriptor, timeout=None) -> tuple[int, bytes]:
        if argv[0] == "pg_dump":
            self.calls.append(("exec_to_fd", list(argv)))
            return 1, b"pg_dump: simulated failure"
        return super()._exec_to_fd(container, argv, descriptor=descriptor, timeout=timeout)


class SecondCreateDrill(FakeDrill):
    """A drill whose second scratch database cannot be created."""

    def __init__(self, args):
        super().__init__(args)
        self.creates = 0

    def _psql(self, container, database, sql, *, single_transaction=False, cleanup=False) -> str:
        if sql.splitlines()[0].strip() == "-- drill:create":
            self.creates += 1
            if self.creates == 2:
                raise drill.DrillError("simulated restore failure")
        return super()._psql(
            container, database, sql, single_transaction=single_transaction, cleanup=cleanup
        )


class DrillRunTests(unittest.TestCase):
    """The drill's own order of operations, observed as a command log."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.workdir = Path(self._tmp.name) / "work"
        self.workdir.mkdir()

    def args(self, *extra):
        return drill.parse_args(["--workdir", str(self.workdir), "--run-id", RUN_ID, *extra])

    def verbs(self, fake, kind):
        return [argv for entry, argv in fake.calls if entry == kind]

    def test_a_clean_run_reports_measured_values_and_tears_down(self):
        fake = FakeDrill(self.args())
        report = fake.run()
        self.assertEqual(report.container, "fw-v1f14-" + RUN_ID)
        self.assertEqual([record.database for record in report.records], ["risk", "jobs"])
        self.assertGreater(report.measurement.dump_seconds, 0)
        self.assertGreater(report.measurement.restore_seconds, 0)
        docker_verbs = [argv[0] for argv in self.verbs(fake, "docker")]
        self.assertEqual(docker_verbs[0], "run")
        self.assertIn("rm", docker_verbs)
        self.assertEqual(docker_verbs.count("run"), 1)

    def test_the_order_is_guards_dump_toc_create_restore_compare(self):
        fake = FakeDrill(self.args())
        fake.run()
        # The dump is a byte stream and the rest are text calls, so the order is
        # read from the one command log that preserves it across both seams.
        log = [(entry, argv) for entry, argv in fake.calls if entry in ("exec", "exec_to_fd")]
        verbs = [argv[0] for _, argv in log]
        self.assertLess(verbs.index("pg_dump"), verbs.index("pg_restore"))
        listing = [index for index, (_, argv) in enumerate(log) if argv[0] == "pg_restore" and "--list" in argv]
        restoring = [
            index for index, (_, argv) in enumerate(log) if argv[0] == "pg_restore" and "--list" not in argv
        ]
        self.assertEqual(len(listing), 2)
        self.assertEqual(len(restoring), 2)
        self.assertLess(max(listing), min(restoring))
        dump_argv = next(argv for _, argv in log if argv[0] == "pg_dump")
        self.assertNotIn("-f", dump_argv, "pg_dump must stream to the host, never write into the bind mount")
        markers = [sql.splitlines()[0].strip() for _, sql in fake.psql_scripts]
        self.assertLess(markers.index("-- drill:create"), markers.index("-- drill:drop"))
        self.assertIn("-- drill:migrate", markers)
        self.assertIn("-- drill:seed", markers)

    def test_migrations_run_in_a_single_transaction(self):
        fake = FakeDrill(self.args())
        fake.run()
        migration_scripts = [
            sql for _, sql in fake.psql_scripts if sql.splitlines()[0].strip() == "-- drill:migrate"
        ]
        self.assertEqual(len(migration_scripts), 2)
        for sql in migration_scripts:
            # A bare ``BEGIN`` line is the transaction the Go runner opens; the
            # PL/pgSQL ``BEGIN`` blocks inside the migrations are not statements.
            self.assertEqual(len(re.findall(r"(?m)^BEGIN;$", sql)), 1)
            self.assertEqual(len(re.findall(r"(?m)^COMMIT;$", sql)), 1)
            self.assertIn("INSERT INTO schema_migrations", sql)

    def test_a_corrupted_row_after_restore_fails_and_still_tears_down(self):
        restored = {
            "firewatch_restore_drill_abcd1234_risk": census(
                "risk",
                ledger=tuple(range(1, 20)),
                tables={
                    "public.zones": drill.TableDigest(rows=2, digest="9" * 64),
                    "public.batches": table(1, "batches"),
                },
                geometry={
                    "public.zones": table(2, "zones-geometry"),
                    "public.batches": table(1, "batches-geometry"),
                },
                schema=("relation|public.batches:BASE TABLE", "relation|public.zones:BASE TABLE"),
            )
        }
        fake = FakeDrill(self.args(), restored=restored)
        with self.assertRaises(drill.DrillError) as caught:
            fake.run()
        self.assertIn("public.zones", str(caught.exception))
        docker_verbs = [argv[0] for argv in self.verbs(fake, "docker")]
        self.assertIn("rm", docker_verbs)
        self.assertTrue(any(sql.splitlines()[0].strip() == "-- drill:drop" for _, sql in fake.psql_scripts))

    def test_an_empty_archive_fails_before_any_scratch_database_is_created(self):
        fake = FakeDrill(self.args(), archive_bytes=b"")
        with self.assertRaises(drill.DrillError) as caught:
            fake.run()
        self.assertIn("empty", str(caught.exception).lower())
        markers = [sql.splitlines()[0].strip() for _, sql in fake.psql_scripts]
        self.assertNotIn("-- drill:create", markers)
        self.assertIn("rm", [argv[0] for argv in self.verbs(fake, "docker")])

    def test_a_truncated_toc_fails_before_any_scratch_database_is_created(self):
        fake = FakeDrill(self.args(), toc=";\n; TOC Entries: 0\n")
        with self.assertRaises(drill.DrillError):
            fake.run()
        markers = [sql.splitlines()[0].strip() for _, sql in fake.psql_scripts]
        self.assertNotIn("-- drill:create", markers)

    def test_a_scratch_database_that_already_exists_is_refused(self):
        fake = FakeDrill(self.args(), existing={SCRATCH})
        with self.assertRaises(drill.DrillError) as caught:
            fake.run()
        self.assertIn(SCRATCH, str(caught.exception))
        restore_calls = [argv for argv in self.verbs(fake, "exec") if argv[0] == "pg_restore" and "--list" not in argv]
        self.assertEqual(restore_calls, [])

    def test_a_non_loopback_published_port_is_refused(self):
        fake = FakeDrill(self.args(), published_port="0.0.0.0:55432")  # noqa: S104 - the guard must refuse it
        with self.assertRaises(drill.DrillError):
            fake.run()
        self.assertIn("rm", [argv[0] for argv in self.verbs(fake, "docker")])
        self.assertFalse(any(sql.splitlines()[0].strip() == "-- drill:create" for _, sql in fake.psql_scripts))

    def test_an_rpo_breach_is_reported_with_its_measured_value(self):
        fake = SlowDumpDrill(self.args())
        with self.assertRaises(drill.DrillError) as caught:
            fake.run()
        self.assertIn("RPO", str(caught.exception))

    def test_an_rto_breach_is_reported_with_its_measured_value(self):
        fake = SlowRestoreDrill(self.args())
        with self.assertRaises(drill.DrillError) as caught:
            fake.run()
        self.assertIn("RTO", str(caught.exception))

    def test_a_run_that_never_created_a_scratch_database_does_not_drop_one(self):
        fake = FakeDrill(self.args(), toc=";\n; TOC Entries: 0\n")
        with self.assertRaises(drill.DrillError):
            fake.run()
        drops = [sql for _, sql in fake.psql_scripts if sql.splitlines()[0].strip() == "-- drill:drop"]
        self.assertEqual(drops, [])

    def test_a_verification_failure_still_drops_the_scratch_databases_it_created(self):
        fake = SecondCreateDrill(self.args())
        with self.assertRaises(drill.DrillError):
            fake.run()
        drops = [sql for _, sql in fake.psql_scripts if sql.splitlines()[0].strip() == "-- drill:drop"]
        self.assertEqual(len(drops), 1)


class CliTests(unittest.TestCase):
    """``--dry-run`` validates; it never becomes a way to skip a guard."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.workdir = Path(self._tmp.name) / "work"

    def test_dry_run_succeeds_without_touching_docker(self):
        code = drill.main(["--dry-run", "--workdir", str(self.workdir), "--run-id", RUN_ID])
        self.assertEqual(code, 0)
        self.assertFalse(self.workdir.exists())

    def test_dry_run_fails_on_an_invalid_scratch_database(self):
        code = drill.main(
            [
                "--dry-run",
                "--run-id",
                RUN_ID,
                "--database",
                "risk",
                "--scratch-database",
                "firewatch",
            ]
        )
        self.assertEqual(code, 1)

    def test_dry_run_fails_on_a_non_loopback_host(self):
        self.assertEqual(drill.main(["--dry-run", "--host", "0.0.0.0"]), 1)  # noqa: S104 - asserting the refusal

    def test_dry_run_fails_on_an_escaping_archive(self):
        self.assertEqual(drill.main(["--dry-run", "--database", "risk", "--archive", "../escape.dump"]), 1)

    def test_an_invalid_rpo_override_is_refused(self):
        with self.assertRaises(SystemExit):
            drill.parse_args(["--max-rpo-seconds", "0"])

    def test_the_defaults_are_the_acta_objectives(self):
        args = drill.parse_args([])
        self.assertEqual(args.max_rpo_seconds, 900)
        self.assertEqual(args.max_rto_seconds, 3600)
        self.assertEqual(args.host, "127.0.0.1")
        self.assertEqual(list(args.database), ["risk", "jobs"])
        self.assertEqual(args.image, "postgis/postgis:17-3.5")


class DefaultWorkdirTests(unittest.TestCase):
    """An omitted ``--workdir`` must work out of the box, and stay run-owned."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.temp_root = Path(self._tmp.name) / "tmp-root"
        self.temp_root.mkdir()
        self.workdir = Path(self._tmp.name) / "work"
        self.workdir.mkdir()
        self.derived = self.temp_root / ("fw-v1f14-" + RUN_ID)

    def patched(self) -> mock._patch:
        return mock.patch.object(drill.tempfile, "gettempdir", lambda: str(self.temp_root))

    def args(self, *extra):
        return drill.parse_args(["--run-id", RUN_ID, *extra])

    def test_an_omitted_workdir_derives_a_run_owned_directory_without_creating_it(self):
        with self.patched():
            plan = drill.build_plan(self.args())
        self.assertEqual(plan.workdir, self.derived)
        self.assertTrue(plan.workdir_owned)
        self.assertFalse(self.derived.exists())

    def test_an_explicit_workdir_is_not_run_owned(self):
        plan = drill.build_plan(self.args("--workdir", str(self.workdir)))
        self.assertFalse(plan.workdir_owned)

    def test_a_dangling_symlink_at_the_derived_path_is_refused_before_any_resolution(self):
        # A dangling symlink resolves to its (still absent) target, so resolving
        # first and inspecting the result hides the link and lets mkdir create the
        # target outside the temporary directory. The leaf must be inspected first.
        outside = self.temp_root / "outside-target"

        def is_symlink(path):
            return Path(path) == self.derived

        real_resolve = Path.resolve

        def resolve(path, strict=False):
            return outside if Path(path) == self.derived else real_resolve(path, strict=strict)

        patches = (
            self.patched(),
            mock.patch.object(Path, "is_symlink", is_symlink),
            mock.patch.object(Path, "resolve", resolve),
        )
        with patches[0], patches[1], patches[2], self.assertRaises(drill.DrillError) as caught:
            drill.build_plan(self.args())
        self.assertIn(self.derived.name, str(caught.exception))
        self.assertFalse(outside.exists())

    def test_a_dangling_symlink_appearing_after_preflight_is_refused_and_never_created(self):
        outside = self.temp_root / "outside-target"
        with self.patched():
            fake = FakeDrill(self.args())

        def is_symlink(path):
            return Path(path) == self.derived

        real_resolve = Path.resolve

        def resolve(path, strict=False):
            return outside if Path(path) == self.derived else real_resolve(path, strict=strict)

        patches = (
            self.patched(),
            mock.patch.object(Path, "is_symlink", is_symlink),
            mock.patch.object(Path, "resolve", resolve),
        )
        with patches[0], patches[1], patches[2], self.assertRaises(drill.DrillError):
            fake.run()
        self.assertFalse(fake.workdir_created)
        self.assertEqual(fake.created_archives, set())
        self.assertFalse(outside.exists())

    def test_the_directory_creation_is_atomic_against_a_path_that_appears_after_the_checks(self):
        # The guard checks pass and the entry appears in the window between them
        # and the creation: only an atomic mkdir can turn that into a refusal, and
        # nothing may be recorded as created, so teardown cannot remove it.
        with self.patched():
            fake = FakeDrill(self.args())
        self.derived.mkdir()
        patches = (
            mock.patch.object(Path, "exists", lambda path: False),
            mock.patch.object(Path, "is_symlink", lambda path: False),
        )
        with patches[0], patches[1], self.assertRaises(drill.DrillError) as caught:
            fake.run()
        self.assertIn("appeared", str(caught.exception))
        self.assertFalse(fake.workdir_created)
        self.assertTrue(self.derived.is_dir())

    @unittest.skipUnless(symlink_supported(), "creating symlinks is not permitted on this host")
    def test_a_real_dangling_symlink_at_the_derived_path_is_refused(self):
        outside = self.temp_root / "outside-target"
        os.symlink(outside, self.derived)
        with self.patched(), self.assertRaises(drill.DrillError):
            drill.build_plan(self.args())
        self.assertFalse(outside.exists())

    def test_a_derived_directory_that_already_exists_is_refused(self):
        self.derived.mkdir()
        with self.patched(), self.assertRaises(drill.DrillError):
            drill.build_plan(self.args())

    def test_a_missing_temp_base_is_refused(self):
        with mock.patch.object(drill.tempfile, "gettempdir", lambda: str(self.temp_root / "absent")):
            self.assertRaises(drill.DrillError, drill.build_plan, self.args())

    def test_a_symlinked_temp_base_is_refused(self):
        def is_symlink(path):
            return Path(path) == self.temp_root

        with self.patched(), mock.patch.object(Path, "is_symlink", is_symlink), self.assertRaises(drill.DrillError):
            drill.build_plan(self.args())

    def test_a_dry_run_neither_creates_nor_needs_the_derived_directory(self):
        with self.patched():
            code = drill.main(["--dry-run", "--run-id", RUN_ID])
        self.assertEqual(code, 0)
        self.assertFalse(self.derived.exists())

    def test_a_live_run_creates_then_removes_its_own_directory(self):
        with self.patched():
            fake = FakeDrill(self.args())
            report = fake.run()
        self.assertEqual(report.workdir, self.derived)
        self.assertTrue(fake.observed_workdir_exists)
        self.assertFalse(self.derived.exists())

    def test_a_failed_run_still_removes_its_own_directory(self):
        with self.patched():
            fake = FakeDrill(self.args(), toc=";\n; TOC Entries: 0\n")
            with self.assertRaises(drill.DrillError):
                fake.run()
        self.assertFalse(self.derived.exists())

    def test_an_explicit_workdir_keeps_the_directory_and_loses_only_the_archives(self):
        fake = FakeDrill(self.args("--workdir", str(self.workdir)))
        fake.run()
        self.assertTrue(self.workdir.is_dir())
        self.assertEqual(sorted(path.name for path in self.workdir.iterdir()), [])

    def test_keep_preserves_the_directory_and_the_archives(self):
        fake = FakeDrill(self.args("--workdir", str(self.workdir), "--keep"))
        fake.run()
        self.assertTrue((self.workdir / "risk.dump").is_file())
        self.assertTrue((self.workdir / "jobs.dump").is_file())


class SymlinkWalkTests(unittest.TestCase):
    """Symlinks are refused on the *unresolved* path, so a resolved walk cannot hide one."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.workdir = self.root / "work"
        self.workdir.mkdir()

    def test_refuses_a_workdir_that_is_itself_a_symbolic_link(self):
        link = mock.patch.object(Path, "is_symlink", lambda path: Path(path) == self.workdir)
        with link, self.assertRaises(drill.DrillError) as caught:
            drill.resolve_archive_path("risk.dump", workdir=self.workdir)
        self.assertIn("symbolic link", str(caught.exception))

    def test_refuses_a_symbolic_link_above_the_workdir(self):
        parent_link = mock.patch.object(Path, "is_symlink", lambda path: Path(path) == self.root)
        with parent_link, self.assertRaises(drill.DrillError):
            drill.resolve_archive_path("risk.dump", workdir=self.workdir)

    def test_refuses_a_symbolic_link_between_the_workdir_and_the_archive(self):
        nested = self.workdir / "linked"
        nested_link = mock.patch.object(Path, "is_symlink", lambda path: Path(path) == nested)
        with nested_link, self.assertRaises(drill.DrillError):
            drill.resolve_archive_path("linked/risk.dump", workdir=self.workdir)

    def test_refuses_an_archive_that_is_itself_a_symbolic_link(self):
        target = self.workdir / "link.dump"
        file_link = mock.patch.object(Path, "is_symlink", lambda path: Path(path) == target)
        with file_link, self.assertRaises(drill.DrillError):
            drill.resolve_archive_path("link.dump", workdir=self.workdir)

    def test_accepts_a_symlink_free_path(self):
        def no_symlinks(path):
            return False

        with mock.patch.object(Path, "is_symlink", no_symlinks):
            resolved = drill.resolve_archive_path("nested/risk.dump", workdir=self.workdir)
        self.assertEqual(resolved, (self.workdir / "nested" / "risk.dump").resolve(strict=False))

    def test_the_workdir_guard_refuses_a_symbolic_link_too(self):
        def is_symlink(path):
            return Path(path) == self.workdir

        with mock.patch.object(Path, "is_symlink", is_symlink), self.assertRaises(drill.DrillError):
            drill.validate_workdir(self.workdir, must_exist=True)


class CeilingTests(unittest.TestCase):
    """The acta's RPO/RTO are ceilings: a flag may tighten them, never weaken them."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.workdir = Path(self._tmp.name) / "work"
        self.workdir.mkdir()

    def test_the_defaults_are_the_acta_ceilings(self):
        args = drill.parse_args([])
        self.assertEqual(args.max_rpo_seconds, 900)
        self.assertEqual(args.max_rto_seconds, 3600)
        self.assertEqual(drill.RPO_CEILING_SECONDS, 900)
        self.assertEqual(drill.RTO_CEILING_SECONDS, 3600)

    def test_an_rpo_threshold_above_the_ceiling_is_refused(self):
        with self.assertRaises(SystemExit):
            drill.parse_args(["--max-rpo-seconds", "901"])

    def test_an_rto_threshold_above_the_ceiling_is_refused(self):
        with self.assertRaises(SystemExit):
            drill.parse_args(["--max-rto-seconds", "3601"])

    def test_a_non_positive_threshold_is_refused(self):
        for flag in ("--max-rpo-seconds", "--max-rto-seconds"):
            with self.subTest(flag=flag), self.assertRaises(SystemExit):
                drill.parse_args([flag, "0"])

    def test_a_tighter_threshold_is_accepted_and_carried_into_the_plan(self):
        plan = drill.build_plan(
            drill.parse_args(
                [
                    "--workdir",
                    str(self.workdir),
                    "--max-rpo-seconds",
                    "60",
                    "--max-rto-seconds",
                    "120",
                ]
            )
        )
        self.assertEqual(plan.max_rpo_seconds, 60)
        self.assertEqual(plan.max_rto_seconds, 120)

    def test_build_plan_refuses_an_rpo_above_the_ceiling_even_when_parsing_was_bypassed(self):
        args = drill.parse_args(["--workdir", str(self.workdir)])
        args.max_rpo_seconds = 901
        with self.assertRaises(drill.DrillError) as caught:
            drill.build_plan(args)
        self.assertIn("900", str(caught.exception))

    def test_build_plan_refuses_an_rto_above_the_ceiling_even_when_parsing_was_bypassed(self):
        args = drill.parse_args(["--workdir", str(self.workdir)])
        args.max_rto_seconds = 3601
        with self.assertRaises(drill.DrillError) as caught:
            drill.build_plan(args)
        self.assertIn("3600", str(caught.exception))


class ArchiveOwnershipTests(unittest.TestCase):
    """The drill removes only files it wrote: never a pre-existing archive at a planned path."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.workdir = Path(self._tmp.name) / "work"
        self.workdir.mkdir()

    def args(self, *extra):
        return drill.parse_args(["--workdir", str(self.workdir), "--run-id", RUN_ID, *extra])

    def test_a_planned_archive_that_already_exists_is_refused_at_preflight(self):
        existing = self.workdir / "risk.dump"
        existing.write_text("pre-existing", encoding="utf-8")
        with self.assertRaises(drill.DrillError) as caught:
            drill.build_plan(self.args("--database", "risk"))
        self.assertIn("already exists", str(caught.exception))
        self.assertEqual(existing.read_text(encoding="utf-8"), "pre-existing")

    def test_a_dry_run_refuses_a_planned_archive_that_already_exists(self):
        existing = self.workdir / "risk.dump"
        existing.write_text("pre-existing", encoding="utf-8")
        with self.assertRaises(drill.DrillError):
            drill.build_plan(
                drill.parse_args(["--dry-run", "--workdir", str(self.workdir), "--database", "risk"])
            )

    def test_a_failed_dump_never_unlinks_a_file_it_did_not_write(self):
        # Preflight passes first, because the path is free; the file then appears
        # before teardown, which is the real race: a file at a planned archive
        # path that this run did not write must survive its own cleanup.
        fake = FailingDumpDrill(self.args())
        sentinel = self.workdir / "risk.dump"
        sentinel.write_text("pre-existing", encoding="utf-8")
        with self.assertRaises(drill.DrillError):
            fake.run()
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "pre-existing")
        self.assertEqual(fake.created_archives, set())

    def test_a_file_appearing_after_preflight_is_neither_overwritten_nor_removed(self):
        # Preflight passes because the path is free; the caller's file then appears
        # before the dump. O_CREAT|O_EXCL is what makes that a refusal instead of a
        # silent overwrite followed by a teardown that deletes the caller's bytes.
        fake = FakeDrill(self.args("--database", "risk"))
        sentinel = self.workdir / "risk.dump"
        sentinel.write_bytes(b"caller bytes")
        with self.assertRaises(drill.DrillError) as caught:
            fake.run()
        self.assertIn("risk.dump", str(caught.exception))
        self.assertEqual(sentinel.read_bytes(), b"caller bytes")
        self.assertEqual(fake.created_archives, set())
        self.assertTrue(sentinel.is_file())

    def test_a_failed_dump_still_removes_the_archive_it_claimed(self):
        fake = FailingDumpDrill(self.args("--database", "risk"))
        with self.assertRaises(drill.DrillError):
            fake.run()
        self.assertEqual(len(fake.created_archives), 1)
        self.assertEqual(sorted(path.name for path in self.workdir.iterdir()), [])

    def test_a_successful_run_records_and_removes_only_its_own_archives(self):
        unrelated = self.workdir / "keep-me.txt"
        unrelated.write_text("operator data", encoding="utf-8")
        fake = FakeDrill(self.args())
        fake.run()
        self.assertEqual(sorted(path.name for path in self.workdir.iterdir()), ["keep-me.txt"])
        self.assertEqual(len(fake.created_archives), 2)

    def test_teardown_removes_the_container_volumes(self):
        fake = FakeDrill(self.args())
        fake.run()
        removals = [argv for entry, argv in fake.calls if entry == "docker" and argv[0] == "rm"]
        self.assertEqual(len(removals), 1)
        self.assertIn("--volumes", removals[0])


if __name__ == "__main__":
    unittest.main()
