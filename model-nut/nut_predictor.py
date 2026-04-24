#!/usr/bin/env python3
"""
Predict probable NUT appointment dates from historical assignment listings.

Usage:
  python3 nut_predictor.py --nut 7395000
  python3 nut_predictor.py --nut 7395000 --html /path/to/nut_page.html
  python3 nut_predictor.py --export-csv assignments.csv --show-stats
"""

from __future__ import annotations

import argparse
import csv
import math
import re
import statistics
from bisect import bisect_left
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from html import unescape
from pathlib import Path
from typing import Iterable, List, Sequence, Tuple


DATE_PATTERN = re.compile(r"\b(\d{2}/\d{2}/\d{4})\b")
NUT_PATTERN = re.compile(r"\b\d{7}\b")
TABLE_PATTERN = re.compile(r"<table\b.*?</table>", flags=re.IGNORECASE | re.DOTALL)
ROW_PATTERN = re.compile(r"<tr\b.*?</tr>", flags=re.IGNORECASE | re.DOTALL)
CELL_PATTERN = re.compile(r"<t[dh]\b[^>]*>(.*?)</t[dh]>", flags=re.IGNORECASE | re.DOTALL)
TAG_PATTERN = re.compile(r"<[^>]+>")


@dataclass(frozen=True)
class AssignmentRecord:
    nut: int
    appointment_date: date


@dataclass
class NutProjectionModel:
    min_date: date
    max_date: date
    xs: List[int]
    ys: List[float]
    slope_days_per_nut: float
    intercept_days: float
    residuals: List[float]
    recent_slope_days_per_nut: float
    k_neighbors: int
    mae_backtest_days: float
    p80_abs_error_days: float
    p95_abs_error_days: float

    @classmethod
    def fit(
        cls,
        records: Sequence[AssignmentRecord],
        calibrate_uncertainty: bool = True,
    ) -> "NutProjectionModel":
        if len(records) < 20:
            raise ValueError("No hay suficientes registros para entrenar el modelo.")

        ordered_by_nut = sorted(records, key=lambda r: r.nut)
        min_date = min(r.appointment_date for r in ordered_by_nut)
        max_date = max(r.appointment_date for r in ordered_by_nut)

        xs = [r.nut for r in ordered_by_nut]
        ys = [business_days_between(min_date, r.appointment_date) for r in ordered_by_nut]

        slope = theil_sen_slope(xs, ys)
        intercept = statistics.median(y - slope * x for x, y in zip(xs, ys))
        residuals = [y - (intercept + slope * x) for x, y in zip(xs, ys)]

        recent_slope = compute_recent_slope(records)
        k_neighbors = max(31, min(121, len(xs) // 8))

        if calibrate_uncertainty:
            mae_bt, p80_bt, p95_bt = rolling_backtest_errors(records, min_date)
        else:
            mae_bt, p80_bt, p95_bt = 0.0, 3.0, 10.0

        return cls(
            min_date=min_date,
            max_date=max_date,
            xs=xs,
            ys=ys,
            slope_days_per_nut=slope,
            intercept_days=intercept,
            residuals=residuals,
            recent_slope_days_per_nut=recent_slope,
            k_neighbors=k_neighbors,
            mae_backtest_days=mae_bt,
            p80_abs_error_days=p80_bt,
            p95_abs_error_days=p95_bt,
        )

    def predict_day_index(self, nut: int) -> float:
        x_min = self.xs[0]
        x_max = self.xs[-1]

        if nut > x_max:
            edge_day = self._predict_with_local(x_max)
            delta_nut = nut - x_max
            # Blend long-term and recent velocity for better forward projection.
            blended_slope = 0.35 * self.slope_days_per_nut + 0.65 * self.recent_slope_days_per_nut
            return edge_day + delta_nut * blended_slope

        if nut < x_min:
            edge_day = self._predict_with_local(x_min)
            delta_nut = nut - x_min
            return edge_day + delta_nut * self.slope_days_per_nut

        return self._predict_with_local(nut)

    def predict_date(self, nut: int) -> date:
        predicted_day = self.predict_day_index(nut)
        return add_business_days(self.min_date, max(0, int(round(predicted_day))))

    def prediction_window(self, nut: int, level: float = 0.8) -> Tuple[date, date]:
        center = self.predict_day_index(nut)
        spread = self.p80_abs_error_days if level <= 0.8 else self.p95_abs_error_days

        low_day = max(0, int(math.floor(center - spread)))
        high_day = max(0, int(math.ceil(center + spread)))

        low = add_business_days(self.min_date, low_day)
        high = add_business_days(self.min_date, high_day)
        return low, high

    def _predict_with_local(self, nut: int) -> float:
        base = self.intercept_days + self.slope_days_per_nut * nut
        local = self._local_residual(nut)
        return base + local

    def _local_residual(self, nut: int) -> float:
        indices = neighbor_window(self.xs, nut, self.k_neighbors)
        if not indices:
            return 0.0

        distances = [abs(self.xs[i] - nut) for i in indices]
        median_distance = quantile(distances, 0.5)
        bandwidth = max(1.0, median_distance)

        weights = [math.exp(-0.5 * (d / bandwidth) ** 2) for d in distances]
        weighted_sum = sum(w * self.residuals[i] for w, i in zip(weights, indices))
        total_weight = sum(weights)
        if total_weight == 0:
            return 0.0
        return weighted_sum / total_weight


def clean_cell_text(fragment: str) -> str:
    no_tags = TAG_PATTERN.sub(" ", fragment)
    return " ".join(no_tags.replace("\xa0", " ").split())


def parse_assignment_records(html_text: str) -> List[AssignmentRecord]:
    text = unescape(html_text)
    text = re.sub(r"<script\b.*?</script>", "", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<style\b.*?</style>", "", text, flags=re.IGNORECASE | re.DOTALL)

    raw_records: List[AssignmentRecord] = []
    for table in TABLE_PATTERN.findall(text):
        if "Número Único de Trámite" not in table and "Numero Unico de Tramite" not in table:
            continue

        current_date: date | None = None
        for row in ROW_PATTERN.findall(table):
            cells = [clean_cell_text(c) for c in CELL_PATTERN.findall(row)]
            if not cells:
                continue

            joined = " | ".join(cells)
            found_date = DATE_PATTERN.search(joined)
            if found_date:
                current_date = datetime.strptime(found_date.group(1), "%d/%m/%Y").date()

            if current_date is None:
                continue

            for cell in cells:
                for nut_text in NUT_PATTERN.findall(cell):
                    raw_records.append(AssignmentRecord(nut=int(nut_text), appointment_date=current_date))

    # Keep earliest date per NUT in case the source eventually repeats IDs.
    earliest_by_nut: dict[int, date] = {}
    for record in raw_records:
        prev = earliest_by_nut.get(record.nut)
        if prev is None or record.appointment_date < prev:
            earliest_by_nut[record.nut] = record.appointment_date

    return sorted(
        [AssignmentRecord(nut=k, appointment_date=v) for k, v in earliest_by_nut.items()],
        key=lambda r: r.nut,
    )


def theil_sen_slope(xs: Sequence[int], ys: Sequence[float], max_pairs: int = 250_000) -> float:
    n = len(xs)
    if n < 2:
        return 1e-3

    total_pairs = n * (n - 1) // 2
    # Downsample pairs to stay fast while keeping robust median behavior.
    step = max(1, int(math.sqrt(total_pairs / max_pairs))) if total_pairs > max_pairs else 1

    slopes: List[float] = []
    for i in range(0, n - 1, step):
        xi = xs[i]
        yi = ys[i]
        for j in range(i + step, n, step):
            dx = xs[j] - xi
            if dx == 0:
                continue
            slopes.append((ys[j] - yi) / dx)

    if not slopes:
        for i in range(n - 1):
            dx = xs[i + 1] - xs[i]
            if dx > 0:
                slopes.append((ys[i + 1] - ys[i]) / dx)

    if not slopes:
        return 1e-3

    slope = statistics.median(slopes)
    if slope <= 0:
        slope = max(1e-6, statistics.mean(abs(s) for s in slopes))
    return slope


def compute_recent_slope(records: Sequence[AssignmentRecord]) -> float:
    by_date: dict[date, List[int]] = defaultdict(list)
    for record in records:
        by_date[record.appointment_date].append(record.nut)

    if len(by_date) < 5:
        return 1e-3

    frontier_points: List[Tuple[date, int]] = []
    running = 0
    for day in sorted(by_date):
        nuts = sorted(by_date[day])
        q90 = nuts[int(0.9 * (len(nuts) - 1))]
        running = max(running, q90)
        frontier_points.append((day, running))

    lookback = min(35, len(frontier_points) - 1)
    recent = frontier_points[-(lookback + 1) :]

    daily_slopes: List[float] = []
    for (d1, n1), (d2, n2) in zip(recent[:-1], recent[1:]):
        day_gap = business_days_between(d1, d2)
        nut_gap = n2 - n1
        if day_gap <= 0 or nut_gap <= 0:
            continue
        daily_slopes.append(day_gap / nut_gap)

    if not daily_slopes:
        return 1e-3

    return statistics.median(daily_slopes)


def rolling_backtest_errors(
    records: Sequence[AssignmentRecord],
    min_date_reference: date,
) -> Tuple[float, float, float]:
    unique_dates = sorted({r.appointment_date for r in records})
    if len(unique_dates) < 20:
        return 0.0, 3.0, 10.0

    checkpoints = [0.60, 0.70, 0.80, 0.90]
    abs_errors: List[float] = []

    for frac in checkpoints:
        idx = int((len(unique_dates) - 1) * frac)
        cutoff = unique_dates[idx]

        train = [r for r in records if r.appointment_date <= cutoff]
        test = [r for r in records if r.appointment_date > cutoff]
        if len(train) < 150 or len(test) < 25:
            continue

        model = NutProjectionModel.fit(train, calibrate_uncertainty=False)
        for rec in test:
            expected = business_days_between(min_date_reference, rec.appointment_date)
            predicted = model.predict_day_index(rec.nut)
            abs_errors.append(abs(expected - predicted))

    if not abs_errors:
        return 0.0, 3.0, 10.0

    mae = statistics.mean(abs_errors)
    p80 = quantile(abs_errors, 0.80)
    p95 = quantile(abs_errors, 0.95)
    return mae, max(1.0, p80), max(2.0, p95)


def neighbor_window(xs: Sequence[int], target: int, k: int) -> List[int]:
    if not xs:
        return []
    pos = bisect_left(xs, target)
    half = max(1, k // 2)
    left = max(0, pos - half)
    right = min(len(xs), left + k)
    left = max(0, right - k)
    return list(range(left, right))


def quantile(values: Iterable[float], q: float) -> float:
    values_sorted = sorted(values)
    if not values_sorted:
        return 0.0
    if q <= 0:
        return float(values_sorted[0])
    if q >= 1:
        return float(values_sorted[-1])

    pos = (len(values_sorted) - 1) * q
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return float(values_sorted[lo])

    frac = pos - lo
    return float(values_sorted[lo] * (1 - frac) + values_sorted[hi] * frac)


def move_to_next_weekday(value: date) -> date:
    while value.weekday() >= 5:
        value += timedelta(days=1)
    return value


def move_to_previous_weekday(value: date) -> date:
    while value.weekday() >= 5:
        value -= timedelta(days=1)
    return value


def add_business_days(value: date, business_days: int) -> date:
    remaining = int(business_days)
    if remaining == 0:
        return move_to_next_weekday(value)

    cursor = move_to_next_weekday(value) if remaining > 0 else move_to_previous_weekday(value)
    step = 1 if remaining > 0 else -1

    while remaining != 0:
        cursor += timedelta(days=step)
        if cursor.weekday() < 5:
            remaining -= step

    return cursor


def business_days_between(start: date, end: date) -> int:
    if start == end:
        return 0
    if start > end:
        return -business_days_between(end, start)

    delta_days = (end - start).days
    full_weeks = delta_days // 7
    remainder = delta_days % 7
    business_days = full_weeks * 5
    start_weekday = start.weekday()

    for offset in range(1, remainder + 1):
        weekday = (start_weekday + offset) % 7
        if weekday < 5:
            business_days += 1

    return business_days


def export_csv(records: Sequence[AssignmentRecord], out_path: Path) -> None:
    with out_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["nut", "appointment_date"])
        for rec in sorted(records, key=lambda r: (r.appointment_date, r.nut)):
            writer.writerow([rec.nut, rec.appointment_date.isoformat()])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Modelo de proyeccion de fecha para NUT.")
    parser.add_argument(
        "--html",
        default="nut_page.html",
        help="Archivo HTML descargado del aviso oficial.",
    )
    parser.add_argument(
        "--nut",
        type=int,
        help="Numero NUT para proyectar fecha probable de asignacion.",
    )
    parser.add_argument(
        "--export-csv",
        type=Path,
        help="Ruta de salida para exportar el historico parseado en CSV.",
    )
    parser.add_argument(
        "--show-stats",
        action="store_true",
        help="Muestra estadisticas del modelo aunque no se indique un NUT.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    html_path = Path(args.html)
    if not html_path.exists():
        raise SystemExit(f"No existe el archivo HTML: {html_path}")

    html = html_path.read_text(encoding="utf-8")
    records = parse_assignment_records(html)
    if not records:
        raise SystemExit("No se encontraron registros NUT en el HTML proporcionado.")

    if args.export_csv:
        export_csv(records, args.export_csv)

    model = NutProjectionModel.fit(records, calibrate_uncertainty=True)

    if args.show_stats or args.nut is None:
        print(f"Registros procesados: {len(records)}")
        print(f"Rango de fechas: {model.min_date.isoformat()} -> {model.max_date.isoformat()}")
        print(f"Rango de NUT: {model.xs[0]} -> {model.xs[-1]}")
        print(
            "Error de validacion (rolling backtest): "
            f"MAE={model.mae_backtest_days:.2f} dias, "
            f"P80={model.p80_abs_error_days:.2f}, "
            f"P95={model.p95_abs_error_days:.2f}"
        )
        print(
            "Velocidad estimada reciente: "
            f"{(1.0 / model.recent_slope_days_per_nut):.0f} NUT/dia habil (aprox.)"
        )

    if args.nut is not None:
        nut_value = args.nut
        prediction = model.predict_date(nut_value)
        low80, high80 = model.prediction_window(nut_value, level=0.8)
        low95, high95 = model.prediction_window(nut_value, level=0.95)

        print(f"\nNUT consultado: {nut_value}")
        if nut_value in set(model.xs):
            known_day_idx = model.xs.index(nut_value)
            known_date = add_business_days(model.min_date, int(round(model.ys[known_day_idx])))
            print(f"Este NUT ya aparece en el historico con fecha: {known_date.isoformat()}")
        else:
            print(f"Fecha probable de asignacion: {prediction.isoformat()}")
            print(f"Ventana probable 80%: {low80.isoformat()} -> {high80.isoformat()}")
            print(f"Ventana probable 95%: {low95.isoformat()} -> {high95.isoformat()}")


if __name__ == "__main__":
    main()
