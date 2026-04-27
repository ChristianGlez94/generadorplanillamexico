const fs = require("fs/promises");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ERROR_METRICS = {
  maeDays: 0,
  p80Days: 3,
  p95Days: 10,
};

function parseIsoDate(rawValue) {
  const clean = String(rawValue || "").trim();
  const match = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }

  const utc = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
  if (
    utc.getUTCFullYear() !== year
    || utc.getUTCMonth() !== month - 1
    || utc.getUTCDate() !== day
  ) {
    return null;
  }

  return utc;
}

function toIsoDate(value) {
  return value.toISOString().slice(0, 10);
}

function addDays(dateValue, days) {
  return new Date(dateValue.getTime() + Number(days) * DAY_MS);
}

function isWeekend(dateValue) {
  const dayOfWeek = dateValue.getUTCDay();
  return dayOfWeek === 0 || dayOfWeek === 6;
}

function moveToPreviousWeekday(value) {
  let cursor = value;

  while (isWeekend(cursor)) {
    cursor = addDays(cursor, -1);
  }

  return cursor;
}

function moveToNextWeekday(value) {
  let cursor = value;

  while (isWeekend(cursor)) {
    cursor = addDays(cursor, 1);
  }

  return cursor;
}

function addBusinessDays(dateValue, businessDays) {
  let remaining = Number.isFinite(businessDays) ? Math.trunc(businessDays) : 0;
  let cursor = new Date(dateValue.getTime());

  if (remaining === 0) {
    return moveToNextWeekday(cursor);
  }

  cursor = remaining > 0
    ? moveToNextWeekday(cursor)
    : moveToPreviousWeekday(cursor);

  const step = remaining > 0 ? 1 : -1;
  while (remaining !== 0) {
    cursor = addDays(cursor, step);
    if (!isWeekend(cursor)) {
      remaining -= step;
    }
  }

  return cursor;
}

function businessDaysBetween(startDate, endDate) {
  const startTime = startDate.getTime();
  const endTime = endDate.getTime();

  if (startTime === endTime) return 0;
  if (startTime > endTime) {
    return -businessDaysBetween(endDate, startDate);
  }

  const startDayNumber = Math.floor(startTime / DAY_MS);
  const endDayNumber = Math.floor(endTime / DAY_MS);
  const deltaDays = endDayNumber - startDayNumber;

  const fullWeeks = Math.floor(deltaDays / 7);
  const remainder = deltaDays % 7;
  const startDow = startDate.getUTCDay();

  let businessDays = fullWeeks * 5;
  for (let offset = 1; offset <= remainder; offset += 1) {
    const dayOfWeek = (startDow + offset) % 7;
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      businessDays += 1;
    }
  }

  return businessDays;
}

function quantile(values, q) {
  const sorted = [...values]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  if (!sorted.length) return 0;
  if (q <= 0) return sorted[0];
  if (q >= 1) return sorted[sorted.length - 1];

  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);

  if (low === high) return sorted[low];

  const fraction = position - low;
  return sorted[low] * (1 - fraction) + sorted[high] * fraction;
}

function median(values) {
  return quantile(values, 0.5);
}

function neighborWindow(xs, target, kNeighbors) {
  if (!Array.isArray(xs) || !xs.length) return [];

  let position = 0;
  while (position < xs.length && xs[position] < target) {
    position += 1;
  }

  const half = Math.max(1, Math.floor(kNeighbors / 2));
  let left = Math.max(0, position - half);
  let right = Math.min(xs.length, left + kNeighbors);
  left = Math.max(0, right - kNeighbors);

  const result = [];
  for (let i = left; i < right; i += 1) {
    result.push(i);
  }
  return result;
}

function theilSenSlope(xs, ys, maxPairs = 250_000) {
  const n = xs.length;
  if (n < 2) return 1e-3;

  const totalPairs = (n * (n - 1)) / 2;
  const step = totalPairs > maxPairs
    ? Math.max(1, Math.floor(Math.sqrt(totalPairs / maxPairs)))
    : 1;

  const slopes = [];

  for (let i = 0; i < n - 1; i += step) {
    const x1 = xs[i];
    const y1 = ys[i];
    for (let j = i + step; j < n; j += step) {
      const dx = xs[j] - x1;
      if (dx === 0) continue;
      slopes.push((ys[j] - y1) / dx);
    }
  }

  if (!slopes.length) {
    for (let i = 0; i < n - 1; i += 1) {
      const dx = xs[i + 1] - xs[i];
      if (dx > 0) {
        slopes.push((ys[i + 1] - ys[i]) / dx);
      }
    }
  }

  if (!slopes.length) return 1e-3;

  let slope = median(slopes);
  if (slope <= 0) {
    const absMean = slopes.reduce((acc, value) => acc + Math.abs(value), 0) / slopes.length;
    slope = Math.max(1e-6, absMean);
  }
  return slope;
}

function computeRecentSlope(records) {
  const groupedByDate = new Map();

  for (const record of records) {
    const key = toIsoDate(record.appointmentDate);
    if (!groupedByDate.has(key)) {
      groupedByDate.set(key, []);
    }
    groupedByDate.get(key).push(record.nut);
  }

  if (groupedByDate.size < 5) {
    return 1e-3;
  }

  const frontier = [];
  let runningMax = 0;

  const sortedDates = [...groupedByDate.keys()].sort();
  for (const dayKey of sortedDates) {
    const nuts = [...groupedByDate.get(dayKey)].sort((a, b) => a - b);
    const q90Index = Math.floor(0.9 * (nuts.length - 1));
    const q90Nut = nuts[Math.max(0, Math.min(q90Index, nuts.length - 1))];
    runningMax = Math.max(runningMax, q90Nut);
    frontier.push({
      date: parseIsoDate(dayKey),
      nut: runningMax,
    });
  }

  const lookback = Math.min(35, frontier.length - 1);
  const recent = frontier.slice(-(lookback + 1));
  const dailySlopes = [];

  for (let i = 0; i < recent.length - 1; i += 1) {
    const dayGap = businessDaysBetween(recent[i].date, recent[i + 1].date);
    const nutGap = recent[i + 1].nut - recent[i].nut;
    if (dayGap <= 0 || nutGap <= 0) continue;
    dailySlopes.push(dayGap / nutGap);
  }

  if (!dailySlopes.length) {
    return 1e-3;
  }

  return median(dailySlopes);
}

function buildModelCore(records, options = {}) {
  const calibrateUncertainty = options.calibrateUncertainty !== false;
  if (!Array.isArray(records) || records.length < 20) {
    throw new Error("No hay suficientes registros para entrenar el modelo NUT.");
  }

  const sortedByNut = [...records].sort((a, b) => a.nut - b.nut);
  const minDate = [...sortedByNut]
    .map((record) => record.appointmentDate)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  const maxDate = [...sortedByNut]
    .map((record) => record.appointmentDate)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  const xs = sortedByNut.map((record) => record.nut);
  const ys = sortedByNut.map((record) => businessDaysBetween(minDate, record.appointmentDate));
  const slope = theilSenSlope(xs, ys);
  const intercept = median(ys.map((day, index) => day - slope * xs[index]));
  const residuals = ys.map((day, index) => day - (intercept + slope * xs[index]));
  const recentSlope = computeRecentSlope(records);
  const kNeighbors = Math.max(31, Math.min(121, Math.floor(xs.length / 8)));

  let errorMetrics = DEFAULT_ERROR_METRICS;
  if (calibrateUncertainty) {
    errorMetrics = rollingBacktestErrors(records, minDate);
  }

  const model = {
    minDate,
    maxDate,
    xs,
    ys,
    maxObservedDayIndex: Math.max(...ys),
    slopeDaysPerNut: slope,
    interceptDays: intercept,
    residuals,
    recentSlopeDaysPerNut: recentSlope,
    kNeighbors,
    maeBacktestDays: errorMetrics.maeDays,
    p80AbsErrorDays: errorMetrics.p80Days,
    p95AbsErrorDays: errorMetrics.p95Days,
  };

  model.predictDayIndex = (nutValue) => predictDayIndex(model, nutValue);
  model.predictDate = (nutValue) => predictDate(model, nutValue);
  model.predictionWindow = (nutValue, level = 0.8) => predictionWindow(model, nutValue, level);
  return model;
}

function rollingBacktestErrors(records, minDateReference) {
  const uniqueDates = [...new Set(records.map((record) => toIsoDate(record.appointmentDate)))]
    .sort()
    .map((dayKey) => parseIsoDate(dayKey));

  if (uniqueDates.length < 20) {
    return DEFAULT_ERROR_METRICS;
  }

  const checkpoints = [0.6, 0.7, 0.8, 0.9];
  const absErrors = [];

  for (const fraction of checkpoints) {
    const cutoffIndex = Math.floor((uniqueDates.length - 1) * fraction);
    const cutoffDate = uniqueDates[cutoffIndex];
    const train = records.filter((record) => record.appointmentDate.getTime() <= cutoffDate.getTime());
    const test = records.filter((record) => record.appointmentDate.getTime() > cutoffDate.getTime());

    if (train.length < 150 || test.length < 25) continue;

    const model = buildModelCore(train, { calibrateUncertainty: false });
    for (const sample of test) {
      const expected = businessDaysBetween(minDateReference, sample.appointmentDate);
      const predicted = model.predictDayIndex(sample.nut);
      absErrors.push(Math.abs(expected - predicted));
    }
  }

  if (!absErrors.length) {
    return DEFAULT_ERROR_METRICS;
  }

  const maeDays = absErrors.reduce((acc, value) => acc + value, 0) / absErrors.length;
  const p80Days = Math.max(1, quantile(absErrors, 0.8));
  const p95Days = Math.max(2, quantile(absErrors, 0.95));

  return {
    maeDays,
    p80Days,
    p95Days,
  };
}

function localResidual(model, nutValue) {
  const indices = neighborWindow(model.xs, nutValue, model.kNeighbors);
  if (!indices.length) return 0;

  const distances = indices.map((index) => Math.abs(model.xs[index] - nutValue));
  const bandwidth = Math.max(1, median(distances));

  let weightedSum = 0;
  let totalWeight = 0;

  for (let i = 0; i < indices.length; i += 1) {
    const index = indices[i];
    const distance = distances[i];
    const weight = Math.exp(-0.5 * ((distance / bandwidth) ** 2));
    weightedSum += weight * model.residuals[index];
    totalWeight += weight;
  }

  if (totalWeight === 0) return 0;
  return weightedSum / totalWeight;
}

function predictWithLocal(model, nutValue) {
  const base = model.interceptDays + model.slopeDaysPerNut * nutValue;
  return base + localResidual(model, nutValue);
}

function predictDayIndex(model, nutValue) {
  const xMin = model.xs[0];
  const xMax = model.xs[model.xs.length - 1];
  const minForwardDay = model.maxObservedDayIndex + 1;

  if (nutValue > xMax) {
    const edgeDay = predictWithLocal(model, xMax);
    const deltaNut = nutValue - xMax;
    const blendedSlope = 0.35 * model.slopeDaysPerNut + 0.65 * model.recentSlopeDaysPerNut;
    // Un NUT mayor al maximo historico no puede proyectarse en una fecha ya asignada.
    return Math.max(edgeDay + deltaNut * blendedSlope, minForwardDay);
  }

  if (nutValue < xMin) {
    const edgeDay = predictWithLocal(model, xMin);
    const deltaNut = nutValue - xMin;
    return edgeDay + deltaNut * model.slopeDaysPerNut;
  }

  return predictWithLocal(model, nutValue);
}

function predictDate(model, nutValue) {
  const xMax = model.xs[model.xs.length - 1];
  const rawPrediction = predictDayIndex(model, nutValue);
  const predictedDay = nutValue > xMax
    ? Math.max(model.maxObservedDayIndex + 1, Math.ceil(rawPrediction))
    : Math.max(0, Math.round(rawPrediction));
  return addBusinessDays(model.minDate, predictedDay);
}

function predictionWindow(model, nutValue, level = 0.8) {
  const xMax = model.xs[model.xs.length - 1];
  const center = predictDayIndex(model, nutValue);
  const spread = level <= 0.8 ? model.p80AbsErrorDays : model.p95AbsErrorDays;
  const minForwardDay = model.maxObservedDayIndex + 1;
  let lowDay = Math.max(0, Math.floor(center - spread));
  let highDay = Math.max(0, Math.ceil(center + spread));

  if (nutValue > xMax) {
    lowDay = Math.max(lowDay, minForwardDay);
    highDay = Math.max(highDay, lowDay);
  }

  const low = addBusinessDays(model.minDate, lowDay);
  const high = addBusinessDays(model.minDate, highDay);

  return {
    from: low,
    to: high,
  };
}

function parseNutAssignmentsCsv(csvText) {
  const lines = String(csvText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) return [];

  const earliestByNut = new Map();

  for (const rawLine of lines.slice(1)) {
    const [nutRaw, dateRaw] = rawLine.split(",");
    const nut = Number.parseInt(String(nutRaw || "").trim(), 10);
    const appointmentDate = parseIsoDate(dateRaw);

    if (!Number.isFinite(nut) || !appointmentDate) continue;

    const prev = earliestByNut.get(nut);
    if (!prev || appointmentDate.getTime() < prev.getTime()) {
      earliestByNut.set(nut, appointmentDate);
    }
  }

  const records = [...earliestByNut.entries()]
    .map(([nut, appointmentDate]) => ({ nut, appointmentDate }))
    .sort((a, b) => a.nut - b.nut);

  return records;
}

async function createNutProjectionModelFromCsvFile(filePath) {
  const csv = await fs.readFile(filePath, "utf8");
  const records = parseNutAssignmentsCsv(csv);
  const model = buildModelCore(records, { calibrateUncertainty: true });
  const minNut = model.xs[0];
  const maxNut = model.xs[model.xs.length - 1];

  return {
    model,
    records,
    metadata: {
      sourcePath: filePath,
      recordsCount: records.length,
      minNut,
      maxNut,
      minDate: toIsoDate(model.minDate),
      maxDate: toIsoDate(model.maxDate),
      maeBacktestDays: Number(model.maeBacktestDays.toFixed(2)),
      p80AbsErrorDays: Number(model.p80AbsErrorDays.toFixed(2)),
      p95AbsErrorDays: Number(model.p95AbsErrorDays.toFixed(2)),
      estimatedRecentVelocityNutPerDay: Number((1 / model.recentSlopeDaysPerNut).toFixed(0)),
      estimatedRecentVelocityNutPerBusinessDay: Number((1 / model.recentSlopeDaysPerNut).toFixed(0)),
      loadedAt: new Date().toISOString(),
    },
  };
}

function classifyConfidence(nutValue, minNut, maxNut, isKnownNut) {
  if (isKnownNut) return "alta";
  if (nutValue >= minNut && nutValue <= maxNut) return "media";

  const distance = nutValue < minNut ? minNut - nutValue : nutValue - maxNut;
  const range = Math.max(1, maxNut - minNut);
  const relativeDistance = distance / range;

  if (relativeDistance <= 0.08) return "media-baja";
  return "baja";
}

function buildNutProjection(modelBundle, nutValue) {
  const model = modelBundle.model;
  const knownIndex = model.xs.indexOf(nutValue);
  const isKnownNut = knownIndex >= 0;
  const knownDate = isKnownNut
    ? addBusinessDays(model.minDate, Math.round(model.ys[knownIndex]))
    : null;
  const predictedDate = isKnownNut ? knownDate : model.predictDate(nutValue);
  const p80 = isKnownNut
    ? { from: knownDate, to: knownDate }
    : model.predictionWindow(nutValue, 0.8);
  const p95 = isKnownNut
    ? { from: knownDate, to: knownDate }
    : model.predictionWindow(nutValue, 0.95);

  const confidence = classifyConfidence(
    nutValue,
    modelBundle.metadata.minNut,
    modelBundle.metadata.maxNut,
    isKnownNut
  );

  return {
    nut: nutValue,
    known: isKnownNut,
    knownDate: knownDate ? toIsoDate(knownDate) : "",
    probableDate: toIsoDate(predictedDate),
    window80: {
      from: toIsoDate(p80.from),
      to: toIsoDate(p80.to),
    },
    window95: {
      from: toIsoDate(p95.from),
      to: toIsoDate(p95.to),
    },
    confidence,
  };
}

module.exports = {
  createNutProjectionModelFromCsvFile,
  buildNutProjection,
};
