const form = document.getElementById("visaForm");
const submitBtn = document.getElementById("submitBtn");
const statusMessage = document.getElementById("statusMessage");

const officeModeSelect = document.getElementById("oficinaConsularMode");
const officeTextWrap = document.getElementById("officeTextWrap");
const officeTextInput = document.getElementById("oficinaConsularTexto");

const nacionalidadMode = document.getElementById("nacionalidadMode");
const nacionalidadOtraWrap = document.getElementById("nacionalidadOtraWrap");
const nacionalidadOtraInput = document.getElementById("nacionalidadOtra");

const antecedentesSelect = document.getElementById("antecedentesPenales");
const antecedentesDetalleWrap = document.getElementById("antecedentesDetalleWrap");
const antecedentesDetalle = document.getElementById("antecedentesDetalle");
const deportadoSelect = document.getElementById("haSidoDeportado");
const causaDeportacionWrap = document.getElementById("causaDeportacionWrap");
const causaDeportacion = document.getElementById("causaDeportacion");

const ciudadIngresoMode = document.getElementById("ciudadIngresoMode");
const ciudadIngresoManualWrap = document.getElementById("ciudadIngresoManualWrap");
const ciudadIngresoManual = document.getElementById("ciudadIngresoManual");

const propositoViajeMode = document.getElementById("propositoViajeMode");
const propositoViajeManualWrap = document.getElementById("propositoViajeManualWrap");
const propositoViajeManual = document.getElementById("propositoViajeManual");

const lugarFirmaMode = document.getElementById("lugarFirmaMode");
const lugarFirmaManualWrap = document.getElementById("lugarFirmaManualWrap");
const lugarFirmaManual = document.getElementById("lugarFirmaManual");

const correoInput = document.getElementById("correo");
const correoHint = document.getElementById("correoHint");

const fechaNacimientoInput = document.getElementById("fechaNacimiento");
const fechaExpedicionInput = document.getElementById("fechaExpedicion");
const fechaVencimientoInput = document.getElementById("fechaVencimiento");
const fechaIngresoInput = document.getElementById("fechaIngresoMexico");
const fechaFirmaInput = document.getElementById("fechaFirma");

const dateInputs = [
  { element: fechaNacimientoInput, label: "Fecha de nacimiento" },
  { element: fechaExpedicionInput, label: "Fecha de expedición" },
  { element: fechaVencimientoInput, label: "Fecha de vencimiento" },
  { element: fechaIngresoInput, label: "Fecha de ingreso a México" },
  { element: fechaFirmaInput, label: "Fecha de firma" },
];

const MAX_EMAIL_CHARS = 35;
const RECAPTCHA_SCRIPT_URL = "https://www.google.com/recaptcha/api.js";
let recaptchaConfigPromise = null;
let recaptchaScriptPromise = null;

function setStatus(message, tone = "") {
  statusMessage.textContent = message;
  statusMessage.classList.remove("ok", "error");

  if (tone) {
    statusMessage.classList.add(tone);
  }
}

function normalizeDateMask(raw) {
  const digits = String(raw || "").replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

function parseDDMMYYYYToISO(value) {
  const clean = String(value || "").trim();
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(clean);
  if (!match) return "";

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  const valid =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;

  if (!valid) return "";

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function onDateInput(event) {
  const input = event.target;
  const masked = normalizeDateMask(input.value);
  input.value = masked;
  input.setCustomValidity("");
}

function validateDateInput(input, label) {
  const value = input.value.trim();

  if (!value) {
    input.setCustomValidity("Campo obligatorio");
    return false;
  }

  const iso = parseDDMMYYYYToISO(value);
  if (!iso) {
    input.setCustomValidity(`${label} inválida. Use formato dd/mm/aaaa`);
    return false;
  }

  input.setCustomValidity("");
  return true;
}

function toggleOfficeMode() {
  const isOther = officeModeSelect.value === "OTRA";
  officeTextWrap.classList.toggle("hidden", !isOther);
  officeTextInput.required = isOther;

  if (!isOther) {
    officeTextInput.value = "";
  }
}

function toggleNacionalidadMode() {
  const isOther = nacionalidadMode.value === "OTRA";
  nacionalidadOtraWrap.classList.toggle("hidden", !isOther);
  nacionalidadOtraInput.disabled = !isOther;
  nacionalidadOtraInput.required = isOther;

  if (!isOther) {
    nacionalidadOtraInput.value = "";
  }
}

function toggleConditionalFields() {
  const antecedentesYes = antecedentesSelect.value === "SI";
  antecedentesDetalleWrap.classList.toggle("hidden", !antecedentesYes);
  antecedentesDetalle.disabled = !antecedentesYes;
  if (!antecedentesYes) antecedentesDetalle.value = "";

  const deportadoYes = deportadoSelect.value === "SI";
  causaDeportacionWrap.classList.toggle("hidden", !deportadoYes);
  causaDeportacion.disabled = !deportadoYes;
  if (!deportadoYes) causaDeportacion.value = "";
}

function toggleCiudadIngresoMode() {
  const manual = ciudadIngresoMode.value === "OTRA";
  ciudadIngresoManualWrap.classList.toggle("hidden", !manual);
  ciudadIngresoManual.disabled = !manual;
  ciudadIngresoManual.required = manual;
  if (!manual) {
    ciudadIngresoManual.value = "";
  }
}

function togglePropositoViajeMode() {
  const manual = propositoViajeMode.value === "OTRO";
  propositoViajeManualWrap.classList.toggle("hidden", !manual);
  propositoViajeManual.disabled = !manual;
  propositoViajeManual.required = manual;
  if (!manual) {
    propositoViajeManual.value = "";
  }
}

function toggleLugarFirmaMode() {
  const manual = lugarFirmaMode.value === "OTRO";
  lugarFirmaManualWrap.classList.toggle("hidden", !manual);
  lugarFirmaManual.disabled = !manual;
  lugarFirmaManual.required = manual;
  if (!manual) {
    lugarFirmaManual.value = "";
  }
}

function updateEmailHint() {
  const length = correoInput.value.trim().length;

  if (length > MAX_EMAIL_CHARS) {
    correoInput.setCustomValidity(
      `El correo excede el espacio disponible. Usa uno de máximo ${MAX_EMAIL_CHARS} caracteres.`
    );
  } else {
    correoInput.setCustomValidity("");
  }

  correoHint.textContent = `Máximo ${MAX_EMAIL_CHARS} caracteres (actual: ${length}).`;
}

function validateDateRules() {
  let valid = true;

  for (const { element, label } of dateInputs) {
    if (!validateDateInput(element, label)) {
      valid = false;
    }
  }

  const expedicionISO = parseDDMMYYYYToISO(fechaExpedicionInput.value);
  const vencimientoISO = parseDDMMYYYYToISO(fechaVencimientoInput.value);

  if (expedicionISO && vencimientoISO && vencimientoISO < expedicionISO) {
    fechaVencimientoInput.setCustomValidity(
      "La fecha de vencimiento no puede ser menor a la fecha de expedición"
    );
    valid = false;
  }

  return valid;
}

function buildPayload(formData) {
  const nacionalidadModeValue = String(formData.get("nacionalidadMode") || "Cubana").trim();
  const nacionalidadOtra = String(formData.get("nacionalidadOtra") || "").trim();
  const ciudadMode = formData.get("ciudadIngresoMode");
  const propositoMode = formData.get("propositoViajeMode");
  const lugarMode = formData.get("lugarFirmaMode");

  return {
    oficinaConsularMode: formData.get("oficinaConsularMode"),
    oficinaConsularTexto: formData.get("oficinaConsularTexto") || "",

    nombres: formData.get("nombres"),
    primerApellido: formData.get("primerApellido"),
    segundoApellido: formData.get("segundoApellido"),
    sexo: formData.get("sexo"),
    fechaNacimiento: parseDDMMYYYYToISO(formData.get("fechaNacimiento")),

    paisNacimiento: formData.get("paisNacimiento"),
    nacionalidad: nacionalidadModeValue === "OTRA" ? nacionalidadOtra : nacionalidadModeValue,

    numeroPasaporte: formData.get("numeroPasaporte"),
    tipoPasaporte: formData.get("tipoPasaporte"),
    paisExpedicion: formData.get("paisExpedicion"),
    fechaExpedicion: parseDDMMYYYYToISO(formData.get("fechaExpedicion")),
    fechaVencimiento: parseDDMMYYYYToISO(formData.get("fechaVencimiento")),

    estadoCivil: formData.get("estadoCivil"),
    domicilioActual: formData.get("domicilioActual"),
    telefono: formData.get("telefono"),
    correo: formData.get("correo"),
    ocupacion: formData.get("ocupacion"),
    compania: formData.get("compania"),
    lugarResidencia: formData.get("lugarResidencia"),
    cuentaLegalEstancia: formData.get("cuentaLegalEstancia"),
    antecedentesPenales: formData.get("antecedentesPenales"),
    antecedentesDetalle: formData.get("antecedentesDetalle") || "",

    tipoVisa: formData.get("tipoVisa"),
    fechaIngresoMexico: parseDDMMYYYYToISO(formData.get("fechaIngresoMexico")),
    ciudadIngreso: ciudadMode === "OTRA" ? formData.get("ciudadIngresoManual") : ciudadMode,
    temporalidad: formData.get("temporalidad"),
    haVisitadoMexico: formData.get("haVisitadoMexico"),
    haSidoDeportado: formData.get("haSidoDeportado"),
    causaDeportacion: formData.get("causaDeportacion") || "",
    propositoViaje: propositoMode === "OTRO" ? formData.get("propositoViajeManual") : propositoMode,

    documentosAdjuntos: [
      formData.get("doc1") || "",
      formData.get("doc2") || "",
      formData.get("doc3") || "",
      formData.get("doc4") || "",
      formData.get("doc5") || "",
    ],

    lugarFirma:
      lugarMode === "OTRO"
        ? formData.get("lugarFirmaManual")
        : "Consulado de México en La Habana, Cuba",
    fechaFirma: parseDDMMYYYYToISO(formData.get("fechaFirma")),
  };
}

function blobToBase64Payload(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new Error("No se pudo preparar el archivo para descarga."));
    };
    reader.onload = () => {
      const raw = String(reader.result || "");
      const commaIndex = raw.indexOf(",");
      resolve(commaIndex >= 0 ? raw.slice(commaIndex + 1) : raw);
    };
    reader.readAsDataURL(blob);
  });
}

async function triggerDownload(blob, filename) {
  const safeName = String(filename || "documento.pdf").trim() || "documento.pdf";

  if (window.AndroidBridge && typeof window.AndroidBridge.downloadPdf === "function") {
    try {
      const base64Payload = await blobToBase64Payload(blob);
      window.AndroidBridge.downloadPdf(base64Payload, safeName);
      return;
    } catch (_error) {
      // Si falla el puente nativo, usamos el flujo web normal.
    }
  }

  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);

  link.href = url;
  link.download = safeName;
  document.body.appendChild(link);
  link.click();
  link.remove();

  URL.revokeObjectURL(url);
}

function buildTimestampSuffix() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}_${hh}${min}${ss}`;
}

function populateSelect(select, items) {
  const previous = select.value;
  select.innerHTML = '<option value="">Seleccione...</option>';

  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.name;
    option.textContent = item.name;
    select.appendChild(option);
  }

  if (previous) {
    select.value = previous;
  }

  if (!select.value) {
    select.value = "Cuba";
  }
}

async function loadRecaptchaConfig() {
  if (!recaptchaConfigPromise) {
    recaptchaConfigPromise = fetch("/api/recaptcha-config", {
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
        const action = String(data.action || "generate_visa_pdf").trim() || "generate_visa_pdf";

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
    // El error se mostrará al usuario cuando intente enviar el formulario.
  }
}

async function loadCountries() {
  try {
    const response = await fetch("/api/countries");
    if (!response.ok) {
      throw new Error("No se pudo cargar la lista de países");
    }

    const data = await response.json();
    const countries = data.countries || [];

    populateSelect(document.getElementById("paisNacimiento"), countries);
    populateSelect(document.getElementById("paisExpedicion"), countries);
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function submitForm(event) {
  event.preventDefault();

  if (!validateDateRules() || !form.checkValidity()) {
    form.reportValidity();
    return;
  }

  submitBtn.disabled = true;
  setStatus("Generando PDF...");

  try {
    const formData = new FormData(form);
    const recaptchaToken = await createRecaptchaToken();
    const payload = {
      ...buildPayload(formData),
      recaptchaToken,
    };

    const response = await fetch("/api/generate-visa-pdf", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const firstIssue = error?.issues?.[0]?.message;
      throw new Error(firstIssue || error.message || "Error validando la información");
    }

    const blob = await response.blob();
    const passportSlug = String(payload.numeroPasaporte || "visa").replace(/[^a-zA-Z0-9_-]/g, "");
    const timestamp = buildTimestampSuffix();
    await triggerDownload(blob, `solicitud_visa_${passportSlug || "generada"}_${timestamp}.pdf`);
    setStatus("PDF generado correctamente. Revisa y firma a mano.", "ok");
  } catch (error) {
    setStatus(error.message || "No se pudo generar el PDF", "error");
  } finally {
    submitBtn.disabled = false;
  }
}

officeModeSelect.addEventListener("change", toggleOfficeMode);
nacionalidadMode.addEventListener("change", toggleNacionalidadMode);
antecedentesSelect.addEventListener("change", toggleConditionalFields);
deportadoSelect.addEventListener("change", toggleConditionalFields);
ciudadIngresoMode.addEventListener("change", toggleCiudadIngresoMode);
propositoViajeMode.addEventListener("change", togglePropositoViajeMode);
lugarFirmaMode.addEventListener("change", toggleLugarFirmaMode);
correoInput.addEventListener("input", updateEmailHint);

for (const { element } of dateInputs) {
  element.addEventListener("input", onDateInput);
}

form.addEventListener("submit", submitForm);

toggleOfficeMode();
toggleNacionalidadMode();
toggleConditionalFields();
toggleCiudadIngresoMode();
togglePropositoViajeMode();
toggleLugarFirmaMode();
updateEmailHint();
loadCountries();
preloadRecaptcha();
