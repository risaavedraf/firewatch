#!/usr/bin/env python3
"""Emits the synthetic model-data handoff: a comuna-day panel and a sector fixture.

The panel is the shape `backend/training/assemble.py` already assembles -- the
same ten provenance columns in `PANEL_COLUMNS` and the seven feature names in
the order `backend/services/inference/testdata/logistic.json` declares -- filled
with a small, deterministic, entirely fictitious source. The sector fixture is
a separate design artifact for the front-end prototype; it is not a spatial
conversion of the panel and not a model input.

What this module is not: a source of real data, a model, an evaluation, or a
call to anything. It imports the standard library only, reads no credential and
reaches no provider, application path or network. It never opens a file for
writing: `--emit` prints one artifact to stdout and the caller redirects it,
`--check` only reads the committed files and compares bytes.

    python design/firewatch-v1-vuelo/model-data/generate.py --check
    python design/firewatch-v1-vuelo/model-data/generate.py --emit panel \
        > design/firewatch-v1-vuelo/model-data/panel-synthetic.csv
    python design/firewatch-v1-vuelo/model-data/generate.py --emit sectors \
        > design/firewatch-v1-vuelo/model-data/sector-fixture.json
    python design/firewatch-v1-vuelo/model-data/generate.py --emit manifest \
        > design/firewatch-v1-vuelo/model-data/manifest.json

The manifest carries the sha256 of the other two artifacts, so it is emitted
last. `--check` regenerates all three in memory.

Every number below is invented. None of it measures, predicts or evaluates
anything, and none of it should be read as the current state of production.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import sys
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent

DATASET_ID = "firewatch-synthetic-handoff-v1"
PROVENANCE = "synthetic"
TIME_ZONE = "America/Santiago"

#: The panel's key, label and provenance columns, in output order. Mirrors
#: `backend/training/assemble.py` character for character: a reader that opened
#: this file expecting the assembler's own output must not have to guess which
#: column moved.
PANEL_COLUMNS = (
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
)

#: The seven feature names in the artifact's declared order. `logistic.json` is
#: the descriptor the running system references; the tests compare both the
#: names and the units against that file, so a change there fails here loudly.
FEATURES = (
    "temp_max",
    "temp_min",
    "humidity_rel",
    "wind_speed",
    "wind_dir",
    "precip_sum",
    "radiation_sol",
)

FEATURE_UNITS = {
    "temp_max": "degC",
    "temp_min": "degC",
    "humidity_rel": "%",
    "wind_speed": "m/s",
    "wind_dir": "deg",
    "precip_sum": "mm",
    "radiation_sol": "W/m2",
}

TERRAIN_FIELDS = ("elevation_m", "slope_deg", "land_cover")

#: `precip_sum` is an accumulation over seven civil days ending on and
#: including the reference date. Six days is a different quantity, not a
#: smaller sum, so any other window is refused instead of computed.
PRECIPITATION_WINDOW_DAYS = 7


# ---------------------------------------------------------------------------
# Calendar
# ---------------------------------------------------------------------------

#: The modelled series starts six days before the first exported day, so the
#: first exported comuna-day already has a complete seven-day precipitation
#: window. Those warm-up days are never written to the panel.
SERIES_START = dt.date(2026, 11, 3)
PANEL_START = dt.date(2026, 11, 9)
PANEL_END = dt.date(2026, 11, 20)

PANEL_DATES = tuple(
    PANEL_START + dt.timedelta(days=offset)
    for offset in range((PANEL_END - PANEL_START).days + 1)
)


# ---------------------------------------------------------------------------
# The fictitious comunas
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Comuna:
    """One comuna, its tracked identifiers and its offset from the regional day.

    Names, CUTs and provinces are the tracked ones from
    `backend/training/data/comunas-valparaiso-centroids.json`; the CUT stays a
    string so its leading zero survives. The offsets are invented: they make
    the three places differ the way a coast and an inland valley differ, which
    is the only property the fixture needs.
    """

    cut: str
    name: str
    provincia: str
    region: str
    temp_max: float
    temp_min: float
    humidity: float
    wind_kmh: float
    wind_dir: float
    radiation: float


#: Insertion order is the panel's row order (`cut` ascending), which is also the
#: order of the sector fixture's communes.
COMUNAS: dict[str, Comuna] = {
    "05101": Comuna(
        cut="05101",
        name="Valparaíso",
        provincia="Valparaíso",
        region="Valparaiso",
        temp_max=-1.5,
        temp_min=0.5,
        humidity=6.0,
        wind_kmh=4.0,
        wind_dir=0.0,
        radiation=-15.0,
    ),
    "05109": Comuna(
        cut="05109",
        name="Viña del Mar",
        provincia="Valparaíso",
        region="Valparaiso",
        temp_max=-1.0,
        temp_min=1.0,
        humidity=4.0,
        wind_kmh=2.0,
        wind_dir=5.0,
        radiation=-10.0,
    ),
    "05801": Comuna(
        cut="05801",
        name="Quilpué",
        provincia="Marga Marga",
        region="Valparaiso",
        temp_max=2.0,
        temp_min=-1.0,
        humidity=-5.0,
        wind_kmh=-3.0,
        wind_dir=-5.0,
        radiation=10.0,
    ),
}


@dataclass(frozen=True)
class Day:
    """The regional day: one row of invented synoptic weather for the area.

    The source publishes one value per variable per day, already aggregated --
    the same arrangement `backend/training/meteo.py` documents for Open-Meteo,
    where the parameter itself is the day's mean. Nothing here simulates hourly
    readings, so no hourly precision is claimed.
    """

    temp_max: float
    temp_min: float
    humidity: float
    wind_kmh: float
    wind_dir: float
    radiation: float


#: Eighteen invented days: a dry warming spell, two overcast coastal days, a
#: hot easterly day, a frontal rain day and a hot dry close. The rain day is
#: visibly coupled -- lower maxima, higher humidity, weaker irradiance, stronger
#: north-westerly wind -- because uncoupled inputs would make the fixture a
#: random-number table rather than a plausible one.
DAILY: dict[dt.date, Day] = {
    dt.date(2026, 11, 3): Day(19.0, 10.0, 70.0, 14.0, 215.0, 255.0),
    dt.date(2026, 11, 4): Day(20.0, 10.0, 68.0, 15.0, 220.0, 270.0),
    dt.date(2026, 11, 5): Day(21.0, 11.0, 66.0, 16.0, 225.0, 285.0),
    dt.date(2026, 11, 6): Day(22.0, 11.0, 64.0, 17.0, 225.0, 295.0),
    dt.date(2026, 11, 7): Day(23.0, 12.0, 62.0, 18.0, 230.0, 305.0),
    dt.date(2026, 11, 8): Day(24.0, 12.0, 60.0, 19.0, 230.0, 315.0),
    dt.date(2026, 11, 9): Day(25.0, 13.0, 58.0, 20.0, 235.0, 325.0),
    dt.date(2026, 11, 10): Day(23.0, 13.0, 72.0, 16.0, 215.0, 250.0),
    dt.date(2026, 11, 11): Day(21.0, 12.0, 80.0, 14.0, 205.0, 215.0),
    dt.date(2026, 11, 12): Day(21.0, 12.0, 84.0, 13.0, 200.0, 195.0),
    dt.date(2026, 11, 13): Day(31.0, 14.0, 42.0, 27.0, 110.0, 385.0),
    dt.date(2026, 11, 14): Day(27.0, 12.0, 50.0, 23.0, 140.0, 360.0),
    dt.date(2026, 11, 15): Day(20.0, 10.0, 88.0, 30.0, 315.0, 145.0),
    dt.date(2026, 11, 16): Day(22.0, 8.0, 74.0, 18.0, 260.0, 300.0),
    dt.date(2026, 11, 17): Day(26.0, 11.0, 60.0, 24.0, 190.0, 350.0),
    dt.date(2026, 11, 18): Day(30.0, 14.0, 46.0, 28.0, 120.0, 380.0),
    dt.date(2026, 11, 19): Day(32.0, 15.0, 40.0, 25.0, 100.0, 390.0),
    dt.date(2026, 11, 20): Day(33.0, 16.0, 36.0, 23.0, 95.0, 395.0),
}

#: Daily precipitation in millimetres. A comuna-day absent from this table and
#: not in `MISSING_PRECIP` is a measured 0.0: seven dry days are a fact.
DAILY_PRECIP: dict[str, dict[dt.date, float]] = {
    "05101": {dt.date(2026, 11, 15): 3.6},
    "05109": {},
    "05801": {dt.date(2026, 11, 15): 11.8},
}

#: Days whose precipitation reading the source did not deliver. A day here makes
#: every seven-day window that contains it incomplete, and an incomplete window
#: is written as empty rather than as a smaller sum.
MISSING_PRECIP: frozenset[tuple[str, dt.date]] = frozenset({("05101", dt.date(2026, 11, 17))})


# ---------------------------------------------------------------------------
# Gaps and label
# ---------------------------------------------------------------------------

#: Every explicitly empty feature cell, with the instrumentation fact that
#: explains it. These are sensor outages, an undefined direction on a calm day
#: and the knock-on of a missing precipitation reading. None of them is caused
#: by a fire or by the absence of one, and the tests pin that: each feature that
#: is ever missing is missing on event days and on quiet days both, one event
#: row is complete, and several quiet rows are not.
MISSING_CELLS: dict[tuple[str, dt.date], dict[str, str]] = {
    ("05101", dt.date(2026, 11, 16)): {
        "radiation_sol": "piranómetro sin registro durante el día",
    },
    ("05101", dt.date(2026, 11, 18)): {
        "wind_speed": "anemómetro fuera de servicio",
        "wind_dir": "anemómetro fuera de servicio",
    },
    ("05101", dt.date(2026, 11, 19)): {
        "humidity_rel": "sensor de humedad sin lectura",
    },
    ("05109", dt.date(2026, 11, 14)): {
        "humidity_rel": "sensor de humedad sin lectura",
    },
    ("05109", dt.date(2026, 11, 16)): {
        "wind_dir": "calma medida: la velocidad es 0 y la dirección no está definida, no es 0°",
    },
    ("05109", dt.date(2026, 11, 20)): {
        "humidity_rel": "estación costera sin registro de humedad",
        "radiation_sol": "estación costera sin registro de radiación",
    },
    ("05801", dt.date(2026, 11, 11)): {
        "wind_speed": "anemómetro sin lectura",
        "wind_dir": "anemómetro sin lectura",
    },
    ("05801", dt.date(2026, 11, 12)): {
        "temp_max": "estación sin registro de temperatura",
        "temp_min": "estación sin registro de temperatura",
    },
    ("05801", dt.date(2026, 11, 17)): {
        "temp_max": "estación sin registro de temperatura",
        "temp_min": "estación sin registro de temperatura",
    },
}

#: A measured full-day calm: the speed is a real 0.0 and the direction is not
#: 0° (north) but undefined, which is why the direction cell is empty above.
CALM_DAYS: frozenset[tuple[str, dt.date]] = frozenset({("05109", dt.date(2026, 11, 16))})

#: The fictitious events, as the burned area of each event in hectares. A day
#: appears once per comuna with all of its events; `None` marks an unreadable
#: area, which makes the day's total unknown rather than zero. Four event days
#: out of thirty-six: the label is a target, never an input.
EVENTS: dict[tuple[str, dt.date], tuple[float | None, ...]] = {
    ("05101", dt.date(2026, 11, 13)): (2.4,),
    ("05101", dt.date(2026, 11, 18)): (42.5, None),
    ("05801", dt.date(2026, 11, 17)): (78.25, 50.5),
    ("05109", dt.date(2026, 11, 20)): (6.4,),
}


# ---------------------------------------------------------------------------
# Derivation
# ---------------------------------------------------------------------------


def daily_precipitation(cut: str, day: dt.date) -> float | None:
    """Return the source's precipitation total for one comuna-day, in mm.

    `None` means the source delivered no reading. An out-of-series date is also
    `None`: this module does not extrapolate a value it never modelled.
    """
    if cut not in COMUNAS or day < SERIES_START or day > PANEL_END:
        return None
    if (cut, day) in MISSING_PRECIP:
        return None
    return DAILY_PRECIP[cut].get(day, 0.0)


def precipitation_window(
    reference: dt.date,
    days: int = PRECIPITATION_WINDOW_DAYS,
) -> tuple[dt.date, ...]:
    """Return the civil days a `precip_sum` at `reference` accumulates."""
    if days != PRECIPITATION_WINDOW_DAYS:
        raise ValueError(
            f"precip_sum is a {PRECIPITATION_WINDOW_DAYS}-civil-day accumulation in mm; "
            f"{days} days is a different quantity and is refused instead of computed"
        )
    return tuple(reference - dt.timedelta(days=offset) for offset in range(days - 1, -1, -1))


def seven_day_precipitation(
    cut: str,
    reference: dt.date,
    days: int = PRECIPITATION_WINDOW_DAYS,
) -> float | None:
    """Accumulate seven civil days ending on and including `reference`, in mm.

    A window with any day unread is `None`, never a smaller sum: the missing day
    could be the one that carried the rain.
    """
    values = [daily_precipitation(cut, day) for day in precipitation_window(reference, days)]
    if any(value is None for value in values):
        return None
    return round(sum(value for value in values if value is not None), 2)


def comuna_day_values(cut: str, day: dt.date) -> dict[str, float | None]:
    """Return the seven feature cells for one comuna-day, in artifact order."""
    comuna = COMUNAS[cut]
    anchor = DAILY[day]
    values: dict[str, float | None] = {
        "temp_max": round(anchor.temp_max + comuna.temp_max, 1),
        "temp_min": round(anchor.temp_min + comuna.temp_min, 1),
        "humidity_rel": round(min(100.0, max(0.0, anchor.humidity + comuna.humidity)), 1),
        "wind_speed": round((anchor.wind_kmh + comuna.wind_kmh) / 3.6, 2),
        "wind_dir": round((anchor.wind_dir + comuna.wind_dir) % 360.0, 1),
        "precip_sum": seven_day_precipitation(cut, day),
        "radiation_sol": round(anchor.radiation + comuna.radiation, 1),
    }
    if (cut, day) in CALM_DAYS:
        values["wind_speed"] = 0.0
    for feature in MISSING_CELLS.get((cut, day), {}):
        values[feature] = None
    return values


def missing_reason(cut: str, day: dt.date, feature: str) -> str:
    """Explain one empty feature cell in one sentence."""
    explicit = MISSING_CELLS.get((cut, day), {}).get(feature)
    if explicit is not None:
        return explicit
    if feature == "precip_sum":
        unread = [
            moment.isoformat()
            for moment in precipitation_window(day)
            if daily_precipitation(cut, moment) is None
        ]
        return (
            "ventana de siete días incompleta: falta la lectura diaria de "
            f"{' y '.join(unread)}; se declara nula en vez de una suma menor"
        )
    raise KeyError(f"no documented reason for the empty cell {cut} {day} {feature}")


def format_number(value: float | None) -> str:
    """Render one cell: empty when absent, never a zero in its place.

    The six-decimal, trailing-zero-stripped form is `assemble.py`'s own, so the
    panel's bytes look like the assembler's bytes.
    """
    if value is None:
        return ""
    text = f"{value:.6f}".rstrip("0").rstrip(".")
    return text if text not in ("", "-0") else "0"


@dataclass(frozen=True)
class PanelLine:
    """One comuna-day: the key, the label and the seven feature cells."""

    cut: str
    comuna: str
    comuna_unresolved: str
    provincia: str
    region: str
    local_date: dt.date
    fire_today: int
    fire_count: int
    burned_ha: float | None
    meteorology_readings: int
    features: dict[str, float | None]


def panel_rows() -> list[PanelLine]:
    """Return every comuna-day of the panel, ordered by (cut, local_date)."""
    lines: list[PanelLine] = []
    for cut, comuna in COMUNAS.items():
        for day in PANEL_DATES:
            values = comuna_day_values(cut, day)
            areas = EVENTS.get((cut, day), ())
            if not areas:
                burned: float | None = 0.0
            elif any(area is None for area in areas):
                burned = None
            else:
                burned = round(sum(area for area in areas if area is not None), 2)
            lines.append(
                PanelLine(
                    cut=cut,
                    comuna=comuna.name,
                    comuna_unresolved="",
                    provincia=comuna.provincia,
                    region=comuna.region,
                    local_date=day,
                    fire_today=1 if areas else 0,
                    fire_count=len(areas),
                    burned_ha=burned,
                    # Zero, with the assembler's own meaning: the column counts
                    # meteorological readings attached to the comuna-day's
                    # events, and this fixture carries no event-attached station
                    # readings. The seven independent weather cells above are a
                    # different thing; their coverage lives in the manifest, so
                    # reusing this column for it would put a second definition
                    # under a name a consumer already knows.
                    meteorology_readings=0,
                    features=values,
                )
            )
    return lines


def panel_csv() -> str:
    """Render the panel exactly as a CSV file, newline-terminated with LF."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow([*PANEL_COLUMNS, *FEATURES])
    for line in panel_rows():
        writer.writerow(
            [
                line.cut,
                line.comuna,
                line.comuna_unresolved,
                line.provincia,
                line.region,
                line.local_date.isoformat(),
                line.fire_today,
                line.fire_count,
                format_number(line.burned_ha),
                line.meteorology_readings,
                *(format_number(line.features[feature]) for feature in FEATURES),
            ]
        )
    return buffer.getvalue()


# ---------------------------------------------------------------------------
# The sector fixture (design artifact, not a spatial conversion of the panel)
# ---------------------------------------------------------------------------


def sector_weather(cut: str) -> dict[str, float | None]:
    """Return one comuna's last panel day as the sector fixture's weather block.

    Reusing the panel's row keeps the prototype and the data from drifting
    apart. The blocks are otherwise a sector reading: three sectors, one date,
    no spatial conversion of anything.
    """
    values = comuna_day_values(cut, PANEL_END)
    return {feature: values[feature] for feature in FEATURES}


@dataclass(frozen=True)
class Sector:
    """One sector of the design fixture: weather, terrain and the comunas it spans."""

    sector_id: str
    name: str
    communes: tuple[str, ...]
    local_date: str
    weather: dict[str, float | None]
    terrain: dict[str, float | str | None]

    def as_json(self) -> dict[str, object]:
        return {
            "sector_id": self.sector_id,
            "name": self.name,
            "communes": list(self.communes),
            "local_date": self.local_date,
            "weather": {feature: self.weather[feature] for feature in FEATURES},
            "terrain": {field: self.terrain[field] for field in TERRAIN_FIELDS},
        }


#: The three sectors in the approved map order. The first is a full reading, the
#: second is partial with a measured 0 mm, the third has no reading at all.
SECTORS: tuple[Sector, ...] = (
    Sector(
        sector_id="quebrada-este",
        name="Quebrada del Este",
        communes=(
            COMUNAS["05101"].name,
            COMUNAS["05109"].name,
            COMUNAS["05801"].name,
        ),
        local_date=PANEL_END.isoformat(),
        weather=sector_weather("05801"),
        terrain={
            "elevation_m": 340.0,
            "slope_deg": 21.5,
            "land_cover": "Matorral esclerófilo",
        },
    ),
    Sector(
        sector_id="borde-costero",
        name="Borde costero",
        communes=(COMUNAS["05109"].name,),
        local_date=PANEL_END.isoformat(),
        weather=sector_weather("05109"),
        terrain={
            "elevation_m": 45.0,
            "slope_deg": 6.0,
            "land_cover": "Urbano y borde costero",
        },
    ),
    Sector(
        sector_id="interior-sin-lectura",
        name="Interior sin lectura",
        communes=(COMUNAS["05801"].name,),
        local_date=PANEL_END.isoformat(),
        weather=dict.fromkeys(FEATURES),
        terrain=dict.fromkeys(TERRAIN_FIELDS),
    ),
)


def sector_fixture() -> dict[str, object]:
    """Return the three-sector fixture in the approved map order."""
    return {
        "dataset_id": DATASET_ID,
        "provenance": PROVENANCE,
        "time_zone": TIME_ZONE,
        "sectors": [sector.as_json() for sector in SECTORS],
    }


def sector_fixture_json() -> str:
    return json.dumps(sector_fixture(), ensure_ascii=False, indent=2) + "\n"


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------

#: What each feature means on the training side and on the serving side. The two
#: are not the same estimator today, and same name plus same unit does not make
#: them the same number; the panel is not a drop-in replacement for the serving
#: vector. Sources: `assemble.py` (panel), `features.go` (windows) and
#: `classify/inference.go` (units and notes).
FEATURE_NOTES = (
    {
        "name": "temp_max",
        "unit": "degC",
        "source_unit": "degC",
        "training_aggregation": "máximo de las lecturas de la temperatura del día civil completo",
        "serving_aggregation": "máximo de las lecturas almacenadas del día civil en curso al publicar",
        "serving_window_days": 1,
    },
    {
        "name": "temp_min",
        "unit": "degC",
        "source_unit": "degC",
        "training_aggregation": "mínimo de las lecturas de la temperatura del día civil completo",
        "serving_aggregation": "mínimo de las lecturas almacenadas del día civil en curso al publicar",
        "serving_window_days": 1,
    },
    {
        "name": "humidity_rel",
        "unit": "%",
        "source_unit": "%",
        "training_aggregation": "media de las lecturas de humedad relativa del día civil",
        "serving_aggregation": "última lectura instantánea del día civil en curso",
        "serving_window_days": 1,
    },
    {
        "name": "wind_speed",
        "unit": "m/s",
        "source_unit": "km/h",
        "conversion": "÷ 3.6, la misma que aplica el clasificador al pasar km/h a m/s",
        "training_aggregation": "media de las lecturas diarias del viento, convertida a m/s",
        "serving_aggregation": "última lectura instantánea, convertida de km/h a m/s",
        "serving_window_days": 1,
    },
    {
        "name": "wind_dir",
        "unit": "deg",
        "source_unit": "deg",
        "training_aggregation": "dirección dominante del día civil, en grados desde donde sopla",
        "serving_aggregation": "última lectura instantánea, en grados desde donde sopla",
        "serving_window_days": 1,
    },
    {
        "name": "precip_sum",
        "unit": "mm",
        "source_unit": "mm",
        "training_aggregation": "suma de los siete días civiles que terminan en la fecha de referencia, incluida",
        "serving_aggregation": "suma de los últimos siete días locales del historial, incluido el día en curso",
        "serving_window_days": 7,
    },
    {
        "name": "radiation_sol",
        "unit": "W/m2",
        "source_unit": "W/m2",
        "training_aggregation": "media diaria de irradiancia en W/m2; no es una integral diaria",
        "serving_aggregation": "última lectura instantánea en W/m2; no se convierte a integral diaria",
        "serving_window_days": 1,
    },
)


def reading_coverage() -> dict[str, dict[str, int]]:
    """Count present and empty cells per feature, split by label state."""
    coverage: dict[str, dict[str, int]] = {}
    lines = panel_rows()
    for feature in FEATURES:
        missing_event = 0
        missing_quiet = 0
        present = 0
        for line in lines:
            if line.features[feature] is None:
                if line.fire_today == 1:
                    missing_event += 1
                else:
                    missing_quiet += 1
            else:
                present += 1
        coverage[feature] = {
            "present": present,
            "missing": missing_event + missing_quiet,
            "missing_on_event_rows": missing_event,
            "missing_on_quiet_rows": missing_quiet,
        }
    return coverage


def manifest() -> dict[str, object]:
    """Return the sidecar metadata: what is here, and what is still missing."""
    lines = panel_rows()
    panel_text = panel_csv()
    sectors_text = sector_fixture_json()
    fire_rows = sum(1 for line in lines if line.fire_today == 1)
    gaps = [
        {
            "cut": line.cut,
            "comuna": line.comuna,
            "local_date": line.local_date.isoformat(),
            "feature": feature,
            "reason": missing_reason(line.cut, line.local_date, feature),
        }
        for line in lines
        for feature in FEATURES
        if line.features[feature] is None
    ]
    return {
        "format": "firewatch-model-data-handoff/v1",
        "dataset_id": DATASET_ID,
        "provenance": PROVENANCE,
        "time_zone": TIME_ZONE,
        "generator": "design/firewatch-v1-vuelo/model-data/generate.py",
        "commands": {
            "panel": f"python {_generator()} --emit panel > {_relative('panel-synthetic.csv')}",
            "sectors": f"python {_generator()} --emit sectors > {_relative('sector-fixture.json')}",
            "manifest": f"python {_generator()} --emit manifest > {_relative('manifest.json')}",
            "verify": f"python {_generator()} --check",
        },
        "panel": {
            "file": "panel-synthetic.csv",
            "bytes": len(panel_text.encode("utf-8")),
            "sha256": hashlib.sha256(panel_text.encode("utf-8")).hexdigest(),
            "rows": len(lines),
            "columns": [*PANEL_COLUMNS, *FEATURES],
            "key": ["cut", "local_date"],
            "comunas": [
                {
                    "cut": comuna.cut,
                    "comuna": comuna.name,
                    "provincia": comuna.provincia,
                    "region": comuna.region,
                }
                for comuna in COMUNAS.values()
            ],
            "local_dates": {
                "first": PANEL_START.isoformat(),
                "last": PANEL_END.isoformat(),
                "days": len(PANEL_DATES),
            },
            "labels": {"fire_rows": fire_rows, "quiet_rows": len(lines) - fire_rows},
            "reading_coverage": reading_coverage(),
            "missing_cells": gaps,
            # The column keeps `assemble.py`'s meaning and is zero everywhere:
            # this fixture has no event-attached station readings. The coverage of
            # the independent weather cells is the block above.
            "meteorology_readings": {
                "value": 0,
                "code": "no_event_attached_readings",
            },
        },
        "features": list(FEATURE_NOTES),
        "sector_fixture": {
            "file": "sector-fixture.json",
            "bytes": len(sectors_text.encode("utf-8")),
            "sha256": hashlib.sha256(sectors_text.encode("utf-8")).hexdigest(),
            "sectors": [
                {
                    "sector_id": sector.sector_id,
                    "name": sector.name,
                    "local_date": sector.local_date,
                    "weather_fields_present": sum(
                        1 for feature in FEATURES if sector.weather[feature] is not None
                    ),
                    "missing_weather_fields": [
                        feature for feature in FEATURES if sector.weather[feature] is None
                    ],
                    "terrain_present": all(
                        value is not None for value in sector.terrain.values()
                    ),
                }
                for sector in SECTORS
            ],
        },
        "contract_sources": {
            "panel_columns": "backend/training/assemble.py PANEL_COLUMNS",
            "feature_order_and_units": "backend/services/inference/testdata/logistic.json",
            "serving_window_and_coverage": "backend/services/risk/internal/features/features.go",
            "serving_units_and_conversions": "backend/services/risk/internal/classify/inference.go",
            "tracked_comuna_cut": "backend/training/data/comunas-valparaiso-centroids.json",
        },
        "excluded_from_features": ["fire_today", "fire_count", "burned_ha"],
        "label_blockers": [
            {
                "source": "DOI 10.71578/UXAUN5 (Dataverse, producto CONAF 2010-2025)",
                "identifier": "10.71578/UXAUN5",
                "access_state": "access_request_required",
                "evidence": "odd/tasks/plan-produccion/aws-ml-delivery.md L5",
            },
            {
                "source": "Geoportal CONAF 2010-2025",
                "identifier": "01d06ae3-122e-41fc-9512-1dd2b5067112",
                "access_state": "metadata_without_distribution",
                "evidence": "odd/tasks/plan-produccion/aws-ml-delivery.md L5",
            },
            {
                "source": "muestra abierta del repositorio FONDEF (una temporada de una región)",
                "identifier": "maule-2018-2019",
                "access_state": "partial_open_sample",
                "evidence": "backend/training/README.md",
            },
        ],
        "limits": [
            "no llama a proveedores, no lee credenciales y no toca frontend/ ni backend/",
            "no se ejecutó el modelo; no hay inferencia, ni activación, ni despliegue",
        ],
    }


def _generator() -> str:
    return "design/firewatch-v1-vuelo/model-data/generate.py"


def _relative(name: str) -> str:
    return f"design/firewatch-v1-vuelo/model-data/{name}"


def manifest_json() -> str:
    return json.dumps(manifest(), ensure_ascii=False, indent=2) + "\n"


# ---------------------------------------------------------------------------
# CLI: stdout or nothing
# ---------------------------------------------------------------------------

EMITTERS = {
    "panel": panel_csv,
    "sectors": sector_fixture_json,
    "manifest": manifest_json,
}

OUTPUTS = {
    "panel": "panel-synthetic.csv",
    "sectors": "sector-fixture.json",
    "manifest": "manifest.json",
}


def _emit_stdout(text: str) -> None:
    """Write one artifact to stdout as UTF-8 bytes.

    Bytes, not text: the console's locale must not decide whether an accented
    name is written as UTF-8 or as a code page that is not UTF-8 at all.
    """
    sys.stdout.buffer.write(text.encode("utf-8"))
    sys.stdout.buffer.flush()


def _check() -> int:
    """Compare the committed files with the generated bytes. Read-only."""
    failures = 0
    for kind, filename in OUTPUTS.items():
        path = HERE / filename
        expected = EMITTERS[kind]().encode("utf-8")
        if not path.is_file():
            print(f"DRIFT: {filename} is missing; emit it with --emit {kind}")
            failures += 1
            continue
        actual = path.read_bytes()
        if actual != expected:
            print(f"DRIFT: {filename} does not match the generator ({len(actual)} bytes on disk)")
            failures += 1
            continue
        print(f"OK: {filename} ({len(actual)} bytes, sha256 {hashlib.sha256(actual).hexdigest()[:12]})")
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Emite el paquete de datos sintético del modelo (panel comuna-día y fixture "
            "sectorial). Solo escribe en stdout; --check es de solo lectura."
        )
    )
    parser.add_argument(
        "--emit",
        choices=sorted(EMITTERS),
        help="write one artifact to stdout as UTF-8 (panel, sectors or manifest)",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="compare the committed artifacts with the generated bytes and exit non-zero on drift",
    )
    arguments = parser.parse_args(argv)

    if arguments.check:
        return _check()
    if arguments.emit:
        _emit_stdout(EMITTERS[arguments.emit]())
        return 0
    parser.print_usage(sys.stderr)
    print("error: use --emit {panel,sectors,manifest} or --check", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
