function normalizePathname(pathname) {
  const clean = String(pathname || "").trim();
  if (!clean) return "/";
  if (clean === "/index.html") return "/";
  return clean.endsWith("/") && clean !== "/" ? clean.slice(0, -1) : clean;
}

const CONSENT_STORAGE_KEY = "site_legal_consent_v1";
const CONSENT_VERSION = "2026-04-27";
const CONSENT_EXEMPT_PATHS = new Set(["/terminos-condiciones.html", "/politica-privacidad.html"]);

function toAbsolutePath(href) {
  const raw = String(href || "").trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw, window.location.origin);
    return normalizePathname(parsed.pathname);
  } catch (_error) {
    return "";
  }
}

function markCurrentNavigationLink() {
  const currentPath = normalizePathname(window.location.pathname);
  const currentIsBlog = currentPath === "/" || currentPath === "/blog.html";
  const selectors = ".hero-nav a, .footer-links a";
  const links = document.querySelectorAll(selectors);

  links.forEach((link) => {
    const linkPath = toAbsolutePath(link.getAttribute("href"));
    if (!linkPath) return;

    const matches =
      currentPath === linkPath ||
      (linkPath === "/" && currentPath === "/noticia.html") ||
      (linkPath === "/" && currentIsBlog);

    if (matches) {
      link.classList.add("is-current");
      link.setAttribute("aria-current", "page");
    }
  });
}

function readStoredConsent() {
  try {
    const raw = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (
      parsed &&
      parsed.version === CONSENT_VERSION &&
      parsed.acceptedTerms === true &&
      parsed.acceptedPrivacy === true
    ) {
      return parsed;
    }
  } catch (_error) {
    // Ignore read/parsing errors and show the gate again.
  }

  return null;
}

function storeConsent() {
  const payload = {
    version: CONSENT_VERSION,
    acceptedTerms: true,
    acceptedPrivacy: true,
    acceptedAt: new Date().toISOString(),
    path: normalizePathname(window.location.pathname),
  };

  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(payload));
  } catch (_error) {
    // If localStorage is unavailable, continue without persistence.
  }
}

function createConsentGate() {
  const gate = document.createElement("section");
  gate.className = "consent-gate";
  gate.setAttribute("role", "dialog");
  gate.setAttribute("aria-modal", "true");
  gate.setAttribute("aria-labelledby", "consentTitle");
  gate.setAttribute("aria-describedby", "consentIntro");

  gate.innerHTML = `
    <div class="consent-card">
      <p class="consent-eyebrow">Consentimiento requerido</p>
      <h2 id="consentTitle">Antes de continuar en el sitio</h2>
      <p id="consentIntro">
        Para navegar este sitio debes aceptar los <a href="/terminos-condiciones.html" target="_blank" rel="noopener noreferrer">Términos y condiciones</a> y la
        <a href="/politica-privacidad.html" target="_blank" rel="noopener noreferrer">Política de privacidad y cookies</a>.
      </p>
      <label class="consent-option" for="consentTerms">
        <input id="consentTerms" type="checkbox" />
        <span>He leído y acepto los Términos y condiciones.</span>
      </label>
      <label class="consent-option" for="consentPrivacy">
        <input id="consentPrivacy" type="checkbox" />
        <span>He leído y acepto la Política de privacidad y cookies.</span>
      </label>
      <button type="button" id="consentAcceptBtn" disabled>Aceptar y continuar</button>
      <p class="consent-note">
        El consentimiento se guarda en este navegador y puede solicitarse de nuevo si hay cambios legales.
      </p>
    </div>
  `;

  return gate;
}

function initConsentGate() {
  const currentPath = normalizePathname(window.location.pathname);
  if (CONSENT_EXEMPT_PATHS.has(currentPath)) return;
  if (readStoredConsent()) return;

  const gate = createConsentGate();
  document.body.classList.add("consent-locked");
  document.body.append(gate);

  const termsCheckbox = gate.querySelector("#consentTerms");
  const privacyCheckbox = gate.querySelector("#consentPrivacy");
  const acceptBtn = gate.querySelector("#consentAcceptBtn");

  const updateAcceptState = () => {
    acceptBtn.disabled = !(termsCheckbox.checked && privacyCheckbox.checked);
  };

  const acceptConsent = () => {
    if (!(termsCheckbox.checked && privacyCheckbox.checked)) return;
    storeConsent();
    gate.remove();
    document.body.classList.remove("consent-locked");
  };

  termsCheckbox.addEventListener("change", updateAcceptState);
  privacyCheckbox.addEventListener("change", updateAcceptState);
  acceptBtn.addEventListener("click", acceptConsent);

  updateAcceptState();
  termsCheckbox.focus();
}

if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      markCurrentNavigationLink();
      initConsentGate();
    },
    { once: true }
  );
} else {
  markCurrentNavigationLink();
  initConsentGate();
}
