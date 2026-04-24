const nutForecastInput = document.getElementById("nutForecastInput");
const nutForecastBtn = document.getElementById("nutForecastBtn");
const nutForecastStatus = document.getElementById("nutForecastStatus");
const nutForecastResult = document.getElementById("nutForecastResult");
const nutForecastMain = document.getElementById("nutForecastMain");
const nutForecastKnown = document.getElementById("nutForecastKnown");
const nutForecastWindow80 = document.getElementById("nutForecastWindow80");
const nutForecastWindow95 = document.getElementById("nutForecastWindow95");
const nutForecastConfidence = document.getElementById("nutForecastConfidence");
const nutForecastMeta = document.getElementById("nutForecastMeta");

function setNutForecastStatus(message, tone = "") {
  nutForecastStatus.textContent = message;
  nutForecastStatus.classList.remove("ok", "error");

  if (tone) {
    nutForecastStatus.classList.add(tone);
  }
}

function normalizeNutInput(rawValue) {
  return String(rawValue || "").replace(/\D/g, "").slice(0, 7);
}

function formatIsoDateLong(value) {
  const clean = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    return clean;
  }

  const [year, month, day] = clean.split("-").map((part) => Number(part));
  const parsed = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
  if (Number.isNaN(parsed.getTime())) {
    return clean;
  }

  try {
    return new Intl.DateTimeFormat("es-MX", { dateStyle: "long", timeZone: "UTC" }).format(parsed);
  } catch (_error) {
    return clean;
  }
}

function renderNutForecastResult(result) {
  nutForecastMain.textContent = `Fecha probable: ${formatIsoDateLong(result.probableDate)}.`;

  if (result.known) {
    nutForecastKnown.textContent = `Tu NUT ya aparece en el histórico con fecha: ${formatIsoDateLong(result.knownDate)}.`;
  } else {
    nutForecastKnown.textContent = "Tu NUT no aparece aún en el histórico cargado.";
  }

  nutForecastWindow80.textContent =
    `Ventana probable 80%: ${formatIsoDateLong(result.window80.from)} a ${formatIsoDateLong(result.window80.to)}.`;
  nutForecastWindow95.textContent =
    `Ventana probable 95%: ${formatIsoDateLong(result.window95.from)} a ${formatIsoDateLong(result.window95.to)}.`;

  const confidenceLabel = String(result.confidence || "").replace("-", " ");
  nutForecastConfidence.textContent = `Nivel de confianza del cálculo: ${confidenceLabel}.`;

  nutForecastMeta.textContent =
    `Modelo entrenado con ${result.model.recordsCount} registros (${result.model.minDate} a ${result.model.maxDate}). Error histórico MAE: ${result.model.maeBacktestDays} días hábiles.`;

  nutForecastResult.classList.remove("hidden");
}

async function calculateNutForecast() {
  const nutValue = normalizeNutInput(nutForecastInput.value);
  nutForecastInput.value = nutValue;

  if (nutValue.length !== 7) {
    nutForecastResult.classList.add("hidden");
    setNutForecastStatus("Debes escribir un NUT válido de 7 dígitos.", "error");
    return;
  }

  nutForecastBtn.disabled = true;
  setNutForecastStatus("Calculando proyección NUT...");

  try {
    const response = await fetch(`/api/nut-forecast?nut=${encodeURIComponent(nutValue)}`, {
      headers: {
        Accept: "application/json",
      },
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || "No se pudo calcular la proyección para ese NUT.");
    }

    renderNutForecastResult(payload);
    setNutForecastStatus("Proyección calculada correctamente.", "ok");
  } catch (error) {
    nutForecastResult.classList.add("hidden");
    setNutForecastStatus(error.message || "No se pudo calcular la proyección NUT.", "error");
  } finally {
    nutForecastBtn.disabled = false;
  }
}

nutForecastInput.addEventListener("input", () => {
  nutForecastInput.value = normalizeNutInput(nutForecastInput.value);
  setNutForecastStatus("");
});

nutForecastInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    calculateNutForecast();
  }
});

nutForecastBtn.addEventListener("click", calculateNutForecast);
