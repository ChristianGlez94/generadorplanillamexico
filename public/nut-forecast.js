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
const RECAPTCHA_SCRIPT_URL = "https://www.google.com/recaptcha/api.js";
let recaptchaConfigPromise = null;
let recaptchaScriptPromise = null;

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

async function loadRecaptchaConfig() {
  if (!recaptchaConfigPromise) {
    recaptchaConfigPromise = fetch("/api/recaptcha-config?context=nut_forecast", {
      headers: {
        Accept: "application/json",
      },
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.message || "No se pudo inicializar la protección anti-bots.");
        }

        const siteKey = String(data.siteKey || "").trim();
        const action = String(data.action || "nut_forecast_lookup").trim() || "nut_forecast_lookup";

        if (!siteKey) {
          throw new Error("No se recibió la clave pública de reCAPTCHA.");
        }

        return { siteKey, action };
      })
      .catch((error) => {
        recaptchaConfigPromise = null;
        throw error;
      });
  }

  return recaptchaConfigPromise;
}

async function loadRecaptchaScript(siteKey) {
  if (window.grecaptcha && typeof window.grecaptcha.ready === "function") {
    return window.grecaptcha;
  }

  if (!recaptchaScriptPromise) {
    recaptchaScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `${RECAPTCHA_SCRIPT_URL}?render=${encodeURIComponent(siteKey)}`;
      script.async = true;
      script.defer = true;
      script.onload = () => {
        if (window.grecaptcha && typeof window.grecaptcha.ready === "function") {
          resolve(window.grecaptcha);
          return;
        }

        reject(new Error("reCAPTCHA no se cargó correctamente."));
      };
      script.onerror = () => {
        reject(new Error("No se pudo cargar reCAPTCHA. Revisa tu conexión e inténtalo de nuevo."));
      };
      document.head.appendChild(script);
    }).catch((error) => {
      recaptchaScriptPromise = null;
      throw error;
    });
  }

  return recaptchaScriptPromise;
}

async function createRecaptchaToken() {
  const config = await loadRecaptchaConfig();
  const grecaptcha = await loadRecaptchaScript(config.siteKey);

  return new Promise((resolve, reject) => {
    grecaptcha.ready(() => {
      grecaptcha
        .execute(config.siteKey, { action: config.action })
        .then((token) => {
          const cleanToken = String(token || "").trim();
          if (!cleanToken) {
            reject(new Error("No se pudo validar reCAPTCHA."));
            return;
          }

          resolve(cleanToken);
        })
        .catch(() => {
          reject(new Error("No se pudo validar reCAPTCHA. Inténtalo nuevamente."));
        });
    });
  });
}

async function preloadRecaptcha() {
  try {
    const config = await loadRecaptchaConfig();
    await loadRecaptchaScript(config.siteKey);
  } catch (_error) {
    // El error se mostrará al usuario cuando intente calcular la proyección.
  }
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
  if (result.known) {
    nutForecastMain.textContent = `Fecha oficial asignada: ${formatIsoDateLong(result.knownDate)}.`;
    nutForecastKnown.textContent = `Tu NUT ya aparece en el histórico con fecha: ${formatIsoDateLong(result.knownDate)}.`;
    nutForecastWindow80.textContent = "Ventana probable 80%: no aplica porque este NUT ya tiene fecha asignada.";
    nutForecastWindow95.textContent = "Ventana probable 95%: no aplica porque este NUT ya tiene fecha asignada.";
  } else {
    nutForecastMain.textContent =
      `Rango probable principal (80%): ${formatIsoDateLong(result.window80.from)} a ${formatIsoDateLong(result.window80.to)}.`;
    nutForecastKnown.textContent =
      `Fecha central estimada: ${formatIsoDateLong(result.probableDate)}. Tu NUT no aparece aún en el histórico cargado.`;
    nutForecastWindow80.textContent =
      `Ventana probable 80%: ${formatIsoDateLong(result.window80.from)} a ${formatIsoDateLong(result.window80.to)}.`;
    nutForecastWindow95.textContent =
      `Ventana probable 95%: ${formatIsoDateLong(result.window95.from)} a ${formatIsoDateLong(result.window95.to)}.`;
  }

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
  setNutForecastStatus("Validando seguridad y calculando proyección NUT...");

  try {
    const recaptchaToken = await createRecaptchaToken();
    const endpoint = `/api/nut-forecast?nut=${encodeURIComponent(nutValue)}&recaptchaToken=${encodeURIComponent(recaptchaToken)}`;
    const response = await fetch(endpoint, {
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
preloadRecaptcha();
