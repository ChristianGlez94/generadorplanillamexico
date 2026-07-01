const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildNutProjection,
  createNutProjectionModelFromCsvFile,
} = require("../src/services/nutProjectionModel");

function addUtcDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function nextBusinessDate(date) {
  let cursor = date;
  while ([0, 6].includes(cursor.getUTCDay())) {
    cursor = addUtcDays(cursor, 1);
  }
  return cursor;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function buildFixtureCsv() {
  const rows = ["nut,appointment_date"];
  let date = new Date(Date.UTC(2026, 0, 5, 12, 0, 0, 0));

  for (let index = 0; index < 32; index += 1) {
    date = nextBusinessDate(date);
    rows.push(`${7000000 + index * 10},${isoDate(date)}`);
    date = addUtcDays(date, 1);
  }

  return [
    rows[0],
    "bad,2026-01-07",
    "7009999,not-a-date",
    "7000010,2026-02-20",
    ...rows.slice(1).reverse(),
    "",
  ].join("\n");
}

async function writeTempCsv(csvText) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nut-model-test-"));
  const filePath = path.join(dir, "nut_assignments.csv");
  await fs.writeFile(filePath, csvText, "utf8");
  return filePath;
}

test("known NUTs return the historical date, not a projection", async () => {
  const filePath = await writeTempCsv(buildFixtureCsv());
  const bundle = await createNutProjectionModelFromCsvFile(filePath);

  const projection = buildNutProjection(bundle, 7000010);

  assert.equal(projection.known, true);
  assert.equal(projection.knownDate, "2026-01-06");
  assert.equal(projection.probableDate, "2026-01-06");
  assert.deepEqual(projection.window80, {
    from: "2026-01-06",
    to: "2026-01-06",
  });
  assert.equal(projection.confidence, "alta");
});

test("parser tolerates invalid rows, duplicate NUTs and unsorted input", async () => {
  const filePath = await writeTempCsv(buildFixtureCsv());
  const bundle = await createNutProjectionModelFromCsvFile(filePath);

  assert.equal(bundle.metadata.recordsCount, 32);
  assert.equal(bundle.metadata.minNut, 7000000);
  assert.equal(bundle.metadata.maxNut, 7000310);
  assert.equal(bundle.metadata.minDate, "2026-01-05");
  assert.equal(bundle.metadata.maxDate, "2026-02-17");
});

test("unknown NUTs inside and above the range are classified without pretending they are historical", async () => {
  const filePath = await writeTempCsv(buildFixtureCsv());
  const bundle = await createNutProjectionModelFromCsvFile(filePath);

  const inside = buildNutProjection(bundle, 7000005);
  assert.equal(inside.known, false);
  assert.equal(inside.knownDate, "");
  assert.equal(inside.confidence, "media");

  const above = buildNutProjection(bundle, 7000330);
  assert.equal(above.known, false);
  assert.equal(above.knownDate, "");
  assert.equal(above.confidence, "media-baja");
  assert.ok(above.probableDate > bundle.metadata.maxDate);
});

test("real bundled CSV keeps known historical NUTs exact", async () => {
  const bundle = await createNutProjectionModelFromCsvFile(
    path.join(__dirname, "..", "model-nut", "nut_assignments.csv")
  );

  const projection = buildNutProjection(bundle, 7499935);

  assert.equal(projection.known, true);
  assert.equal(projection.knownDate, "2026-06-05");
  assert.equal(projection.probableDate, "2026-06-05");
});
