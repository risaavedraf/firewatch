"""Contract tests for the synthetic model-data handoff (T8).

This directory ships data, and data is the artifact. So every test here either
regenerates the bytes instead of trusting the committed file, or pins a property
that a hand-written fixture gets wrong silently: a header that drifts from the
code it mirrors, a value outside the artifact's own bounds, a missing cell
mistaken for a zero, or a gap that leaks the label.

Nothing here reaches the network, a provider, an application path or a
credential. The one thing the tests read from outside the directory is the
artifact descriptor they must mirror, read-only.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import subprocess
import sys
import unittest
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import generate  # noqa: E402


def _repo_root() -> Path:
    """The checkout this fixture lives in, found by the artifact it mirrors."""
    marker = Path("backend/services/inference/testdata/logistic.json")
    for candidate in (HERE, *HERE.parents):
        if (candidate / marker).is_file():
            return candidate
    raise RuntimeError(f"cannot locate the repository root above {HERE}")


REPO_ROOT = _repo_root()
ARTIFACT = REPO_ROOT / "backend/services/inference/testdata/logistic.json"
PANEL = HERE / "panel-synthetic.csv"
SECTORS = HERE / "sector-fixture.json"
MANIFEST = HERE / "manifest.json"
GENERATOR = HERE / "generate.py"

WEATHER_FIELDS = (
    "temp_max",
    "temp_min",
    "humidity_rel",
    "wind_speed",
    "wind_dir",
    "precip_sum",
    "radiation_sol",
)

TERRAIN_FIELDS = ("elevation_m", "slope_deg", "land_cover")

TARGET_COLUMNS = ("fire_today", "fire_count", "burned_ha")

#: Plausibility bounds, deliberately tighter than the artifact's own min/max.
#: The artifact bound says "inside what the model accepts"; these say "inside
#: what late November looks like in this region", so a swapped column or a
#: celsius/fahrenheit slip fails here even though it fits the artifact.
PLAUSIBLE = {
    "temp_max": (15.0, 40.0),
    "temp_min": (2.0, 20.0),
    "humidity_rel": (20.0, 98.0),
    "wind_speed": (0.0, 15.0),
    "wind_dir": (0.0, 360.0),
    "precip_sum": (0.0, 60.0),
    "radiation_sol": (80.0, 500.0),
}


def artifact() -> dict:
    return json.loads(ARTIFACT.read_text(encoding="utf-8"))


def panel_rows() -> list[dict[str, str]]:
    return list(csv.DictReader(io.StringIO(generate.panel_csv())))


def missing_cells(rows: list[dict[str, str]]) -> dict[tuple[str, str, str], dict[str, str]]:
    """Every empty feature cell, keyed by (cut, local_date, feature)."""

    cells: dict[tuple[str, str, str], dict[str, str]] = {}
    for row in rows:
        for feature in WEATHER_FIELDS:
            if row[feature] == "":
                cells[(row["cut"], row["local_date"], feature)] = row
    return cells


class GeneratedBytesTest(unittest.TestCase):
    """The committed files are exactly what the generator emits, byte for byte."""

    def assert_matches(self, path: Path, emitted: str) -> None:
        self.assertTrue(path.is_file(), f"missing {path.name}: run the generator")
        self.assertEqual(path.read_bytes(), emitted.encode("utf-8"))

    def test_panel_is_byte_identical_to_the_generator(self) -> None:
        self.assert_matches(PANEL, generate.panel_csv())

    def test_sector_fixture_is_byte_identical_to_the_generator(self) -> None:
        self.assert_matches(SECTORS, generate.sector_fixture_json())

    def test_manifest_is_byte_identical_to_the_generator(self) -> None:
        self.assert_matches(MANIFEST, generate.manifest_json())

    def test_check_mode_agrees_with_the_committed_files(self) -> None:
        completed = subprocess.run(
            [sys.executable, "-B", str(GENERATOR), "--check"],
            cwd=str(HERE),
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertIn("OK", completed.stdout)


class PanelShapeTest(unittest.TestCase):
    def test_header_mirrors_panel_columns_and_artifact_order(self) -> None:
        header = generate.panel_csv().splitlines()[0]
        expected = [*generate.PANEL_COLUMNS, *generate.FEATURES]
        self.assertEqual(header, ",".join(expected))
        # The ten provenance columns are spelled exactly as the assembler spells them.
        self.assertEqual(
            generate.PANEL_COLUMNS,
            (
                "cut",
                "comuna",
                "comuna_unresolved",
                "provincia",
                "region",
                "local_date",
                "fire_today",
                "fire_count",
                "burned_ha",
                "meteorology_readings",
            ),
        )

    def test_feature_order_and_units_mirror_the_committed_artifact(self) -> None:
        declared = artifact()["features"]
        self.assertEqual(generate.FEATURES, tuple(feature["name"] for feature in declared))
        self.assertEqual(
            generate.FEATURE_UNITS,
            {feature["name"]: feature["unit"] for feature in declared},
        )

    def test_every_feature_value_respects_the_artifact_guard(self) -> None:
        declared = {feature["name"]: feature for feature in artifact()["features"]}
        rows = panel_rows()
        for feature in WEATHER_FIELDS:
            low, high = declared[feature]["min"], declared[feature]["max"]
            for row in rows:
                cell = row[feature]
                if cell == "":
                    continue
                value = float(cell)
                with self.subTest(feature=feature, cut=row["cut"], date=row["local_date"]):
                    self.assertGreaterEqual(value, low)
                    self.assertLessEqual(value, high)

    def test_feature_values_are_plausible_not_merely_in_bounds(self) -> None:
        rows = panel_rows()
        for feature, (low, high) in PLAUSIBLE.items():
            values = [float(row[feature]) for row in rows if row[feature] != ""]
            with self.subTest(feature=feature):
                self.assertTrue(values, f"{feature} has no reading at all")
                self.assertGreaterEqual(min(values), low)
                self.assertLessEqual(max(values), high)

    def test_daily_minimum_stays_below_the_daily_maximum(self) -> None:
        for row in panel_rows():
            if row["temp_max"] == "" or row["temp_min"] == "":
                continue
            with self.subTest(cut=row["cut"], date=row["local_date"]):
                self.assertLess(float(row["temp_min"]), float(row["temp_max"]))

    def test_grid_is_every_comuna_on_every_contiguous_day_exactly_once(self) -> None:
        rows = panel_rows()
        comunas = sorted({row["cut"] for row in rows})
        dates = sorted({row["local_date"] for row in rows})
        self.assertEqual(comunas, ["05101", "05109", "05801"])
        self.assertEqual(len(dates), 12)
        self.assertEqual(dates[0], "2026-11-09")
        self.assertEqual(dates[-1], "2026-11-20")
        # Contiguous: each date is the previous one plus a day.
        parsed = [date.fromisoformat(value) for value in dates]
        for earlier, later in zip(parsed, parsed[1:], strict=False):
            self.assertEqual(later - earlier, timedelta(days=1))
        keys = [(row["cut"], row["local_date"]) for row in rows]
        self.assertEqual(len(keys), len(set(keys)))
        self.assertEqual(len(keys), len(comunas) * len(dates))

    def test_cut_keeps_its_leading_zero_and_names_are_the_tracked_ones(self) -> None:
        rows = {(row["cut"], row["comuna"], row["provincia"], row["region"]) for row in panel_rows()}
        self.assertEqual(
            rows,
            {
                ("05101", "Valparaíso", "Valparaíso", "Valparaiso"),
                ("05109", "Viña del Mar", "Valparaíso", "Valparaiso"),
                ("05801", "Quilpué", "Marga Marga", "Valparaiso"),
            },
        )
        for row in panel_rows():
            self.assertEqual(row["comuna_unresolved"], "")

    def test_meteorology_readings_keeps_the_assemblers_meaning(self) -> None:
        # The column counts meteorological readings attached to the comuna-day's
        # events, as `assemble.py` defines it. This fixture is an independent
        # weather source with no event-attached readings, so the honest value is
        # 0 in every row -- including the rows whose seven weather cells are all
        # populated. Using it for cell coverage would be a second meaning under
        # a name a future consumer already knows.
        for row in panel_rows():
            with self.subTest(cut=row["cut"], date=row["local_date"]):
                self.assertEqual(row["meteorology_readings"], "0")
        complete = [
            row for row in panel_rows() if all(row[feature] != "" for feature in WEATHER_FIELDS)
        ]
        self.assertTrue(complete, "a fully populated row is what makes the 0 meaningful")
        self.assertEqual({row["meteorology_readings"] for row in complete}, {"0"})


class LabelTest(unittest.TestCase):
    def test_both_label_states_exist_in_every_comuna(self) -> None:
        rows = panel_rows()
        for cut in ("05101", "05109", "05801"):
            states = {row["fire_today"] for row in rows if row["cut"] == cut}
            with self.subTest(cut=cut):
                self.assertEqual(states, {"0", "1"})

    def test_quiet_days_carry_a_true_zero_and_event_days_a_positive_area(self) -> None:
        for row in panel_rows():
            with self.subTest(cut=row["cut"], date=row["local_date"]):
                if row["fire_today"] == "0":
                    self.assertEqual(row["fire_count"], "0")
                    self.assertEqual(row["burned_ha"], "0")
                else:
                    self.assertEqual(row["fire_today"], "1")
                    self.assertGreaterEqual(int(row["fire_count"]), 1)
                    if row["burned_ha"] != "":
                        self.assertGreater(float(row["burned_ha"]), 0.0)

    def test_one_event_day_reports_an_unreadable_area_as_empty_not_zero(self) -> None:
        rows = panel_rows()
        unknown = [row for row in rows if row["fire_today"] == "1" and row["burned_ha"] == ""]
        self.assertEqual(len(unknown), 1)
        self.assertEqual(unknown[0]["cut"], "05101")
        self.assertEqual(unknown[0]["local_date"], "2026-11-18")
        self.assertEqual(unknown[0]["fire_count"], "2")

    def test_the_target_columns_are_not_feature_columns(self) -> None:
        self.assertEqual(set(TARGET_COLUMNS) & set(generate.FEATURES), set())
        self.assertEqual(set(TARGET_COLUMNS) & set(generate.PANEL_COLUMNS), set(TARGET_COLUMNS))


class MissingVersusZeroTest(unittest.TestCase):
    def test_precipitation_distinguishes_a_dry_week_from_an_unknown_one(self) -> None:
        rows = panel_rows()
        zeros = [row for row in rows if row["precip_sum"] == "0"]
        blanks = [row for row in rows if row["precip_sum"] == ""]
        wet = [row for row in rows if row["precip_sum"] not in ("", "0")]
        self.assertTrue(zeros, "a measured zero is part of this fixture")
        self.assertTrue(blanks, "an incomplete window must be empty, not 0")
        self.assertTrue(wet)
        # The empty cells are the incomplete windows, not a smaller sum.
        for row in blanks:
            self.assertEqual(row["cut"], "05101")
            self.assertIn(row["local_date"], {"2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"})

    def test_calm_day_has_a_zero_speed_and_an_undefined_direction(self) -> None:
        calm = [
            row
            for row in panel_rows()
            if row["cut"] == "05109" and row["local_date"] == "2026-11-16"
        ]
        self.assertEqual(len(calm), 1)
        self.assertEqual(calm[0]["wind_speed"], "0")
        self.assertEqual(calm[0]["wind_dir"], "")

    def test_no_cell_writes_a_pseudo_value(self) -> None:
        for row in panel_rows():
            for column, cell in row.items():
                with self.subTest(column=column):
                    self.assertNotIn(cell.lower(), {"none", "nan", "null", "na", "n/a", "-", "undefined"})

    def test_missing_cells_do_not_track_the_label(self) -> None:
        rows = panel_rows()
        gaps = missing_cells(rows)
        self.assertTrue(gaps, "the fixture must carry explicit gaps")
        by_feature: dict[str, set[str]] = {}
        for (_cut, _date, feature), row in gaps.items():
            by_feature.setdefault(feature, set()).add(row["fire_today"])
        for feature, states in by_feature.items():
            with self.subTest(feature=feature):
                self.assertEqual(
                    states,
                    {"0", "1"},
                    f"{feature} is only ever missing on one label state",
                )
        # A complete event row and an incomplete quiet row both exist, so neither
        # completeness nor its absence identifies the label.
        complete_events = [
            row
            for row in rows
            if row["fire_today"] == "1"
            and all(row[feature] != "" for feature in WEATHER_FIELDS)
        ]
        incomplete_quiet = [
            row
            for row in rows
            if row["fire_today"] == "0"
            and any(row[feature] == "" for feature in WEATHER_FIELDS)
        ]
        self.assertTrue(complete_events)
        self.assertTrue(incomplete_quiet)


class PrecipitationWindowTest(unittest.TestCase):
    def test_each_cell_is_the_seven_day_sum_including_the_reference_date(self) -> None:
        rows = {(row["cut"], row["local_date"]): row for row in panel_rows()}
        for cut in generate.COMUNAS:
            for local_date in generate.PANEL_DATES:
                cell = rows[(cut, local_date.isoformat())]["precip_sum"]
                # Recomputed from the daily table, not from the same function
                # under test: the window is seven civil days ending on and
                # including the reference date.
                window = [local_date - timedelta(days=offset) for offset in range(6, -1, -1)]
                daily = [generate.daily_precipitation(cut, day) for day in window]
                if any(value is None for value in daily):
                    expected = None
                else:
                    expected = round(sum(value for value in daily if value is not None), 2)
                with self.subTest(cut=cut, date=local_date.isoformat()):
                    if expected is None:
                        self.assertEqual(cell, "")
                    else:
                        self.assertEqual(float(cell), expected)

    def test_the_window_is_fixed_at_seven_civil_days(self) -> None:
        self.assertEqual(generate.PRECIPITATION_WINDOW_DAYS, 7)
        # The six days of warm-up exist so the first exported day already has a
        # complete window; a shorter window is refused rather than computed.
        self.assertEqual(generate.PANEL_DATES[0] - generate.SERIES_START, timedelta(days=6))
        for days in (1, 6, 8):
            with self.subTest(days=days), self.assertRaises(ValueError):
                generate.seven_day_precipitation("05801", generate.PANEL_DATES[-1], days=days)


class SectorFixtureTest(unittest.TestCase):
    def fixture(self) -> dict:
        return json.loads(SECTORS.read_text(encoding="utf-8"))

    def test_top_level_contract_is_exactly_the_agreed_keys(self) -> None:
        document = self.fixture()
        self.assertEqual(
            list(document),
            ["dataset_id", "provenance", "time_zone", "sectors"],
        )
        self.assertEqual(document["dataset_id"], "firewatch-synthetic-handoff-v1")
        self.assertEqual(document["provenance"], "synthetic")
        self.assertEqual(document["time_zone"], "America/Santiago")

    def test_three_sectors_in_the_approved_map_order(self) -> None:
        sectors = self.fixture()["sectors"]
        self.assertEqual(
            [(sector["sector_id"], sector["name"]) for sector in sectors],
            [
                ("quebrada-este", "Quebrada del Este"),
                ("borde-costero", "Borde costero"),
                ("interior-sin-lectura", "Interior sin lectura"),
            ],
        )
        self.assertEqual(
            [sector["communes"] for sector in sectors],
            [
                ["Valparaíso", "Viña del Mar", "Quilpué"],
                ["Viña del Mar"],
                ["Quilpué"],
            ],
        )

    def test_each_sector_carries_exactly_the_agreed_fields(self) -> None:
        for sector in self.fixture()["sectors"]:
            with self.subTest(sector=sector["sector_id"]):
                self.assertEqual(
                    list(sector),
                    ["sector_id", "name", "communes", "local_date", "weather", "terrain"],
                )
                self.assertEqual(list(sector["weather"]), list(WEATHER_FIELDS))
                self.assertEqual(list(sector["terrain"]), list(TERRAIN_FIELDS))
                self.assertEqual(sector["local_date"], "2026-11-20")

    def test_readings_cover_full_partial_and_missing(self) -> None:
        sectors = {sector["sector_id"]: sector for sector in self.fixture()["sectors"]}
        full = sectors["quebrada-este"]
        partial = sectors["borde-costero"]
        silent = sectors["interior-sin-lectura"]

        def present(sector: dict) -> int:
            return sum(1 for feature in WEATHER_FIELDS if sector["weather"][feature] is not None)

        self.assertEqual(present(full), 7)
        self.assertEqual(present(partial), 5)
        self.assertEqual(present(silent), 0)
        self.assertEqual(partial["weather"]["precip_sum"], 0.0)
        for feature in TERRAIN_FIELDS:
            self.assertIsNotNone(full["terrain"][feature])
            self.assertIsNotNone(partial["terrain"][feature])
            self.assertIsNone(silent["terrain"][feature])

    def test_sector_values_stay_inside_the_artifact_guard(self) -> None:
        declared = {feature["name"]: feature for feature in artifact()["features"]}
        for sector in self.fixture()["sectors"]:
            for feature in WEATHER_FIELDS:
                value = sector["weather"][feature]
                if value is None:
                    continue
                with self.subTest(sector=sector["sector_id"], feature=feature):
                    self.assertGreaterEqual(value, declared[feature]["min"])
                    self.assertLessEqual(value, declared[feature]["max"])
                    low, high = PLAUSIBLE[feature]
                    self.assertGreaterEqual(value, low)
                    self.assertLessEqual(value, high)


class GeneratorSafetyTest(unittest.TestCase):
    def test_generator_writes_nothing_and_imports_only_the_standard_library(self) -> None:
        source = GENERATOR.read_text(encoding="utf-8")
        forbidden = (
            "write_text",
            "write_bytes",
            "open(",
            "mkdir",
            "unlink",
            "os.remove",
            "os.rename",
            "shutil",
            "tempfile",
            "subprocess",
            "urllib",
            "requests",
            "socket",
            "import os",
        )
        for token in forbidden:
            with self.subTest(token=token):
                self.assertNotIn(token, source)

    def test_every_artifact_is_utf8_lf_with_a_final_newline(self) -> None:
        for path in (PANEL, SECTORS, MANIFEST):
            with self.subTest(path=path.name):
                self.assertTrue(path.is_file())
                data = path.read_bytes()
                self.assertFalse(data.startswith(b"\xef\xbb\xbf"))
                self.assertNotIn(b"\r", data)
                self.assertTrue(data.endswith(b"\n"))
                for line in data.split(b"\n"):
                    self.assertFalse(line.endswith(b" "), "trailing space")
                data.decode("utf-8")


class ManifestTest(unittest.TestCase):
    def manifest(self) -> dict:
        return json.loads(MANIFEST.read_text(encoding="utf-8"))

    def test_manifest_records_the_files_it_describes(self) -> None:
        manifest = self.manifest()
        self.assertEqual(manifest["dataset_id"], "firewatch-synthetic-handoff-v1")
        self.assertEqual(manifest["provenance"], "synthetic")
        self.assertEqual(manifest["time_zone"], "America/Santiago")
        self.assertEqual(manifest["panel"]["file"], "panel-synthetic.csv")
        self.assertEqual(manifest["sector_fixture"]["file"], "sector-fixture.json")
        for entry in (manifest["panel"], manifest["sector_fixture"]):
            data = (HERE / entry["file"]).read_bytes()
            self.assertEqual(entry["bytes"], len(data))
            self.assertEqual(entry["sha256"], hashlib.sha256(data).hexdigest())

    def test_manifest_declares_seven_features_with_units_and_both_aggregations(self) -> None:
        manifest = self.manifest()
        self.assertEqual([feature["name"] for feature in manifest["features"]], list(WEATHER_FIELDS))
        for feature in manifest["features"]:
            with self.subTest(feature=feature["name"]):
                self.assertEqual(feature["unit"], generate.FEATURE_UNITS[feature["name"]])
                self.assertTrue(feature["training_aggregation"])
                self.assertTrue(feature["serving_aggregation"])
                self.assertIn(feature["serving_window_days"], (1, 7))

    def test_manifest_states_what_is_excluded_and_what_is_still_needed(self) -> None:
        manifest = self.manifest()
        self.assertEqual(
            manifest["excluded_from_features"],
            list(TARGET_COLUMNS),
        )
        self.assertTrue(manifest["limits"])
        self.assertTrue(manifest["label_blockers"])
        for blocker in manifest["label_blockers"]:
            with self.subTest(source=blocker["source"]):
                self.assertIn(
                    blocker["access_state"],
                    {"access_request_required", "metadata_without_distribution", "partial_open_sample"},
                )

    def test_manifest_explains_the_zero_without_redefining_the_column(self) -> None:
        declared = self.manifest()["panel"]["meteorology_readings"]
        self.assertEqual(declared["value"], 0)
        self.assertEqual(declared["code"], "no_event_attached_readings")

    def test_manifest_drops_prose_the_readme_already_keeps(self) -> None:
        # Machine metadata carries facts and hashes; the narrative stays in one
        # place. A key that only restates the README is duplication with a
        # second chance to drift.
        manifest = self.manifest()
        for duplicated in (
            "known_divergences",
            "zero_examples",
            "still_required",
            "weather_source_rule",
            "sector_candidates",
            "backend_adaptation",
            "not_claimed",
        ):
            with self.subTest(key=duplicated):
                self.assertNotIn(duplicated, manifest)
        for feature in manifest["features"]:
            with self.subTest(feature=feature["name"]):
                self.assertNotIn("research_requirement", feature)

    def test_manifest_claims_no_model_quality_whatsoever(self) -> None:
        # A synthetic fixture has no held-out evaluation, so any metric name here
        # would be invented. The absence is the assertion.
        text = MANIFEST.read_text(encoding="utf-8").lower()
        for token in ("roc_auc", "pr_auc", "brier", "recall", "accuracy", "f1_score", "calibrat"):
            with self.subTest(token=token):
                self.assertNotIn(token, text)


if __name__ == "__main__":
    unittest.main()
