"""Unit tests for the Esri JSON -> GeoJSON conversion and its provenance.

No network is used: every case runs against the small fixture embedded below.
Run with ``python backend/scripts/test_fetch_comunas.py``.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
import unittest
from pathlib import Path

# The documented runner is ``python -m unittest backend/scripts/test_fetch_comunas.py``
# from the repository root, so the sibling module is not importable by default;
# pytest inserts this directory on its own. Keep both runners equivalent.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import fetch_comunas  # type: ignore[import-not-found]  # noqa: E402


def ring(*points):
    return [list(point) for point in points]


# Esri source convention: outer rings clockwise (negative area), holes
# counter-clockwise (positive area). Rings here are intentionally unclosed to
# prove the converter closes them.
SIMPLE_OUTER = ring((0, 0), (0, 10), (10, 10), (10, 0))
HOLE_OUTER = ring((0, 0), (0, 20), (20, 20), (20, 0))
HOLE_INNER = ring((5, 5), (10, 5), (10, 10), (5, 10))
MULTI_OUTER_A = ring((30, 30), (30, 40), (40, 40), (40, 30))
MULTI_OUTER_B = ring((100, 100), (100, 110), (110, 110), (110, 100))

PAYLOAD = {
    "geometryType": "esriGeometryPolygon",
    "features": [
        {
            "attributes": {
                "CUT_COM": "05804",
                "COMUNA": "Comuna C",
                "PROVINCIA": "Provincia",
                "CUT_PROV": "058",
            },
            "geometry": {"rings": [MULTI_OUTER_B, MULTI_OUTER_A]},
        },
        {
            "attributes": {
                "CUT_COM": "05301",
                "COMUNA": "Comuna B",
                "PROVINCIA": "Provincia",
                "CUT_PROV": "053",
            },
            "geometry": {"rings": [SIMPLE_OUTER]},
        },
        {
            "attributes": {
                "CUT_COM": "05101",
                "COMUNA": "Comuna A",
                "PROVINCIA": "Provincia",
                "CUT_PROV": "051",
            },
            "geometry": {"rings": [HOLE_OUTER, HOLE_INNER]},
        },
    ],
}

TRUNCATED = dict(PAYLOAD, exceededTransferLimit=True)


def feature_by_cut(collection, cut):
    (feature,) = [
        item for item in collection["features"] if item["properties"]["CUT_COM"] == cut
    ]
    return feature


# ---------------------------------------------------------------------------
# README <-> provenance artifact alignment
# ---------------------------------------------------------------------------

README_SECTION_HEADING = "## Geospatial provenance and DIFROL restriction"
README_NOT_VALIDATED_SENTENCE = (
    "No external DIFROL authority review or validation is claimed."
)
README_RELPATH = "README.md"
PROVENANCE_FIELDS = (
    "provider",
    "endpoint",
    "query_sha256",
    "retrieved_at",
    "cutoff_at",
    "source_format",
    "derived_format",
    "attribution",
    "restriction",
    "restriction_source",
)
PROSE_MARKERS = {
    "attribution": "Attribution, verbatim from the service metadata:",
    "restriction": "Restriction, verbatim from the service metadata:",
    "restriction_source": "Restriction source, the metadata record that carries it:",
}
PROSE_SPAN_RE = re.compile(r"«([^»]*)»")
TABLE_SEPARATOR_RE = re.compile(r"^:?-{3,}:?$")


def strip_code_span(cell):
    """Return a table cell, unwrapping one surrounding pair of backticks."""
    cell = cell.strip()
    if len(cell) >= 2 and cell.startswith("`") and cell.endswith("`"):
        return cell[1:-1]
    return cell


def readme_section(text):
    """Lines of the README provenance section, without the heading itself."""
    lines = text.splitlines()
    try:
        start = next(
            index
            for index, line in enumerate(lines)
            if line.strip() == README_SECTION_HEADING
        ) + 1
    except StopIteration:
        return []
    section = []
    for line in lines[start:]:
        if line.startswith("## "):
            break
        section.append(line)
    return section


def split_table_row(line):
    """Cells of a strict pipe row, or None when it is not pipe-delimited."""
    if len(line) < 2 or not line.startswith("|") or not line.endswith("|"):
        return None
    return [cell.strip() for cell in line[1:-1].split("|")]


def readme_table_report(text):
    """Return (rows, problems) for the section's single Markdown table.

    Strict on purpose: exactly one contiguous block of ``|``-prefixed lines, a
    two-cell non-empty header, a two-cell ``---`` separator and two-cell body
    rows that start and end with a pipe. GitHub still renders the first two
    cells of a wider row, so every deviation is reported instead of skipped.
    """
    rows = []
    problems = []
    blocks = []
    current = []
    for line in readme_section(text):
        stripped = line.strip()
        if stripped.startswith("|"):
            current.append(stripped)
            continue
        if current:
            blocks.append(current)
            current = []
        if stripped and "|" in stripped:
            problems.append(f"pipe outside the table {stripped!r}")
    if current:
        blocks.append(current)
    if len(blocks) != 1:
        problems.append(f"table blocks {len(blocks)}")
        return rows, problems
    block = blocks[0]
    header = split_table_row(block[0])
    if header is None or len(header) != 2 or not all(header):
        problems.append("malformed table header")
    if len(block) < 2:
        problems.append("missing table separator")
        return rows, problems
    separator = split_table_row(block[1])
    if (
        separator is None
        or len(separator) != 2
        or not all(TABLE_SEPARATOR_RE.fullmatch(cell) for cell in separator)
    ):
        problems.append("malformed table separator")
    for line in block[2:]:
        cells = split_table_row(line)
        if cells is None or len(cells) != 2:
            problems.append(f"malformed table row {line!r}")
            continue
        rows.append((strip_code_span(cells[0]), strip_code_span(cells[1])))
    return rows, problems


def readme_table(text):
    """Ordered body rows of the single table; ValueError when it is malformed."""
    rows, problems = readme_table_report(text)
    if problems:
        raise ValueError("; ".join(problems))
    return rows


def readme_prose_declarations(text, marker):
    """Marker prose lines and every «...» span found on them."""
    lines = [
        line.strip()
        for line in readme_section(text)
        if line.strip() and not line.lstrip().startswith("|")
    ]
    matching = [line for line in lines if line.startswith(marker)]
    spans = [span for line in matching for span in PROSE_SPAN_RE.findall(line)]
    return matching, spans


def readme_prose_span(text, marker):
    """Exact «...» span of the marker; None when missing, repeated or ambiguous."""
    matching, spans = readme_prose_declarations(text, marker)
    if len(matching) != 1 or len(spans) != 1:
        return None
    return spans[0]


def check_readme_provenance(readme_text, artifact):
    """Return every README requirement the declaration does not satisfy.

    The check is row-bound and span-bound: each declared field must carry the
    exact artifact value in its own table row, and the attribution, restriction
    and restriction source must be reproduced byte-for-byte inside «...» spans
    in the prose. An empty list means the README and the artifact are aligned.
    """
    missing = []
    if README_SECTION_HEADING not in readme_text.splitlines():
        missing.append("section heading")
    if fetch_comunas.PROVENANCE_RELPATH not in readme_text:
        missing.append("provenance artifact")
    if fetch_comunas.DERIVED_RELPATH not in readme_text:
        missing.append("derived artifact")
    rows, table_problems = readme_table_report(readme_text)
    missing.extend(table_problems)
    seen = set()
    for label, _ in rows:
        if label in seen:
            missing.append(f"duplicate row {label}")
        else:
            seen.add(label)
        if label not in PROVENANCE_FIELDS:
            missing.append(f"unexpected row {label}")
    for field in PROVENANCE_FIELDS:
        expected = artifact.get(field)
        if not isinstance(expected, str) or not expected:
            missing.append(f"artifact {field}")
            continue
        values = [value for label, value in rows if label == field]
        if not values:
            missing.append(f"row {field}")
        elif any(value != expected for value in values):
            missing.append(f"value {field}")
    for field, marker in PROSE_MARKERS.items():
        matching, spans = readme_prose_declarations(readme_text, marker)
        if not matching or not spans:
            missing.append(f"prose {field}")
        elif len(matching) > 1:
            missing.append(f"duplicate prose {field}")
        elif len(spans) > 1:
            missing.append(f"ambiguous prose {field}")
        elif spans[0] != artifact.get(field):
            missing.append(f"prose {field}")
    if README_NOT_VALIDATED_SENTENCE not in readme_text:
        missing.append("not-validated claim")
    return missing


class TestGeometryConversion(unittest.TestCase):
    def setUp(self):
        self.collection = fetch_comunas.esri_to_geojson(PAYLOAD)

    def test_feature_collection_with_sorted_features(self):
        self.assertEqual(self.collection["type"], "FeatureCollection")
        cuts = [item["properties"]["CUT_COM"] for item in self.collection["features"]]
        self.assertEqual(cuts, sorted(cuts))
        self.assertEqual(cuts, ["05101", "05301", "05804"])

    def test_single_outer_ring_becomes_counter_clockwise_polygon(self):
        geometry = feature_by_cut(self.collection, "05301")["geometry"]
        self.assertEqual(geometry["type"], "Polygon")
        self.assertEqual(len(geometry["coordinates"]), 1)
        outer = geometry["coordinates"][0]
        self.assertEqual(outer[0], outer[-1])
        self.assertGreater(fetch_comunas.signed_area(outer), 0)

    def test_hole_is_classified_and_oriented_per_rfc_7946(self):
        geometry = feature_by_cut(self.collection, "05101")["geometry"]
        self.assertEqual(geometry["type"], "Polygon")
        self.assertEqual(len(geometry["coordinates"]), 2)
        outer, hole = geometry["coordinates"]
        self.assertEqual(outer[0], outer[-1])
        self.assertEqual(hole[0], hole[-1])
        self.assertGreater(fetch_comunas.signed_area(outer), 0)
        self.assertLess(fetch_comunas.signed_area(hole), 0)
        self.assertTrue(fetch_comunas.point_in_ring(hole[0], outer))

    def test_several_outer_rings_become_multipolygon(self):
        geometry = feature_by_cut(self.collection, "05804")["geometry"]
        self.assertEqual(geometry["type"], "MultiPolygon")
        self.assertEqual(len(geometry["coordinates"]), 2)
        for polygon in geometry["coordinates"]:
            for element in polygon:
                self.assertEqual(element[0], element[-1])
                self.assertGreater(fetch_comunas.signed_area(element), 0)

    def test_unclosed_input_ring_is_closed_in_output(self):
        self.assertNotEqual(SIMPLE_OUTER[0], SIMPLE_OUTER[-1])
        outer = feature_by_cut(self.collection, "05301")["geometry"]["coordinates"][0]
        self.assertEqual(outer[0], outer[-1])

    def test_close_ring_is_idempotent(self):
        closed = fetch_comunas.close_ring(SIMPLE_OUTER)
        self.assertEqual(fetch_comunas.close_ring(closed), closed)

    def test_properties_keep_the_four_declared_fields(self):
        properties = feature_by_cut(self.collection, "05101")["properties"]
        self.assertEqual(
            set(properties), {"CUT_COM", "COMUNA", "PROVINCIA", "CUT_PROV"}
        )


class TestCompleteness(unittest.TestCase):
    def test_complete_when_count_matches_and_not_truncated(self):
        result = fetch_comunas.check_completeness(PAYLOAD, expected=3)
        self.assertEqual(result["record_count"], 3)
        self.assertTrue(result["record_count_matches_expected"])
        self.assertFalse(result["exceeded_transfer_limit"])
        self.assertTrue(result["complete"])

    def test_truncated_payload_is_incomplete(self):
        result = fetch_comunas.check_completeness(TRUNCATED, expected=3)
        self.assertTrue(result["exceeded_transfer_limit"])
        self.assertFalse(result["complete"])

    def test_count_mismatch_is_incomplete(self):
        result = fetch_comunas.check_completeness(PAYLOAD, expected=38)
        self.assertFalse(result["record_count_matches_expected"])
        self.assertFalse(result["complete"])


class TestProvenance(unittest.TestCase):
    """The artifact, the downloader definitions and the README are one contract.

    The README proof is row-bound and span-bound: a value must sit in its own
    table row, and the attribution, restriction and restriction source must be
    reproduced byte-for-byte inside «...» spans in the prose. The mutation cases
    prove each corruption is rejected instead of merely looking plausible.
    """

    @classmethod
    def setUpClass(cls):
        root = fetch_comunas.repository_root()
        cls.artifact = json.loads(
            (root / fetch_comunas.PROVENANCE_RELPATH).read_text(encoding="utf-8")
        )
        cls.readme = (root / README_RELPATH).read_text(encoding="utf-8")

    def test_only_embedded_provenance_destination(self):
        self.assertEqual(
            fetch_comunas.PROVENANCE_RELPATH,
            "backend/contracts/gen/geo/valparaiso-comunas.provenance.json",
        )

    def test_serialization_is_deterministic(self):
        first = fetch_comunas.dumps_provenance(self.provenance())
        self.assertEqual(first, fetch_comunas.dumps_provenance(self.provenance()))
        self.assertTrue(first.endswith(b"\n"))

    def provenance(self):
        return fetch_comunas.build_provenance(
            endpoint=fetch_comunas.QUERY_URL,
            query_sha256="0" * 64,
            retrieved_at="2026-01-01T00:00:00+00:00",
            cutoff_at="2026-01-01T00:00:00+00:00",
            record_count=38,
            expected_record_count=38,
            complete=True,
            exceeded_transfer_limit=False,
            raw_path="data/raw/geo/valparaiso-comunas-20260101.esri.json",
            raw_sha256="a" * 64,
            derived_path="backend/contracts/gen/geo/valparaiso-comunas.geojson",
            derived_sha256="b" * 64,
        )

    def test_attribution_verbatim(self):
        expected = (
            "Subsecretaria de Desarrollo Regional y Administrativo (SUBDERE), "
            "Instituto Geografico Militar (IGM) e Instituto Nacional de Estadisticas (INE)"
        )
        self.assertEqual(fetch_comunas.ATTRIBUTION, expected)
        self.assertEqual(self.provenance()["attribution"], expected)

    def test_restriction_verbatim(self):
        expected = (
            "las publicaciones y productos derivados de esta cartografia deben ser "
            "revisadas y validadas por DIFROL."
        )
        self.assertEqual(fetch_comunas.RESTRICTION, expected)
        self.assertEqual(self.provenance()["restriction"], expected)

    def test_formats_and_spatial_references(self):
        provenance = self.provenance()
        self.assertEqual(provenance["requested_srid"], 4326)
        self.assertEqual(provenance["source_wkid"], 5360)
        self.assertEqual(provenance["source_format"], "Esri JSON")
        self.assertEqual(provenance["derived_format"], "GeoJSON (RFC 7946)")

    def test_cutoff_is_retrieved_at_and_notes_declare_it(self):
        provenance = self.provenance()
        self.assertEqual(provenance["cutoff_at"], provenance["retrieved_at"])
        self.assertIn("cutoff_at", provenance["notes"])
        self.assertIn("Antartica", provenance["notes"])

    def test_required_fields_are_present(self):
        required = {
            "source_id",
            "provider",
            "endpoint",
            "query_sha256",
            "requested_srid",
            "source_wkid",
            "source_format",
            "derived_format",
            "retrieved_at",
            "cutoff_at",
            "record_count",
            "expected_record_count",
            "complete",
            "exceeded_transfer_limit",
            "raw_path",
            "raw_sha256",
            "derived_path",
            "derived_sha256",
            "attribution",
            "restriction",
            "restriction_source",
            "notes",
        }
        self.assertLessEqual(required, set(self.provenance()))

    # -- the artifact is still the row the downloader defines ---------------
    def test_artifact_matches_the_downloader_definitions(self):
        self.assertEqual(self.artifact["endpoint"], fetch_comunas.QUERY_URL)
        self.assertEqual(
            self.artifact["query_sha256"],
            hashlib.sha256(fetch_comunas.QUERY_URL.encode("utf-8")).hexdigest(),
        )
        self.assertEqual(self.artifact["attribution"], fetch_comunas.ATTRIBUTION)
        self.assertEqual(self.artifact["restriction"], fetch_comunas.RESTRICTION)
        self.assertEqual(
            self.artifact["restriction_source"], fetch_comunas.RESTRICTION_SOURCE
        )
        self.assertEqual(self.artifact["cutoff_at"], self.artifact["retrieved_at"])

    # -- README <-> artifact alignment --------------------------------------
    def test_readme_table_binds_each_field_to_its_own_exact_value(self):
        expected = [(field, self.artifact[field]) for field in PROVENANCE_FIELDS]
        self.assertEqual(readme_table(self.readme), expected)

    def test_readme_prose_quotes_the_three_restricted_values_exactly(self):
        for field, marker in PROSE_MARKERS.items():
            self.assertEqual(
                readme_prose_span(self.readme, marker), self.artifact[field]
            )

    def test_readme_is_aligned_with_the_artifact(self):
        self.assertEqual(check_readme_provenance(self.readme, self.artifact), [])

    # -- corruption helpers --------------------------------------------------
    def mutate_table_cell(self, text, field, value):
        """Replace the value cell of exactly one provenance table row."""
        lines = text.splitlines(keepends=True)
        changed = False
        output = []
        for line in lines:
            cells = (
                [cell.strip() for cell in line.strip().strip("|").split("|")]
                if line.lstrip().startswith("|")
                else []
            )
            if len(cells) == 2 and strip_code_span(cells[0]) == field:
                line = f"| `{field}` | `{value}` |\n"
                changed = True
            output.append(line)
        self.assertTrue(changed, f"no table row for {field!r}")
        return "".join(output)

    def drop_table_row(self, text, field):
        """Remove exactly one provenance table row."""
        lines = text.splitlines(keepends=True)
        changed = False
        output = []
        for line in lines:
            cells = (
                [cell.strip() for cell in line.strip().strip("|").split("|")]
                if line.lstrip().startswith("|")
                else []
            )
            if len(cells) == 2 and strip_code_span(cells[0]) == field:
                changed = True
                continue
            output.append(line)
        self.assertTrue(changed, f"no table row for {field!r}")
        return "".join(output)

    def append_inside_prose_span(self, text, field, suffix):
        """Append text inside the «...» span of one prose declaration."""
        marker = PROSE_MARKERS[field]
        quoted = f"«{self.artifact[field]}»"
        lines = text.splitlines(keepends=True)
        changed = False
        output = []
        for line in lines:
            if not line.lstrip().startswith("|") and line.strip().startswith(marker):
                changed = quoted in line
                line = line.replace(quoted, f"«{self.artifact[field]}{suffix}»")
            output.append(line)
        self.assertTrue(changed, f"no delimited {field!r} prose span")
        return "".join(output)

    # -- each corruption must be rejected ------------------------------------
    def test_altered_provider_row_is_rejected(self):
        mutated = self.mutate_table_cell(
            self.readme, "provider", "MOP - IDE Chile (SERVICIO_DPA)"
        )
        self.assertIn(
            "value provider", check_readme_provenance(mutated, self.artifact)
        )

    def test_missing_provider_row_is_rejected(self):
        mutated = self.drop_table_row(self.readme, "provider")
        self.assertIn("row provider", check_readme_provenance(mutated, self.artifact))

    def test_swapped_source_and_derived_format_rows_are_rejected(self):
        mutated = self.mutate_table_cell(
            self.readme, "source_format", self.artifact["derived_format"]
        )
        mutated = self.mutate_table_cell(
            mutated, "derived_format", self.artifact["source_format"]
        )
        missing = check_readme_provenance(mutated, self.artifact)
        self.assertIn("value source_format", missing)
        self.assertIn("value derived_format", missing)

    def test_cutoff_only_mutation_is_rejected_while_retrieved_at_is_unchanged(self):
        mutated = self.mutate_table_cell(
            self.readme, "cutoff_at", "2026-10-11T00:00:00+00:00"
        )
        missing = check_readme_provenance(mutated, self.artifact)
        self.assertIn("value cutoff_at", missing)
        self.assertNotIn("value retrieved_at", missing)

    def test_appended_text_inside_prose_attribution_is_rejected(self):
        mutated = self.append_inside_prose_span(
            self.readme, "attribution", " y otros"
        )
        self.assertIn(
            "prose attribution", check_readme_provenance(mutated, self.artifact)
        )

    def test_appended_text_inside_prose_restriction_is_rejected(self):
        mutated = self.append_inside_prose_span(
            self.readme, "restriction", " y otras fuentes"
        )
        self.assertIn(
            "prose restriction", check_readme_provenance(mutated, self.artifact)
        )

    def test_missing_restriction_row_is_rejected(self):
        mutated = self.drop_table_row(self.readme, "restriction")
        self.assertIn(
            "row restriction", check_readme_provenance(mutated, self.artifact)
        )

    def test_missing_not_validated_claim_is_rejected(self):
        mutated = self.readme.replace(
            README_NOT_VALIDATED_SENTENCE, "[... omitted ...]"
        )
        self.assertNotEqual(mutated, self.readme)
        self.assertIn(
            "not-validated claim", check_readme_provenance(mutated, self.artifact)
        )

    def test_missing_artifact_references_are_rejected(self):
        mutated = self.readme.replace(fetch_comunas.PROVENANCE_RELPATH, "the artifact")
        self.assertNotEqual(mutated, self.readme)
        self.assertIn(
            "provenance artifact", check_readme_provenance(mutated, self.artifact)
        )

    # -- duplicated or unexpected rows/spans must fail closed -----------------
    def insert_table_row(self, text, label, value, before=None):
        """Insert a provenance table row; by default append after the last row."""
        lines = text.splitlines(keepends=True)
        last_table_index = max(
            (
                index
                for index, line in enumerate(lines)
                if line.lstrip().startswith("|")
            ),
            default=None,
        )
        output = []
        inserted = False
        for index, line in enumerate(lines):
            cells = (
                [cell.strip() for cell in line.strip().strip("|").split("|")]
                if line.lstrip().startswith("|")
                else []
            )
            if (
                before is not None
                and not inserted
                and len(cells) == 2
                and strip_code_span(cells[0]) == before
            ):
                output.append(f"| `{label}` | `{value}` |\n")
                inserted = True
            output.append(line)
            if before is None and not inserted and index == last_table_index:
                output.append(f"| `{label}` | `{value}` |\n")
                inserted = True
        self.assertTrue(inserted, f"could not insert row {label!r}")
        return "".join(output)

    def test_duplicate_contradictory_restriction_row_is_rejected(self):
        mutated = self.insert_table_row(
            self.readme,
            "restriction",
            "texto contradictorio que no es la restriccion del artefacto",
            before="restriction",
        )
        missing = check_readme_provenance(mutated, self.artifact)
        self.assertIn("duplicate row restriction", missing)
        self.assertIn("value restriction", missing)

    def test_unexpected_extra_table_row_is_rejected(self):
        mutated = self.insert_table_row(self.readme, "notes", "fila inventada")
        self.assertIn(
            "unexpected row notes", check_readme_provenance(mutated, self.artifact)
        )

    def test_duplicate_prose_marker_line_is_rejected(self):
        lines = self.readme.splitlines(keepends=True)
        output = []
        duplicated = False
        for line in lines:
            output.append(line)
            if line.strip().startswith(PROSE_MARKERS["restriction"]):
                output.append(line)
                duplicated = True
        self.assertTrue(duplicated)
        mutated = "".join(output)
        self.assertIn(
            "duplicate prose restriction",
            check_readme_provenance(mutated, self.artifact),
        )

    def test_two_spans_on_one_prose_marker_line_are_rejected(self):
        quoted = f"«{self.artifact['restriction']}»"
        mutated = self.readme.replace(quoted, f"{quoted} {quoted}", 1)
        self.assertNotEqual(mutated, self.readme)
        self.assertIn(
            "ambiguous prose restriction",
            check_readme_provenance(mutated, self.artifact),
        )

    # -- malformed or extra table structures must fail closed -----------------
    def insert_raw_line_after_row(self, text, field, raw_line):
        """Insert a raw line directly after one provenance table row."""
        lines = text.splitlines(keepends=True)
        output = []
        inserted = False
        for line in lines:
            output.append(line)
            cells = (
                [cell.strip() for cell in line.strip().strip("|").split("|")]
                if line.lstrip().startswith("|")
                else []
            )
            if len(cells) == 2 and strip_code_span(cells[0]) == field:
                output.append(raw_line + "\n")
                inserted = True
        self.assertTrue(inserted, f"no table row for {field!r}")
        return "".join(output)

    def assert_reported(self, missing, prefix):
        self.assertTrue(
            any(item.startswith(prefix) for item in missing),
            f"no {prefix!r} problem in {missing}",
        )

    def test_three_cell_row_inside_the_table_is_rejected(self):
        mutated = self.insert_raw_line_after_row(
            self.readme, "restriction", "| `restriction` | `bogus` | `extra` |"
        )
        missing = check_readme_provenance(mutated, self.artifact)
        self.assert_reported(missing, "malformed table row")

    def test_one_cell_row_inside_the_table_is_rejected(self):
        mutated = self.insert_raw_line_after_row(
            self.readme, "restriction", "| `restriction` |"
        )
        self.assert_reported(
            check_readme_provenance(mutated, self.artifact), "malformed table row"
        )

    def test_unclosed_pipe_row_inside_the_table_is_rejected(self):
        mutated = self.insert_raw_line_after_row(self.readme, "restriction", "| bogus")
        self.assert_reported(
            check_readme_provenance(mutated, self.artifact), "malformed table row"
        )

    def test_second_table_in_the_same_section_is_rejected(self):
        mutated = self.readme.rstrip("\n") + (
            "\n\n| Field | Value |\n| --- | --- |\n| `provider` | `otro` |\n"
        )
        self.assertIn("table blocks 2", check_readme_provenance(mutated, self.artifact))

    def test_pipe_outside_the_table_is_rejected(self):
        mutated = self.readme.replace(
            README_NOT_VALIDATED_SENTENCE,
            f"nota | suelta. {README_NOT_VALIDATED_SENTENCE}",
            1,
        )
        self.assertNotEqual(mutated, self.readme)
        self.assert_reported(
            check_readme_provenance(mutated, self.artifact),
            "pipe outside the table",
        )

    def test_malformed_header_is_rejected(self):
        mutated = self.readme.replace(
            "| Field | Value |", "| Field | Value | Extra |", 1
        )
        self.assertNotEqual(mutated, self.readme)
        self.assertIn(
            "malformed table header", check_readme_provenance(mutated, self.artifact)
        )

    def test_malformed_separator_is_rejected(self):
        mutated = self.readme.replace("| --- | --- |", "| --- |", 1)
        self.assertNotEqual(mutated, self.readme)
        self.assertIn(
            "malformed table separator",
            check_readme_provenance(mutated, self.artifact),
        )


if __name__ == "__main__":
    unittest.main()
