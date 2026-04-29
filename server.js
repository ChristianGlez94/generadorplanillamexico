require('dotenv').config();
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const fs = require("fs/promises");
const express = require("express");
let sharp = null;
try {
  sharp = require("sharp");
} catch (_error) {
  console.warn(
    "[images] sharp no está disponible; se usará la ruta original sin optimización de imágenes."
  );
}
const { countryList } = require("./src/data/countries");
const { visaFormSchema } = require("./src/validation/visaSchema");
const { blogPostCreateSchema } = require("./src/validation/blogSchema");
const { fillVisaPdf } = require("./src/services/pdfFiller");
const {
  createNutProjectionModelFromCsvFile,
  buildNutProjection,
} = require("./src/services/nutProjectionModel");
const {
  listBlogPosts,
  getBlogPostById,
  createBlogPost,
  deleteBlogPostById,
} = require("./src/data/blogStore");

const app = express();
const port = process.env.PORT || 3000;

const REPORTER_COOKIE = "reporter_session";
const REPORTER_PASSWORD = String(process.env.REPORTER_PASSWORD || "");
const REPORTER_SESSION_SECRET = String(
  process.env.REPORTER_SESSION_SECRET || "local-dev-reporter-secret"
);
const REPORTER_SESSION_TTL_SECONDS = 60 * 60 * 12;
const REPORTER_PORTAL_PATH = normalizePortalPath(
  process.env.REPORTER_PORTAL_PATH || "/acceso-reporteros-interno"
);
const REPORTER_HTML_PATH = path.join(__dirname, "internal", "reporter", "reporteros.html");
const REPORTER_JS_PATH = path.join(__dirname, "internal", "reporter", "reporteros.js");
const BLOG_HTML_TEMPLATE_PATH = path.join(__dirname, "public", "blog.html");
const BLOG_ARCHIVE_TEMPLATE_PATH = path.join(__dirname, "public", "archivo-noticias.html");
const NEWS_HTML_TEMPLATE_PATH = path.join(__dirname, "public", "noticia.html");
const BLOG_STORAGE_DIR = String(process.env.BLOG_STORAGE_DIR || "").trim();
const SITE_BASE_URL = String(process.env.SITE_BASE_URL || "").trim();
const ALLOWED_ORIGINS = parseAllowedOrigins(String(process.env.ALLOWED_ORIGINS || ""), SITE_BASE_URL);
const RECAPTCHA_SITE_KEY = String(process.env.RECAPTCHA_SITE_KEY || "").trim();
const RECAPTCHA_SECRET_KEY = String(process.env.RECAPTCHA_SECRET_KEY || "").trim();
const RECAPTCHA_ACTION = String(process.env.RECAPTCHA_ACTION || "generate_visa_pdf").trim() || "generate_visa_pdf";
const RECAPTCHA_MIN_SCORE = parseRecaptchaMinScore(process.env.RECAPTCHA_MIN_SCORE);
const RECAPTCHA_ENABLED = Boolean(RECAPTCHA_SITE_KEY && RECAPTCHA_SECRET_KEY);
const NUT_MODEL_CSV_PATH = String(
  process.env.NUT_MODEL_CSV_PATH || path.join(__dirname, "model-nut", "nut_assignments.csv")
).trim();
const LEGACY_UPLOADS_DIR = path.join(__dirname, "public", "uploads");
const UPLOADS_DIR = BLOG_STORAGE_DIR
  ? path.join(path.resolve(BLOG_STORAGE_DIR), "uploads")
  : LEGACY_UPLOADS_DIR;
const IMAGE_VARIANTS_DIR = BLOG_STORAGE_DIR
  ? path.join(path.resolve(BLOG_STORAGE_DIR), "image-variants")
  : path.join(__dirname, "output", "image-variants");
const MAX_IMAGE_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_UPLOAD_IMAGE_WIDTH = 1920;
const MAX_OPTIMIZED_IMAGE_WIDTH = 1920;
const DEFAULT_OPTIMIZED_IMAGE_QUALITY = 76;
const BLOG_PAGE_SIZE = 15;
const BLOG_TEMPLATE_CACHE = new Map();
const useSecureCookie = process.env.NODE_ENV === "production";
const IMAGE_EXT_BY_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};
const OPTIMIZED_IMAGE_MIME_BY_FORMAT = {
  webp: "image/webp",
  jpeg: "image/jpeg",
};
const PUBLIC_SITE_PATHS = [
  "/",
  "/herramienta.html",
  "/estimador-nut.html",
  "/archivo-noticias.html",
  "/sobre-esta-herramienta.html",
  "/contacto.html",
  "/politica-privacidad.html",
  "/terminos-condiciones.html",
  "/aviso-responsabilidad.html",
];
const RATE_LIMIT_STORE = new Map();
const RATE_LIMIT_CONFIG = {
  reporterLogin: { windowMs: 15 * 60 * 1000, max: 8 },
  reporterWrite: { windowMs: 60 * 1000, max: 30 },
  generatePdf: { windowMs: 60 * 1000, max: 30 },
  nutForecast: { windowMs: 60 * 1000, max: 60 },
};
const NUT_MODEL_STATE = {
  bundle: null,
  loadingPromise: null,
  lastError: null,
};

if (!REPORTER_PASSWORD) {
  console.warn(
    "[reporteros] REPORTER_PASSWORD no está configurada. El acceso de reporteros quedará bloqueado."
  );
}

if (process.env.NODE_ENV === "production" && isWeakReporterSecret(REPORTER_SESSION_SECRET)) {
  throw new Error(
    "[security] REPORTER_SESSION_SECRET insegura o ausente en producción. Usa una clave de al menos 32 caracteres."
  );
}

if (!process.env.REPORTER_SESSION_SECRET) {
  console.warn(
    "[reporteros] REPORTER_SESSION_SECRET no está configurada. Usa una clave larga en producción."
  );
} else if (isWeakReporterSecret(REPORTER_SESSION_SECRET)) {
  console.warn(
    "[reporteros] REPORTER_SESSION_SECRET es débil para producción. Recomendado: 32+ caracteres aleatorios."
  );
}

if (RECAPTCHA_SITE_KEY && !RECAPTCHA_SECRET_KEY) {
  console.warn("[security] RECAPTCHA_SITE_KEY configurada, pero RECAPTCHA_SECRET_KEY está ausente.");
} else if (!RECAPTCHA_SITE_KEY && RECAPTCHA_SECRET_KEY) {
  console.warn("[security] RECAPTCHA_SECRET_KEY configurada, pero RECAPTCHA_SITE_KEY está ausente.");
} else if (!RECAPTCHA_ENABLED) {
  console.warn("[security] reCAPTCHA V3 no está configurado. La generación de PDF será bloqueada.");
}

app.use((req, res, next) => {
  setDefaultSecurityHeaders(res);
  next();
});
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return next();
  }

  if (req.path === "/health") {
    return next();
  }

  const redirectHref = buildCanonicalSiteRedirectHref(req);
  if (!redirectHref) {
    return next();
  }

  return res.redirect(301, redirectHref);
});
app.use((req, res, next) => {
  const origin = String(req.headers.origin || "").trim();

  if (!origin) {
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
      return res.status(204).end();
    }
    return next();
  }

  if (!isOriginAllowed(req, origin)) {
    if (req.method === "OPTIONS") {
      return res.status(403).end();
    }

    return res.status(403).json({
      message: "Origen no autorizado.",
    });
  }

  res.setHeader("Access-Control-Allow-Origin", normalizeBaseUrl(origin));
  appendVaryHeader(res, "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  return next();
});
app.use(express.json({ limit: "10mb" }));

app.get("/", async (req, res) => {
  try {
    const posts = await listBlogPosts();
    const canonicalBlogHref = buildCanonicalBlogListRedirectHref({
      basePath: "/",
      pageValue: req.query.page,
      query: req.query,
      totalItems: posts.length,
    });
    if (canonicalBlogHref) {
      return res.redirect(301, canonicalBlogHref);
    }

    const requestedPage = parsePositiveInteger(getSingleQueryValue(req.query.page), 1);
    const html = await renderBlogListHtml({
      baseUrl: resolveBaseUrl(req),
      posts,
      requestedPage,
      canonicalPath: "/",
      pageTitle: "Blog y noticias de interés | Planilla Visa México",
      seoDescription:
        "Noticias y guías útiles sobre trámites de visa y viaje a México, con enfoque en información práctica y verificable.",
    });

    res.setHeader("Cache-Control", "no-store");
    return res.type("text/html; charset=utf-8").send(html);
  } catch (error) {
    console.error("Error renderizando /:", error);
    return res.status(500).type("text/plain; charset=utf-8").send("No se pudo cargar la portada.");
  }
});

app.get("/blog.html", async (req, res) => {
  try {
    const posts = await listBlogPosts();
    const canonicalBlogHref = buildCanonicalBlogListRedirectHref({
      basePath: "/",
      pageValue: req.query.page,
      query: req.query,
      totalItems: posts.length,
    });
    if (canonicalBlogHref) {
      return res.redirect(301, canonicalBlogHref);
    }
  } catch (error) {
    console.error("Error resolviendo redirección canónica de /blog.html:", error);
  }

  const queryStart = String(req.originalUrl || "").indexOf("?");
  const queryString = queryStart >= 0 ? String(req.originalUrl || "").slice(queryStart) : "";
  return res.redirect(301, `/${queryString}`);
});

app.get("/archivo-noticias.html", async (req, res) => {
  try {
    const posts = await listBlogPosts();
    const html = await renderBlogArchivePageHtml({
      baseUrl: resolveBaseUrl(req),
      posts,
    });

    res.setHeader("Cache-Control", "no-store");
    return res.type("text/html; charset=utf-8").send(html);
  } catch (error) {
    console.error("Error renderizando /archivo-noticias.html:", error);
    return res.status(500).type("text/plain; charset=utf-8").send("No se pudo cargar el archivo de noticias.");
  }
});

app.get("/noticia.html", async (req, res) => {
  try {
    const queryIdValue = req.query.id;
    const postId = String(getSingleQueryValue(queryIdValue) || "").trim();
    const posts = await listBlogPosts();
    const resolution = resolveBlogPostByRequestedId(posts, postId);

    const canonicalNewsHref = buildCanonicalNewsRedirectHref({
      queryIdValue,
      resolution,
    });
    if (canonicalNewsHref) {
      return res.redirect(301, canonicalNewsHref);
    }

    const selectedPost = resolution.post;
    const html = await renderBlogDetailHtml({
      baseUrl: resolveBaseUrl(req),
      post: selectedPost,
      posts,
      requestedPostId: resolution.requestedId || postId,
    });

    res.setHeader("Cache-Control", "no-store");
    if (resolution.requestedId && !selectedPost) {
      return res.status(404).type("text/html; charset=utf-8").send(html);
    }

    return res.type("text/html; charset=utf-8").send(html);
  } catch (error) {
    console.error("Error renderizando /noticia.html:", error);
    return res.status(500).type("text/plain; charset=utf-8").send("No se pudo cargar la noticia.");
  }
});

app.get("/herramienta.html", (_req, res) => {
  return res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/index.html", (_req, res) => {
  return res.redirect(301, "/herramienta.html");
});

app.use("/uploads", express.static(UPLOADS_DIR, { maxAge: "365d", immutable: true }));
if (path.resolve(UPLOADS_DIR) !== path.resolve(LEGACY_UPLOADS_DIR)) {
  app.use("/uploads", express.static(LEGACY_UPLOADS_DIR, { maxAge: "365d", immutable: true }));
}
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: setPublicStaticCacheHeaders,
  })
);

async function ensureUploadsDir() {
  try {
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
  } catch (error) {
    console.error("No se pudo preparar el directorio de uploads:", error);
  }
}

void ensureUploadsDir();

async function ensureImageVariantsDir() {
  try {
    await fs.mkdir(IMAGE_VARIANTS_DIR, { recursive: true });
  } catch (error) {
    console.error("No se pudo preparar el directorio de variantes de imágenes:", error);
  }
}

void ensureImageVariantsDir();

async function ensureNutProjectionModelLoaded() {
  if (NUT_MODEL_STATE.bundle) {
    return NUT_MODEL_STATE.bundle;
  }

  if (NUT_MODEL_STATE.loadingPromise) {
    return NUT_MODEL_STATE.loadingPromise;
  }

  NUT_MODEL_STATE.loadingPromise = createNutProjectionModelFromCsvFile(NUT_MODEL_CSV_PATH)
    .then((bundle) => {
      NUT_MODEL_STATE.bundle = bundle;
      NUT_MODEL_STATE.lastError = null;
      console.log(
        `[nut-model] Modelo cargado. registros=${bundle.metadata.recordsCount} rangoNUT=${bundle.metadata.minNut}-${bundle.metadata.maxNut}`
      );
      return bundle;
    })
    .catch((error) => {
      NUT_MODEL_STATE.lastError = error;
      console.error("[nut-model] No se pudo cargar el modelo de proyección NUT:", error);
      return null;
    })
    .finally(() => {
      NUT_MODEL_STATE.loadingPromise = null;
    });

  return NUT_MODEL_STATE.loadingPromise;
}

void ensureNutProjectionModelLoaded();

function setPublicStaticCacheHeaders(res, filePath) {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".html") {
    // HTML se mantiene sin cache para que siempre referencie los assets más recientes.
    res.setHeader("Cache-Control", "no-store");
    return;
  }

  if (extension === ".js" || extension === ".css") {
    res.setHeader("Cache-Control", "public, max-age=86400");
    return;
  }

  res.setHeader("Cache-Control", "public, max-age=2592000");
}

function safeCompareText(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");

  if (left.length !== right.length || left.length === 0) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function normalizePortalPath(rawPath) {
  const input = String(rawPath || "").trim();
  if (!input) return "/acceso-reporteros-interno";
  if (input.startsWith("/")) return input;
  return `/${input}`;
}

function parseRecaptchaMinScore(rawValue) {
  const parsed = Number.parseFloat(String(rawValue || "").trim());
  if (!Number.isFinite(parsed)) {
    return 0.5;
  }

  return Math.min(1, Math.max(0, parsed));
}

async function postFormUrlEncoded(url, payload) {
  const target = new URL(url);
  const body = new URLSearchParams(payload).toString();

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );

    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

async function verifyRecaptchaV3Token(token, remoteIp) {
  if (!RECAPTCHA_ENABLED) {
    return {
      ok: false,
      reason: "not_configured",
    };
  }

  const cleanToken = String(token || "").trim();
  if (!cleanToken) {
    return {
      ok: false,
      reason: "missing_token",
    };
  }

  const payload = {
    secret: RECAPTCHA_SECRET_KEY,
    response: cleanToken,
  };

  const cleanRemoteIp = String(remoteIp || "").trim();
  if (cleanRemoteIp && cleanRemoteIp !== "unknown") {
    payload.remoteip = cleanRemoteIp;
  }

  try {
    const verifyResponse = await postFormUrlEncoded(
      "https://www.google.com/recaptcha/api/siteverify",
      payload
    );

    if (verifyResponse.statusCode < 200 || verifyResponse.statusCode >= 300) {
      return {
        ok: false,
        reason: "google_http_error",
      };
    }

    let body;
    try {
      body = JSON.parse(verifyResponse.body || "{}");
    } catch (_error) {
      return {
        ok: false,
        reason: "invalid_json",
      };
    }

    const action = String(body.action || "");
    const score = Number(body.score);
    const scoreIsValid = Number.isFinite(score) && score >= RECAPTCHA_MIN_SCORE;
    const actionIsValid = action === RECAPTCHA_ACTION;
    const success = body.success === true;

    return {
      ok: success && actionIsValid && scoreIsValid,
      reason: !success
        ? "captcha_rejected"
        : !actionIsValid
          ? "action_mismatch"
          : !scoreIsValid
            ? "score_too_low"
            : "ok",
      body,
    };
  } catch (_error) {
    return {
      ok: false,
      reason: "request_failed",
    };
  }
}

function parseAllowedOrigins(rawOrigins, fallbackBaseUrl) {
  const origins = new Set();
  const source = String(rawOrigins || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  for (const candidate of source) {
    const normalized = normalizeBaseUrl(candidate);
    if (normalized) origins.add(normalized);
  }

  const fallback = normalizeBaseUrl(fallbackBaseUrl);
  if (fallback) origins.add(fallback);

  return origins;
}

function normalizeBaseUrl(rawUrl) {
  const input = String(rawUrl || "").trim();
  if (!input) return "";

  try {
    const parsed = new URL(input);
    return `${parsed.protocol}//${parsed.host}`;
  } catch (_error) {
    return "";
  }
}

function resolveRequestBaseUrl(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();

  const protocol = forwardedProto || req.protocol || "https";
  const host = forwardedHost || req.get("host") || "localhost";
  return normalizeBaseUrl(`${protocol}://${host}`);
}

function resolveBaseUrl(req) {
  const configured = normalizeBaseUrl(SITE_BASE_URL);
  if (configured) return configured;
  return resolveRequestBaseUrl(req);
}

function buildCanonicalSiteRedirectHref(req) {
  const canonicalBaseUrl = normalizeBaseUrl(SITE_BASE_URL);
  if (!canonicalBaseUrl) return "";

  const requestBaseUrl = resolveRequestBaseUrl(req);
  if (!requestBaseUrl) return "";

  if (requestBaseUrl.toLowerCase() === canonicalBaseUrl.toLowerCase()) {
    return "";
  }

  const originalPath = String(req.originalUrl || req.url || "").trim();
  const safePath = originalPath.startsWith("/") ? originalPath : `/${originalPath}`;
  return `${canonicalBaseUrl}${safePath || "/"}`;
}

function isWeakReporterSecret(secret) {
  const clean = String(secret || "");
  if (!clean) return true;
  if (clean === "local-dev-reporter-secret") return true;
  return clean.length < 32;
}

function appendVaryHeader(res, value) {
  const current = String(res.getHeader("Vary") || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (current.includes(value)) return;
  const next = [...current, value].join(", ");
  res.setHeader("Vary", next);
}

function setDefaultSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function isOriginAllowed(req, origin) {
  const normalizedOrigin = normalizeBaseUrl(origin);
  if (!normalizedOrigin) return false;

  if (ALLOWED_ORIGINS.has(normalizedOrigin)) {
    return true;
  }

  const requestHost = String(req.get("host") || "").trim().toLowerCase();
  if (!requestHost) return false;

  try {
    const parsedOrigin = new URL(normalizedOrigin);
    return String(parsedOrigin.host || "").toLowerCase() === requestHost;
  } catch (_error) {
    return false;
  }
}

function xmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function makeAbsoluteUrl(baseUrl, pathname) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const pathPart = String(pathname || "").startsWith("/") ? String(pathname || "") : `/${pathname}`;
  return `${base}${pathPart}`;
}

function toIsoTimestamp(value) {
  const raw = String(value || "").trim();
  if (!raw) return new Date().toISOString();

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${raw}T00:00:00.000Z`;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
}

function normalizeBlogPostId(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
}

function stripTrailingYearFromBlogId(postId) {
  const cleanId = normalizeBlogPostId(postId);
  if (!cleanId) return "";
  const match = cleanId.match(/^(.*)-(19|20)\d{2}$/);
  if (!match) return "";
  return String(match[1] || "").replace(/-+$/g, "");
}

function buildLoosePostTitleKey(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(19|20)\d{2}\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function areLikelySameBlogPost(first, second) {
  const firstKey = buildLoosePostTitleKey(first?.title);
  const secondKey = buildLoosePostTitleKey(second?.title);
  if (!firstKey || !secondKey) return false;
  return firstKey === secondKey;
}

function buildBlogPostIndex(posts) {
  const safePosts = Array.isArray(posts) ? posts : [];
  const byId = new Map();

  for (const post of safePosts) {
    const cleanId = normalizeBlogPostId(post?.id);
    if (!cleanId || byId.has(cleanId)) continue;
    byId.set(cleanId, post);
  }

  return byId;
}

function resolveBlogPostByRequestedId(posts, requestedId) {
  const cleanRequestedId = normalizeBlogPostId(requestedId);
  if (!cleanRequestedId) {
    return {
      requestedId: "",
      canonicalId: "",
      post: null,
      shouldRedirect: false,
    };
  }

  const byId = buildBlogPostIndex(posts);
  const directPost = byId.get(cleanRequestedId) || null;
  const baseId = stripTrailingYearFromBlogId(cleanRequestedId);
  const basePost = baseId ? byId.get(baseId) || null : null;

  if (basePost && baseId !== cleanRequestedId) {
    if (!directPost || areLikelySameBlogPost(directPost, basePost)) {
      return {
        requestedId: cleanRequestedId,
        canonicalId: baseId,
        post: basePost,
        shouldRedirect: true,
      };
    }
  }

  return {
    requestedId: cleanRequestedId,
    canonicalId: cleanRequestedId,
    post: directPost,
    shouldRedirect: false,
  };
}

function buildCanonicalBlogPostEntries(posts) {
  const safePosts = Array.isArray(posts) ? posts : [];
  const byId = buildBlogPostIndex(safePosts);
  const canonicalEntries = new Map();

  for (const post of safePosts) {
    const cleanId = normalizeBlogPostId(post?.id);
    if (!cleanId) continue;

    let canonicalId = cleanId;
    let canonicalPost = post;
    const baseId = stripTrailingYearFromBlogId(cleanId);
    const basePost = baseId ? byId.get(baseId) || null : null;

    if (basePost && baseId !== cleanId && areLikelySameBlogPost(post, basePost)) {
      canonicalId = baseId;
      canonicalPost = basePost;
    }

    if (!canonicalEntries.has(canonicalId)) {
      canonicalEntries.set(canonicalId, canonicalPost);
    }
  }

  return [...canonicalEntries.entries()].map(([canonicalId, post]) => ({
    canonicalId,
    post,
  }));
}

function getSingleQueryValue(value) {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function parsePositiveInteger(rawValue, fallback, max = Infinity) {
  const value = getSingleQueryValue(rawValue);
  const parsed = Number.parseInt(String(value || "").trim(), 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function parseNutNumber(rawValue) {
  const clean = String(rawValue || "").replace(/\s+/g, "");
  if (!/^\d{7}$/.test(clean)) {
    return null;
  }

  const parsed = Number.parseInt(clean, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

function collectBlogCategories(posts) {
  const safePosts = Array.isArray(posts) ? posts : [];
  const categories = new Set();

  for (const post of safePosts) {
    const category = String(post?.category || "").trim();
    if (category) {
      categories.add(category);
    }
  }

  return [...categories].sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function filterBlogPosts(posts, options = {}) {
  const safePosts = Array.isArray(posts) ? posts : [];
  const query = normalizeSearchText(String(options.query || "").trim());
  const category = normalizeSearchText(String(options.category || "").trim());

  const hasQuery = Boolean(query);
  const hasCategory = Boolean(category) && category !== "todas";

  if (!hasQuery && !hasCategory) {
    return safePosts;
  }

  return safePosts.filter((post) => {
    const postCategory = normalizeSearchText(String(post?.category || "").trim());
    const tags = Array.isArray(post?.tags) ? post.tags.join(" ") : "";
    const text = normalizeSearchText([post?.title, post?.description, post?.category, tags].join(" "));

    const matchesQuery = !hasQuery || text.includes(query);
    const matchesCategory = !hasCategory || postCategory === category;
    return matchesQuery && matchesCategory;
  });
}

function buildSitemapXml(entries) {
  const lines = entries.map((entry) => {
    const loc = xmlEscape(entry.loc);
    const lastmod = xmlEscape(entry.lastmod);
    const changefreq = xmlEscape(entry.changefreq);
    const priority = xmlEscape(entry.priority);

    return [
      "  <url>",
      `    <loc>${loc}</loc>`,
      `    <lastmod>${lastmod}</lastmod>`,
      `    <changefreq>${changefreq}</changefreq>`,
      `    <priority>${priority}</priority>`,
      "  </url>",
    ].join("\n");
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...lines,
    "</urlset>",
    "",
  ].join("\n");
}

async function readTemplateFileCached(filePath) {
  const cached = BLOG_TEMPLATE_CACHE.get(filePath);
  if (cached) return cached;

  const template = await fs.readFile(filePath, "utf8");
  BLOG_TEMPLATE_CACHE.set(filePath, template);
  return template;
}

async function renderBlogListHtml({
  baseUrl,
  posts,
  requestedPage = 1,
  canonicalPath = "/",
  pageTitle = "Blog y noticias de interés | Planilla Visa México",
  seoDescription = "",
}) {
  const template = await readTemplateFileCached(BLOG_HTML_TEMPLATE_PATH);
  const safePosts = Array.isArray(posts) ? posts : [];
  const totalItems = safePosts.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / BLOG_PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, Number(requestedPage) || 1), totalPages);
  const offset = (currentPage - 1) * BLOG_PAGE_SIZE;
  const pagePosts = safePosts.slice(offset, offset + BLOG_PAGE_SIZE);
  const featured = pagePosts[0] || null;
  const listItems = pagePosts.slice(1);
  const categories = collectBlogCategories(safePosts);
  const firstVisible = totalItems ? (currentPage - 1) * BLOG_PAGE_SIZE + 1 : 0;
  const lastVisible = totalItems ? firstVisible + pagePosts.length - 1 : 0;
  const countText = !totalItems
    ? "0 noticias"
    : `Mostrando ${firstVisible}-${Math.max(firstVisible, lastVisible)} de ${totalItems} ${totalItems === 1 ? "noticia" : "noticias"}`;
  const lastUpdateText = featured
    ? `Última actualización: ${formatBlogDate(featured.date)}`
    : "Última actualización: --";
  const featuredMarkup = featured
    ? buildBlogPostCardMarkup(featured, true)
    : '<p class="blog-empty">No hay noticias para mostrar.</p>';
  const listMarkup = listItems.length
    ? listItems.map((post) => buildBlogPostCardMarkup(post, false)).join("")
    : totalItems
      ? '<p class="blog-empty">No hay más noticias en esta página.</p>'
      : '<p class="blog-empty">No hay noticias publicadas por ahora.</p>';
  const randomMarkup = featured
    ? `Sugerencia inicial: <a href="${buildBlogPostUrl(featured.id)}">${escapeHtml(featured.title)}</a>`
    : "Aún no hay noticias disponibles.";
  const paginationMarkup = buildBlogPaginationMarkup({
    page: currentPage,
    totalPages,
    totalItems,
    hasPrevPage: currentPage > 1,
    hasNextPage: currentPage < totalPages,
    basePath: canonicalPath,
  });
  const canonicalUrl = makeAbsoluteUrl(baseUrl, buildBlogPageHref(canonicalPath, currentPage));
  const prevUrl = currentPage > 1
    ? makeAbsoluteUrl(baseUrl, buildBlogPageHref(canonicalPath, currentPage - 1))
    : "";
  const nextUrl = currentPage < totalPages
    ? makeAbsoluteUrl(baseUrl, buildBlogPageHref(canonicalPath, currentPage + 1))
    : "";
  const resolvedDescription = seoDescription
    || (totalItems
      ? `Noticias y guías sobre trámites de visa y viaje a México. Actualmente hay ${totalItems} publicaciones con información práctica y fuentes oficiales.`
      : "Noticias y guías sobre trámites de visa y viaje a México con enfoque en información práctica y verificable.");
  const headExtras = [
    `<meta name="description" content="${escapeHtml(resolvedDescription)}" />`,
    `<link rel="canonical" href="${escapeHtml(canonicalUrl)}" />`,
    '<meta property="og:type" content="website" />',
    `<meta property="og:title" content="${escapeHtml(pageTitle)}" />`,
    `<meta property="og:description" content="${escapeHtml(resolvedDescription)}" />`,
    `<meta property="og:url" content="${escapeHtml(canonicalUrl)}" />`,
    prevUrl ? `<link rel="prev" href="${escapeHtml(prevUrl)}" />` : "",
    nextUrl ? `<link rel="next" href="${escapeHtml(nextUrl)}" />` : "",
  ]
    .filter(Boolean)
    .join("\n    ");

  let html = template;
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(pageTitle)}</title>`);
  html = html.replace(/<p id="blogCount">[\s\S]*?<\/p>/, `<p id="blogCount">${escapeHtml(countText)}</p>`);
  html = html.replace(
    /<p id="blogLastUpdate">[\s\S]*?<\/p>/,
    `<p id="blogLastUpdate">${escapeHtml(lastUpdateText)}</p>`
  );
  html = html.replace(
    /<div id="blogCategories" class="blog-categories" aria-label="Filtrar por categoría">[\s\S]*?<\/div>/,
    `<div id="blogCategories" class="blog-categories" aria-label="Filtrar por categoría">${buildBlogCategoryButtonsMarkup(categories, "Todas")}</div>`
  );
  html = html.replace(
    /<p id="blogRandomResult">[\s\S]*?<\/p>/,
    `<p id="blogRandomResult">${randomMarkup}</p>`
  );
  html = html.replace(
    /<article id="featuredPost" class="blog-featured" aria-live="polite">[\s\S]*?<\/article>/,
    `<article id="featuredPost" class="blog-featured" aria-live="polite">${featuredMarkup}</article>`
  );
  html = html.replace(
    /<div id="blogList" class="blog-list" aria-live="polite">[\s\S]*?<\/div>/,
    `<div id="blogList" class="blog-list" aria-live="polite">${listMarkup}</div>`
  );
  const paginationWithLinksPattern =
    /<div id="blogPagination" class="blog-pagination(?: hidden)?" aria-label="Navegación por páginas">[\s\S]*?<\/div>\s*<nav id="blogPaginationLinks" class="blog-pagination-links(?: hidden)?" aria-label="Enlaces de paginación">[\s\S]*?<\/nav>/;
  const paginationOnlyPattern =
    /<div id="blogPagination" class="blog-pagination(?: hidden)?" aria-label="Navegación por páginas">[\s\S]*?<\/div>/;

  if (paginationWithLinksPattern.test(html)) {
    html = html.replace(paginationWithLinksPattern, paginationMarkup);
  } else {
    html = html.replace(paginationOnlyPattern, paginationMarkup);
  }
  html = html.replace("</head>", `    ${headExtras}\n  </head>`);

  return html;
}

async function renderBlogArchivePageHtml({ baseUrl, posts }) {
  const template = await readTemplateFileCached(BLOG_ARCHIVE_TEMPLATE_PATH);
  const safePosts = Array.isArray(posts) ? posts : [];
  const totalItems = safePosts.length;
  const latestPost = safePosts[0] || null;
  const countText = totalItems === 1 ? "1 noticia publicada" : `${totalItems} noticias publicadas`;
  const lastUpdateText = latestPost
    ? `Última actualización: ${formatBlogDate(latestPost.date)}`
    : "Última actualización: --";
  const archiveMarkup = buildBlogArchiveMarkup(safePosts, { maxItems: 5000 });
  const canonicalUrl = makeAbsoluteUrl(baseUrl, "/archivo-noticias.html");
  const seoDescription = totalItems
    ? `Archivo completo con ${totalItems} noticias y artículos sobre migración mexicana, visas y trámites para viajar a México.`
    : "Archivo completo de noticias sobre migración mexicana, visas y trámites para viajar a México.";
  const headExtras = [
    `<meta name="description" content="${escapeHtml(seoDescription)}" />`,
    `<link rel="canonical" href="${escapeHtml(canonicalUrl)}" />`,
    '<meta property="og:type" content="website" />',
    `<meta property="og:title" content="${escapeHtml("Archivo completo de noticias | Planilla Visa México")}" />`,
    `<meta property="og:description" content="${escapeHtml(seoDescription)}" />`,
    `<meta property="og:url" content="${escapeHtml(canonicalUrl)}" />`,
  ].join("\n    ");

  let html = template;
  html = html.replace(
    /<p id="archiveCount">[\s\S]*?<\/p>/,
    `<p id="archiveCount">${escapeHtml(countText)}</p>`
  );
  html = html.replace(
    /<p id="archiveLastUpdate">[\s\S]*?<\/p>/,
    `<p id="archiveLastUpdate">${escapeHtml(lastUpdateText)}</p>`
  );
  html = html.replace(
    /<ul id="blogArchive" class="blog-archive-list" aria-live="polite">[\s\S]*?<\/ul>/,
    `<ul id="blogArchive" class="blog-archive-list" aria-live="polite">${archiveMarkup}</ul>`
  );
  html = html.replace(
    /<title>[\s\S]*?<\/title>/,
    "<title>Archivo completo de noticias | Planilla Visa México</title>"
  );
  html = html.replace("</head>", `    ${headExtras}\n  </head>`);

  return html;
}

async function renderBlogDetailHtml({ baseUrl, post, posts, requestedPostId }) {
  const template = await readTemplateFileCached(NEWS_HTML_TEMPLATE_PATH);
  const safePosts = Array.isArray(posts) ? posts : [];
  const hasPost = Boolean(post);
  const readingTime = hasPost ? estimateBlogReadingTime(post.content, post.description) : 1;
  const detailMarkup = hasPost
    ? buildBlogDetailPostMarkup(post, readingTime)
    : `<p class="blog-empty">${escapeHtml(
        requestedPostId
          ? "La noticia solicitada no está disponible o fue retirada."
          : "No se especificó la noticia a consultar."
      )}</p>`;
  const relatedItems = hasPost
    ? safePosts.filter((item) => item.id !== post.id).slice(0, 3)
    : safePosts.slice(0, 3);
  const relatedMarkup = buildBlogRelatedMarkup(relatedItems);
  const canonicalUrl = hasPost
    ? makeAbsoluteUrl(baseUrl, buildBlogPostUrl(post.id))
    : makeAbsoluteUrl(baseUrl, "/");
  const pageTitle = hasPost ? `${String(post.title || "Noticia")} | Blog` : "Noticia no disponible | Blog";
  const seoDescription = hasPost
    ? truncateText(post.description || post.title || "", 165)
    : "La noticia solicitada no está disponible. Revisa otras publicaciones recientes del blog.";
  const robotsMeta = hasPost ? "" : '<meta name="robots" content="noindex,follow" />';
  const jsonLd = hasPost
    ? `<script type="application/ld+json">${JSON.stringify(
        buildNewsArticleJsonLd({
          baseUrl,
          canonicalUrl,
          post,
          readingTime,
        })
      )}</script>`
    : "";
  const headExtras = [
    `<meta name="description" content="${escapeHtml(seoDescription)}" />`,
    `<link rel="canonical" href="${escapeHtml(canonicalUrl)}" />`,
    '<meta property="og:type" content="article" />',
    `<meta property="og:title" content="${escapeHtml(pageTitle)}" />`,
    `<meta property="og:description" content="${escapeHtml(seoDescription)}" />`,
    `<meta property="og:url" content="${escapeHtml(canonicalUrl)}" />`,
    robotsMeta,
    jsonLd,
  ]
    .filter(Boolean)
    .join("\n    ");

  let html = template;
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(pageTitle)}</title>`);
  html = html.replace(
    /<article id="newsDetail" class="blog-detail-card" aria-live="polite">[\s\S]*?<\/article>/,
    `<article id="newsDetail" class="blog-detail-card" aria-live="polite">${detailMarkup}</article>`
  );
  html = html.replace(
    /<div id="relatedNews" class="related-news-list" aria-live="polite">[\s\S]*?<\/div>/,
    `<div id="relatedNews" class="related-news-list" aria-live="polite">${relatedMarkup}</div>`
  );
  html = html.replace("</head>", `    ${headExtras}\n  </head>`);

  return html;
}

function buildNewsArticleJsonLd({ baseUrl, canonicalUrl, post, readingTime }) {
  const imageUrl = toAbsoluteAssetUrl(baseUrl, post?.image);
  const datePublished = toIsoTimestamp(post?.createdAt || post?.date);
  const dateModified = toIsoTimestamp(post?.date || post?.createdAt);

  const payload = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: String(post?.title || "Noticia"),
    description: String(post?.description || ""),
    datePublished,
    dateModified,
    author: {
      "@type": "Organization",
      name: "Equipo editorial de Planilla Visa México",
    },
    publisher: {
      "@type": "Organization",
      name: "Planilla Visa México",
    },
    mainEntityOfPage: canonicalUrl,
    timeRequired: `PT${Math.max(1, Number(readingTime) || 1)}M`,
  };

  if (imageUrl) {
    payload.image = [imageUrl];
  }

  return payload;
}

function buildBlogCategoryButtonsMarkup(categories, activeCategory = "Todas") {
  const source = Array.isArray(categories) ? categories : [];
  const values = ["Todas", ...source];
  return values
    .map((category) => {
      const isActive = category === activeCategory;
      const activeClass = isActive ? " active" : "";
      return `<button type="button" class="blog-category-btn${activeClass}" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`;
    })
    .join("");
}

function buildBlogPaginationMarkup({ page, totalPages, totalItems, hasPrevPage, hasNextPage, basePath = "/" }) {
  const shouldShow = totalItems > 0 && totalPages > 1;
  const wrapperClass = shouldShow ? "blog-pagination" : "blog-pagination hidden";
  const prevDisabled = hasPrevPage ? "" : " disabled";
  const nextDisabled = hasNextPage ? "" : " disabled";
  const safePage = Math.max(1, Number(page) || 1);
  const safeTotalPages = Math.max(1, Number(totalPages) || 1);
  const prevHref = buildBlogPageHref(basePath, safePage - 1);
  const nextHref = buildBlogPageHref(basePath, safePage + 1);
  const crawlerLinksClass = shouldShow ? "blog-pagination-links" : "blog-pagination-links hidden";
  const prevCrawlerLink = hasPrevPage
    ? `<a id="blogPrevLink" class="blog-page-link" href="${escapeHtml(prevHref)}" rel="prev">Ir a la página anterior</a>`
    : '<span id="blogPrevLink" class="blog-page-link is-disabled">Sin página anterior</span>';
  const nextCrawlerLink = hasNextPage
    ? `<a id="blogNextLink" class="blog-page-link" href="${escapeHtml(nextHref)}" rel="next">Ir a la página siguiente</a>`
    : '<span id="blogNextLink" class="blog-page-link is-disabled">Sin página siguiente</span>';

  return `
        <div id="blogPagination" class="${wrapperClass}" aria-label="Navegación por páginas">
          <button type="button" id="blogPrevBtn" class="blog-page-btn"${prevDisabled}>Página anterior</button>
          <p id="blogPageInfo">Página ${safePage} de ${safeTotalPages}</p>
          <button type="button" id="blogNextBtn" class="blog-page-btn"${nextDisabled}>Página siguiente</button>
        </div>
        <nav id="blogPaginationLinks" class="${crawlerLinksClass}" aria-label="Enlaces de paginación">
          ${prevCrawlerLink}
          ${nextCrawlerLink}
        </nav>
  `.trim();
}

function buildBlogPostCardMarkup(post, isFeatured) {
  const safePost = post || {};
  const reading = estimateBlogReadingTime(safePost.content, safePost.description);
  const preview = isFeatured
    ? String(safePost.description || "")
    : truncateText(String(safePost.description || ""), 185);
  const tags = Array.isArray(safePost.tags)
    ? safePost.tags
        .slice(0, 3)
        .map((tag) => `<span class="blog-tag">${escapeHtml(tag)}</span>`)
        .join("")
    : "";
  const wrapperClass = isFeatured ? "blog-featured-item" : "blog-card";
  const detailUrl = buildBlogPostUrl(safePost.id);
  const imageMarkup = buildBlogImageMarkup({
    image: safePost.image,
    alt: safePost.alt,
    mode: isFeatured ? "featured" : "list",
  });

  return `
      <article
        id="post-${escapeHtml(safePost.id || "")}"
        class="${wrapperClass}"
        data-detail-url="${detailUrl}"
        tabindex="0"
        role="link"
      >
        <figure class="blog-media">
          <a href="${detailUrl}" class="blog-image-link">
            ${imageMarkup}
          </a>
        </figure>
        <div>
          <div class="blog-meta-line">
            <span class="blog-chip">${escapeHtml(safePost.category || "General")}</span>
            <span class="blog-date">${escapeHtml(formatBlogDate(safePost.date))}</span>
            <span class="blog-reading">${reading} min de lectura</span>
          </div>
          <h3><a class="blog-title-link" href="${detailUrl}">${escapeHtml(safePost.title || "Noticia")}</a></h3>
          <p>${escapeHtml(preview)}</p>
          <div class="blog-tags">${tags}</div>
          <a class="blog-open-link" href="${detailUrl}">Leer noticia completa</a>
        </div>
      </article>
  `;
}

function buildBlogDetailPostMarkup(post, readingTime) {
  const safePost = post || {};
  const paragraphs = Array.isArray(safePost.content) && safePost.content.length
    ? safePost.content
    : [String(safePost.description || "")];
  const tags = Array.isArray(safePost.tags)
    ? safePost.tags.map((tag) => `<span class="blog-tag">${escapeHtml(tag)}</span>`).join("")
    : "";

  return `
    <div class="blog-detail-meta">
      <span class="blog-chip">${escapeHtml(safePost.category || "General")}</span>
      <span class="blog-date">${escapeHtml(formatBlogDate(safePost.date))}</span>
      <span class="blog-reading">${Math.max(1, Number(readingTime) || 1)} min de lectura</span>
      <span class="blog-date">Autor: Equipo editorial</span>
    </div>
    <h2>${escapeHtml(safePost.title || "Noticia")}</h2>
    <figure class="blog-detail-image">
      ${buildBlogImageMarkup({
        image: safePost.image,
        alt: safePost.alt,
        mode: "detail",
      })}
    </figure>
    <p class="blog-detail-summary">${escapeHtml(safePost.description || "")}</p>
    <div class="blog-detail-content">
      ${paragraphs.map((line) => `<p>${linkifyBlogText(line)}</p>`).join("")}
    </div>
    <div class="blog-tags">${tags}</div>
  `;
}

function buildBlogRelatedMarkup(posts) {
  const safePosts = Array.isArray(posts) ? posts : [];
  if (!safePosts.length) {
    return '<p class="blog-empty">No hay más noticias para mostrar por ahora.</p>';
  }

  return safePosts
    .map((post) => {
      const detailUrl = buildBlogPostUrl(post?.id);
      return `
        <article class="related-news-card">
          <h3><a class="blog-title-link" href="${detailUrl}">${escapeHtml(post?.title || "Noticia")}</a></h3>
          <p>${escapeHtml(post?.description || "")}</p>
          <a class="blog-open-link" href="${detailUrl}">Leer completa</a>
        </article>
      `;
    })
    .join("");
}

function buildBlogArchiveMarkup(posts, options = {}) {
  const safePosts = Array.isArray(posts) ? posts : [];
  const maxItems = Math.max(1, Number(options.maxItems) || 250);
  if (!safePosts.length) {
    return '<li class="blog-empty">No hay noticias disponibles en el archivo por ahora.</li>';
  }

  const visiblePosts = safePosts.slice(0, maxItems);
  const rows = visiblePosts.map((post) => {
    const detailUrl = buildBlogPostUrl(post?.id);
    const title = escapeHtml(post?.title || "Noticia");
    const date = escapeHtml(formatBlogDate(post?.date));
    return `
      <li class="blog-archive-item">
        <a class="blog-title-link" href="${detailUrl}">${title}</a>
        <span class="blog-archive-date">${date}</span>
      </li>
    `;
  });

  if (safePosts.length > visiblePosts.length) {
    rows.push(`
      <li class="blog-archive-item">
        <a class="blog-open-link" href="/sitemap.xml">Ver más URLs en el sitemap</a>
      </li>
    `);
  }

  return rows.join("");
}

function buildBlogPostUrl(postId) {
  const cleanId = String(postId || "").trim();
  if (!cleanId) return "/noticia.html";
  return `/noticia.html?id=${encodeURIComponent(cleanId)}`;
}

function buildBlogPageHref(basePath, page) {
  const safeBasePath = String(basePath || "/").trim() || "/";
  const cleanBase = safeBasePath.startsWith("/") ? safeBasePath : `/${safeBasePath}`;
  const safePage = Math.max(1, Number(page) || 1);
  if (safePage <= 1) return cleanBase;
  return `${cleanBase}?page=${String(safePage)}`;
}

function buildCanonicalBlogListRedirectHref({ basePath = "/", pageValue, query, totalItems = 0 }) {
  if (pageValue === undefined) {
    return "";
  }

  const pageValues = Array.isArray(pageValue) ? pageValue : [pageValue];
  const hasMultiplePageValues = pageValues.length > 1;
  const rawPage = String(getSingleQueryValue(pageValue) || "").trim();
  const parsedPageCandidate = Number.parseInt(rawPage, 10);
  const isPositiveInteger =
    /^\d+$/.test(rawPage)
    && Number.isFinite(parsedPageCandidate)
    && parsedPageCandidate > 0;
  const parsedPage = isPositiveInteger ? parsedPageCandidate : 1;
  const totalPages = Math.max(1, Math.ceil(Math.max(0, Number(totalItems) || 0) / BLOG_PAGE_SIZE));
  const canonicalPage = Math.min(Math.max(1, parsedPage), totalPages);

  const incomingIsCanonical =
    !hasMultiplePageValues
    && isPositiveInteger
    && rawPage === String(parsedPage)
    && parsedPage === canonicalPage
    && canonicalPage > 1;
  if (incomingIsCanonical) {
    return "";
  }

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (key === "page") continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        params.append(key, String(item));
      }
      continue;
    }

    if (value !== undefined && value !== null) {
      params.append(key, String(value));
    }
  }

  if (canonicalPage > 1) {
    params.set("page", String(canonicalPage));
  }

  const cleanBasePath = String(basePath || "/").trim() || "/";
  const queryString = params.toString();
  return queryString ? `${cleanBasePath}?${queryString}` : cleanBasePath;
}

function buildCanonicalNewsRedirectHref({ queryIdValue, resolution }) {
  const canonicalId = String(resolution?.canonicalId || "").trim();
  const hasCanonicalTarget = Boolean(canonicalId);
  if (!hasCanonicalTarget) {
    return "";
  }

  const hasResolvedPost = Boolean(resolution?.post);
  if (!hasResolvedPost && !resolution?.shouldRedirect) {
    return "";
  }

  if (resolution?.shouldRedirect) {
    return buildBlogPostUrl(canonicalId);
  }

  const rawIds = Array.isArray(queryIdValue) ? queryIdValue : [queryIdValue];
  if (rawIds.length > 1) {
    return buildBlogPostUrl(canonicalId);
  }

  const rawId = String(getSingleQueryValue(queryIdValue) || "");
  if (!rawId.trim()) {
    return "";
  }

  if (rawId !== canonicalId) {
    return buildBlogPostUrl(canonicalId);
  }

  return "";
}

function buildBlogImageMarkup({ image, alt, mode }) {
  const cleanImage = String(image || "").trim();
  const safeAlt = escapeHtml(String(alt || "Imagen de la noticia"));
  const isEager = mode === "featured" || mode === "detail";
  const loading = isEager ? "eager" : "lazy";
  const fetchPriority = isEager ? "high" : "low";

  if (!cleanImage) {
    return '<div class="blog-image-fallback" aria-hidden="true"></div>';
  }

  const optimized = buildBlogOptimizedImageSources(cleanImage, mode);
  if (!optimized) {
    return `
      <img
        src="${escapeHtml(cleanImage)}"
        alt="${safeAlt}"
        loading="${loading}"
        decoding="async"
        fetchpriority="${fetchPriority}"
      />
    `;
  }

  return `
    <picture>
      <source
        type="image/webp"
        srcset="${escapeHtml(optimized.webpSrcSet)}"
        sizes="${escapeHtml(optimized.sizes)}"
      />
      <img
        src="${escapeHtml(optimized.fallbackSrc)}"
        srcset="${escapeHtml(optimized.fallbackSrcSet)}"
        sizes="${escapeHtml(optimized.sizes)}"
        alt="${safeAlt}"
        loading="${loading}"
        decoding="async"
        fetchpriority="${fetchPriority}"
      />
    </picture>
  `;
}

function buildBlogOptimizedImageSources(imageUrl, mode = "list") {
  if (!isOptimizableBlogUploadImage(imageUrl)) return null;

  let widths = [280, 420, 640];
  let quality = 74;
  let sizes = "(max-width: 900px) 92vw, (max-width: 1120px) 44vw, 30vw";

  if (mode === "featured") {
    widths = [480, 768, 1024, 1360];
    quality = 80;
    sizes = "(max-width: 900px) 92vw, 58vw";
  } else if (mode === "detail") {
    widths = [720, 1024, 1360, 1680];
    quality = 80;
    sizes = "(max-width: 900px) 92vw, 78vw";
  }

  const webpSrcSet = widths
    .map((width) => `${buildBlogOptimizedImageUrl(imageUrl, width, quality, "webp")} ${String(width)}w`)
    .join(", ");
  const fallbackSrcSet = widths
    .map((width) => `${buildBlogOptimizedImageUrl(imageUrl, width, quality, "jpeg")} ${String(width)}w`)
    .join(", ");
  const fallbackWidth = widths[Math.max(0, widths.length - 2)] || widths[0];

  return {
    webpSrcSet,
    fallbackSrcSet,
    fallbackSrc: buildBlogOptimizedImageUrl(imageUrl, fallbackWidth, quality, "jpeg"),
    sizes,
  };
}

function buildBlogOptimizedImageUrl(sourceUrl, width, quality, format) {
  const params = new URLSearchParams();
  params.set("src", sourceUrl);
  params.set("w", String(width));
  params.set("q", String(quality));
  params.set("fm", format);
  return `/api/blog-image?${params.toString()}`;
}

function isOptimizableBlogUploadImage(imageUrl) {
  const clean = String(imageUrl || "").trim();
  if (!clean.startsWith("/uploads/")) return false;
  return !/\.(svg|gif)(\?.*)?$/i.test(clean);
}

function parseBlogDate(value) {
  const raw = String(value || "").trim();
  const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (ymd) {
    const year = Number(ymd[1]);
    const monthIndex = Number(ymd[2]) - 1;
    const day = Number(ymd[3]);
    return new Date(year, monthIndex, day, 12, 0, 0, 0);
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return new Date(1970, 0, 1, 12, 0, 0, 0);
  }

  return parsed;
}

function formatBlogDate(value) {
  const date = parseBlogDate(value);
  try {
    return new Intl.DateTimeFormat("es-MX", { dateStyle: "long" }).format(date);
  } catch (_error) {
    return String(value || "");
  }
}

function truncateText(value, maxChars) {
  const clean = String(value || "").trim();
  if (!clean) return "";
  if (clean.length <= maxChars) return clean;

  const slice = clean.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  return `${slice.slice(0, lastSpace > 30 ? lastSpace : maxChars).trim()}...`;
}

function estimateBlogReadingTime(content, description) {
  const text = Array.isArray(content) && content.length ? content.join(" ") : String(description || "");
  const words = text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(words / 170));
}

function linkifyBlogText(value) {
  const input = String(value || "");
  const markdownLinkPattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi;
  let html = "";
  let lastIndex = 0;
  let match = markdownLinkPattern.exec(input);

  while (match) {
    const rawMatch = String(match[0] || "");
    const linkText = String(match[1] || "").trim();
    const rawUrl = String(match[2] || "");
    const offset = Number(match.index || 0);
    const { cleanUrl, suffix } = splitTrailingBlogUrlPunctuation(rawUrl);

    html += linkifyBlogPlainText(input.slice(lastIndex, offset));
    html += cleanUrl ? buildBlogExternalLink(cleanUrl, linkText || cleanUrl) : escapeHtml(rawMatch);

    if (suffix) {
      html += escapeHtml(suffix);
    }

    lastIndex = offset + rawMatch.length;
    match = markdownLinkPattern.exec(input);
  }

  html += linkifyBlogPlainText(input.slice(lastIndex));
  return html;
}

function linkifyBlogPlainText(value) {
  const input = String(value || "");
  const urlPattern = /https?:\/\/[^\s<>"']+/gi;
  let html = "";
  let lastIndex = 0;
  let match = urlPattern.exec(input);

  while (match) {
    const rawUrl = String(match[0] || "");
    const offset = Number(match.index || 0);
    const { cleanUrl, suffix } = splitTrailingBlogUrlPunctuation(rawUrl);

    html += escapeHtml(input.slice(lastIndex, offset));
    html += cleanUrl ? buildBlogExternalLink(cleanUrl, cleanUrl) : escapeHtml(rawUrl);

    if (suffix) {
      html += escapeHtml(suffix);
    }

    lastIndex = offset + rawUrl.length;
    match = urlPattern.exec(input);
  }

  html += escapeHtml(input.slice(lastIndex));
  return html;
}

function buildBlogExternalLink(url, label) {
  const safeUrl = sanitizeHttpUrl(url);
  if (!safeUrl) {
    return escapeHtml(label || url);
  }

  return `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label || safeUrl)}</a>`;
}

function sanitizeHttpUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.toString();
  } catch (_error) {
    return "";
  }
}

function splitTrailingBlogUrlPunctuation(url) {
  let cleanUrl = String(url || "");
  let suffix = "";

  while (/[),.;:!?]$/.test(cleanUrl)) {
    suffix = cleanUrl.slice(-1) + suffix;
    cleanUrl = cleanUrl.slice(0, -1);
  }

  return {
    cleanUrl,
    suffix,
  };
}

function toAbsoluteAssetUrl(baseUrl, imagePath) {
  const raw = String(imagePath || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return makeAbsoluteUrl(baseUrl, raw);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getClientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();

  if (forwarded) return forwarded;
  return String(req.ip || req.socket?.remoteAddress || "unknown");
}

function cleanupRateLimitStore(now) {
  if (RATE_LIMIT_STORE.size < 1500) return;

  for (const [key, entry] of RATE_LIMIT_STORE.entries()) {
    if (!entry || entry.resetAt <= now) {
      RATE_LIMIT_STORE.delete(key);
    }
  }
}

function consumeRateLimit(req, bucket, config) {
  const now = Date.now();
  cleanupRateLimitStore(now);

  const ip = getClientIp(req);
  const key = `${bucket}:${ip}`;
  const current = RATE_LIMIT_STORE.get(key);

  if (!current || current.resetAt <= now) {
    const first = { count: 1, resetAt: now + config.windowMs };
    RATE_LIMIT_STORE.set(key, first);
    return {
      allowed: true,
      count: first.count,
      remaining: Math.max(0, config.max - first.count),
      resetAt: first.resetAt,
    };
  }

  current.count += 1;
  RATE_LIMIT_STORE.set(key, current);
  const allowed = current.count <= config.max;

  return {
    allowed,
    count: current.count,
    remaining: Math.max(0, config.max - current.count),
    resetAt: current.resetAt,
  };
}

function withRateLimit(bucket, config) {
  return (req, res, next) => {
    const status = consumeRateLimit(req, bucket, config);
    res.setHeader("X-RateLimit-Limit", String(config.max));
    res.setHeader("X-RateLimit-Remaining", String(status.remaining));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(status.resetAt / 1000)));

    if (status.allowed) {
      return next();
    }

    const retryAfter = Math.max(1, Math.ceil((status.resetAt - Date.now()) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    return res.status(429).json({
      message: "Demasiadas solicitudes. Intenta de nuevo en unos minutos.",
    });
  };
}

function parseCookies(headerValue) {
  const result = {};
  const raw = String(headerValue || "");

  for (const part of raw.split(";")) {
    const section = part.trim();
    if (!section) continue;
    const separator = section.indexOf("=");
    if (separator <= 0) continue;

    const key = section.slice(0, separator).trim();
    const value = section.slice(separator + 1).trim();
    try {
      result[key] = decodeURIComponent(value);
    } catch (_error) {
      result[key] = value;
    }
  }

  return result;
}

function setNoIndexHeaders(res) {
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
}

function sanitizeUploadBaseName(fileName) {
  const trimmed = String(fileName || "")
    .replace(/\.[a-z0-9]+$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

  return trimmed || "imagen";
}

function resolveUploadedImagePath(imageUrl) {
  const raw = String(imageUrl || "");
  const prefix = "/uploads/";
  if (!raw.startsWith(prefix)) return null;

  const fileName = raw.slice(prefix.length);
  if (!fileName) return null;

  const safeName = path.basename(fileName);
  if (safeName !== fileName) return null;

  return path.join(UPLOADS_DIR, safeName);
}

function resolveUploadedImageCandidatePaths(imageUrl) {
  const primaryPath = resolveUploadedImagePath(imageUrl);
  if (!primaryPath) return [];

  if (path.resolve(UPLOADS_DIR) === path.resolve(LEGACY_UPLOADS_DIR)) {
    return [primaryPath];
  }

  const legacyPath = path.join(LEGACY_UPLOADS_DIR, path.basename(primaryPath));
  return [primaryPath, legacyPath];
}

async function findExistingUploadedImage(imageUrl) {
  const candidates = resolveUploadedImageCandidatePaths(imageUrl);
  for (const candidate of candidates) {
    try {
      const stats = await fs.stat(candidate);
      if (stats.isFile()) {
        return {
          filePath: candidate,
          stats,
        };
      }
    } catch (error) {
      if (!error || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return null;
}

function sanitizeImageCachePart(value) {
  const clean = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return clean || "img";
}

function normalizeOptimizedImageFormat(value) {
  const raw = String(getSingleQueryValue(value) || "").trim().toLowerCase();
  const normalized = raw === "jpg" ? "jpeg" : raw;
  if (normalized === "jpeg") return "jpeg";
  return "webp";
}

function normalizeOptimizedImageQuality(value) {
  const parsed = parsePositiveInteger(value, DEFAULT_OPTIMIZED_IMAGE_QUALITY, 90);
  return Math.max(45, parsed);
}

async function optimizeUploadedImageBuffer(inputBuffer, sourceMime) {
  if (!sharp) {
    return {
      buffer: inputBuffer,
      mimeType: sourceMime,
    };
  }

  const isConvertible = sourceMime === "image/jpeg" || sourceMime === "image/png" || sourceMime === "image/webp";
  if (!isConvertible) {
    return {
      buffer: inputBuffer,
      mimeType: sourceMime,
    };
  }

  const pipeline = sharp(inputBuffer, { failOn: "none", animated: false })
    .rotate()
    .resize({
      width: MAX_UPLOAD_IMAGE_WIDTH,
      fit: "inside",
      withoutEnlargement: true,
    });

  const optimizedBuffer = await pipeline.webp({ quality: 80, effort: 5 }).toBuffer();
  const shouldKeepOriginal =
    !optimizedBuffer.length ||
    (sourceMime !== "image/png" && optimizedBuffer.length >= Math.round(inputBuffer.length * 0.98));

  if (shouldKeepOriginal) {
    return {
      buffer: inputBuffer,
      mimeType: sourceMime,
    };
  }

  return {
    buffer: optimizedBuffer,
    mimeType: "image/webp",
  };
}

function buildOptimizedImageVariantFileName(sourcePath, sourceStats, width, quality, format) {
  const sourceBaseName = sanitizeImageCachePart(path.basename(sourcePath, path.extname(sourcePath)));
  const sourceFingerprint = crypto
    .createHash("sha1")
    .update(`${sourcePath}|${String(sourceStats.size)}|${String(sourceStats.mtimeMs)}`)
    .digest("hex")
    .slice(0, 12);
  const formatExtension = format === "jpeg" ? "jpg" : "webp";
  return `${sourceBaseName}--${sourceFingerprint}--w${String(width)}-q${String(quality)}.${formatExtension}`;
}

async function createOptimizedImageVariant({ sourcePath, sourceStats, width, quality, format }) {
  await fs.mkdir(IMAGE_VARIANTS_DIR, { recursive: true });
  const safeWidth = Math.max(160, Math.min(width, MAX_OPTIMIZED_IMAGE_WIDTH));
  const fileName = buildOptimizedImageVariantFileName(sourcePath, sourceStats, safeWidth, quality, format);
  const variantPath = path.join(IMAGE_VARIANTS_DIR, fileName);

  try {
    await fs.stat(variantPath);
    return {
      filePath: variantPath,
      contentType: OPTIMIZED_IMAGE_MIME_BY_FORMAT[format] || "image/webp",
    };
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
  }

  const tempPath = `${variantPath}.tmp-${process.pid}-${Date.now()}`;
  let transformer = sharp(sourcePath, { failOn: "none", animated: false })
    .rotate()
    .resize({
      width: safeWidth,
      fit: "inside",
      withoutEnlargement: true,
    });

  if (format === "jpeg") {
    transformer = transformer.jpeg({ quality, mozjpeg: true, progressive: true });
  } else {
    transformer = transformer.webp({ quality, effort: 5 });
  }

  try {
    await transformer.toFile(tempPath);
    await fs.rename(tempPath, variantPath);
  } catch (error) {
    try {
      await fs.unlink(tempPath);
    } catch (_unlinkError) {
      // Ignoramos errores de limpieza temporal.
    }
    throw error;
  }

  return {
    filePath: variantPath,
    contentType: OPTIMIZED_IMAGE_MIME_BY_FORMAT[format] || "image/webp",
  };
}

async function purgeImageVariantsForUpload(imageUrl) {
  const sourcePath = resolveUploadedImagePath(imageUrl);
  if (!sourcePath) return;

  const sourceBaseName = sanitizeImageCachePart(path.basename(sourcePath, path.extname(sourcePath)));
  const prefix = `${sourceBaseName}--`;
  let entries = [];

  try {
    entries = await fs.readdir(IMAGE_VARIANTS_DIR, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
      .map(async (entry) => {
        const targetPath = path.join(IMAGE_VARIANTS_DIR, entry.name);
        try {
          await fs.unlink(targetPath);
        } catch (error) {
          if (error && error.code !== "ENOENT") {
            console.error("Error eliminando variante optimizada:", error);
          }
        }
      })
  );
}

function createReporterToken() {
  const expiresAt = Date.now() + REPORTER_SESSION_TTL_SECONDS * 1000;
  const payload = String(expiresAt);
  const signature = crypto
    .createHmac("sha256", REPORTER_SESSION_SECRET)
    .update(payload)
    .digest("hex");

  return `${payload}.${signature}`;
}

function validateReporterToken(token) {
  const clean = String(token || "");
  const [rawExpiry, rawSignature] = clean.split(".");
  if (!rawExpiry || !rawSignature) return false;

  const expectedSignature = crypto
    .createHmac("sha256", REPORTER_SESSION_SECRET)
    .update(rawExpiry)
    .digest("hex");

  if (!safeCompareText(rawSignature, expectedSignature)) {
    return false;
  }

  const expiresAt = Number(rawExpiry);
  if (!Number.isFinite(expiresAt)) return false;
  if (expiresAt < Date.now()) return false;

  return true;
}

function isReporterAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie);
  return validateReporterToken(cookies[REPORTER_COOKIE]);
}

function setReporterCookie(res, token) {
  const secureFlag = useSecureCookie ? "; Secure" : "";
  const cookie = `${REPORTER_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${REPORTER_SESSION_TTL_SECONDS}${secureFlag}`;
  res.setHeader("Set-Cookie", cookie);
}

function clearReporterCookie(res) {
  const secureFlag = useSecureCookie ? "; Secure" : "";
  const cookie = `${REPORTER_COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${secureFlag}`;
  res.setHeader("Set-Cookie", cookie);
}

function detectImageMime(buffer) {
  if (!buffer || buffer.length < 12) return null;

  const isPng =
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a;
  if (isPng) return "image/png";

  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (isJpeg) return "image/jpeg";

  const gifHeader = buffer.toString("ascii", 0, 6);
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
    return "image/gif";
  }

  const riff = buffer.toString("ascii", 0, 4);
  const webp = buffer.toString("ascii", 8, 12);
  if (riff === "RIFF" && webp === "WEBP") {
    return "image/webp";
  }

  return null;
}

function requireReporterAuth(req, res, next) {
  if (!isReporterAuthenticated(req)) {
    return res.status(401).json({
      message: "Debes iniciar sesión en el área de reporteros.",
    });
  }

  return next();
}

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/api/countries", (_req, res) => {
  res.json({
    countries: countryList,
  });
});

app.get("/api/recaptcha-config", (_req, res) => {
  if (!RECAPTCHA_SITE_KEY) {
    return res.status(503).json({
      message: "reCAPTCHA no está configurado en el servidor.",
    });
  }

  return res.json({
    siteKey: RECAPTCHA_SITE_KEY,
    action: RECAPTCHA_ACTION,
  });
});

app.get("/api/nut-forecast", withRateLimit("nut-forecast", RATE_LIMIT_CONFIG.nutForecast), async (req, res) => {
  const nutValue = parseNutNumber(getSingleQueryValue(req.query.nut));
  if (nutValue === null) {
    return res.status(400).json({
      message: "Debes indicar un NUT válido de 7 dígitos en el parámetro nut.",
    });
  }

  const modelBundle = await ensureNutProjectionModelLoaded();
  if (!modelBundle) {
    return res.status(503).json({
      message: "El modelo de proyección NUT no está disponible temporalmente.",
    });
  }

  const projection = buildNutProjection(modelBundle, nutValue);
  return res.json({
    ...projection,
    model: {
      recordsCount: modelBundle.metadata.recordsCount,
      minNut: modelBundle.metadata.minNut,
      maxNut: modelBundle.metadata.maxNut,
      minDate: modelBundle.metadata.minDate,
      maxDate: modelBundle.metadata.maxDate,
      maeBacktestDays: modelBundle.metadata.maeBacktestDays,
      p80AbsErrorDays: modelBundle.metadata.p80AbsErrorDays,
      p95AbsErrorDays: modelBundle.metadata.p95AbsErrorDays,
      estimatedRecentVelocityNutPerDay: modelBundle.metadata.estimatedRecentVelocityNutPerDay,
      estimatedRecentVelocityNutPerBusinessDay: modelBundle.metadata.estimatedRecentVelocityNutPerBusinessDay,
      loadedAt: modelBundle.metadata.loadedAt,
    },
  });
});

app.get("/robots.txt", (req, res) => {
  const baseUrl = resolveBaseUrl(req);
  const lines = [
    "User-agent: *",
    "Allow: /",
    `Disallow: ${REPORTER_PORTAL_PATH}`,
    "Disallow: /_internal/",
    `Sitemap: ${baseUrl}/sitemap.xml`,
    "",
  ];

  res.type("text/plain; charset=utf-8");
  return res.send(lines.join("\n"));
});

app.get("/sitemap.xml", async (req, res) => {
  try {
    const baseUrl = resolveBaseUrl(req);
    const nowIso = new Date().toISOString();
    const posts = await listBlogPosts();
    const canonicalPostEntries = buildCanonicalBlogPostEntries(posts);

    const staticEntries = PUBLIC_SITE_PATHS.map((pathname) => {
      const priority = pathname === "/"
        ? "1.0"
        : pathname === "/herramienta.html"
          ? "0.9"
          : pathname === "/estimador-nut.html"
            ? "0.85"
          : pathname === "/archivo-noticias.html"
            ? "0.8"
            : "0.7";
      const changefreq = pathname === "/" || pathname === "/herramienta.html" ? "daily" : "weekly";

      return {
        loc: makeAbsoluteUrl(baseUrl, pathname),
        lastmod: nowIso,
        changefreq,
        priority,
      };
    });

    const postEntries = canonicalPostEntries.map((entry) => ({
      loc: makeAbsoluteUrl(baseUrl, buildBlogPostUrl(entry.canonicalId)),
      lastmod: toIsoTimestamp(entry.post?.createdAt || entry.post?.date),
      changefreq: "weekly",
      priority: "0.8",
    }));

    const totalBlogPages = Math.max(1, Math.ceil(posts.length / BLOG_PAGE_SIZE));
    const paginatedBlogEntries = [];
    for (let page = 2; page <= totalBlogPages; page += 1) {
      paginatedBlogEntries.push({
        loc: makeAbsoluteUrl(baseUrl, buildBlogPageHref("/", page)),
        lastmod: nowIso,
        changefreq: "daily",
        priority: "0.75",
      });
    }

    res.type("application/xml; charset=utf-8");
    return res.send(buildSitemapXml([...staticEntries, ...paginatedBlogEntries, ...postEntries]));
  } catch (error) {
    console.error("Error generando sitemap.xml:", error);
    return res.status(500).type("application/xml; charset=utf-8").send(
      '<?xml version="1.0" encoding="UTF-8"?><error>No se pudo generar sitemap.xml</error>'
    );
  }
});

app.get("/api/blog-posts", async (req, res) => {
  try {
    const posts = await listBlogPosts();
    const availableCategories = collectBlogCategories(posts);
    const pageRaw = getSingleQueryValue(req.query.page);
    const limitRaw = getSingleQueryValue(req.query.limit);
    const query = String(getSingleQueryValue(req.query.q) || "").trim();
    const category = String(getSingleQueryValue(req.query.category) || "").trim();
    const shouldPaginate = pageRaw !== undefined || limitRaw !== undefined || Boolean(query) || Boolean(category);

    if (!shouldPaginate) {
      return res.json({ posts, availableCategories });
    }

    const page = parsePositiveInteger(pageRaw, 1);
    const limit = parsePositiveInteger(limitRaw, 15, 50);
    const filteredPosts = filterBlogPosts(posts, { query, category });
    const totalItems = filteredPosts.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / limit));
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * limit;
    const pagePosts = filteredPosts.slice(offset, offset + limit);

    return res.json({
      posts: pagePosts,
      availableCategories,
      pagination: {
        page: safePage,
        limit,
        totalItems,
        totalPages,
        hasPrevPage: safePage > 1,
        hasNextPage: safePage < totalPages,
      },
    });
  } catch (error) {
    console.error("Error leyendo noticias:", error);
    return res.status(500).json({
      message: "No se pudieron cargar las noticias.",
    });
  }
});

app.get("/api/blog-posts/:id", async (req, res) => {
  try {
    const post = await getBlogPostById(req.params.id);

    if (!post) {
      return res.status(404).json({
        message: "No se encontró la noticia solicitada.",
      });
    }

    return res.json({ post });
  } catch (error) {
    console.error("Error leyendo noticia:", error);
    return res.status(500).json({
      message: "No se pudo cargar la noticia.",
    });
  }
});

app.get("/api/blog-image", async (req, res) => {
  const sourceUrl = String(getSingleQueryValue(req.query.src) || "").trim();
  if (!sourceUrl) {
    return res.status(400).json({
      message: "Debes indicar la imagen en el parámetro src.",
    });
  }

  const sourcePath = resolveUploadedImagePath(sourceUrl);
  if (!sourcePath) {
    return res.status(400).json({
      message: "Solo se permiten imágenes internas de /uploads/.",
    });
  }

  const requestedWidth = parsePositiveInteger(req.query.w, 960, MAX_OPTIMIZED_IMAGE_WIDTH);
  const requestedQuality = normalizeOptimizedImageQuality(req.query.q);
  const requestedFormat = normalizeOptimizedImageFormat(req.query.fm);
  try {
    const sourceFile = await findExistingUploadedImage(sourceUrl);
    if (!sourceFile) {
      return res.status(404).json({
        message: "No se encontró la imagen solicitada.",
      });
    }
    const sourceExtension = path.extname(sourceFile.filePath).toLowerCase();

    if (!sharp || sourceExtension === ".svg" || sourceExtension === ".gif") {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      return res.sendFile(sourceFile.filePath);
    }

    const variant = await createOptimizedImageVariant({
      sourcePath: sourceFile.filePath,
      sourceStats: sourceFile.stats,
      width: requestedWidth,
      quality: requestedQuality,
      format: requestedFormat,
    });

    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.type(variant.contentType);
    return res.sendFile(variant.filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return res.status(404).json({
        message: "No se encontró la imagen solicitada.",
      });
    }

    console.error("Error optimizando imagen del blog:", error);
    return res.status(500).json({
      message: "No se pudo procesar la imagen solicitada.",
    });
  }
});

app.get("/reporteros.html", (_req, res) => {
  return res.status(404).send("No disponible.");
});

app.get("/reporteros.js", (_req, res) => {
  return res.status(404).send("No disponible.");
});

app.get(REPORTER_PORTAL_PATH, (_req, res) => {
  setNoIndexHeaders(res);
  return res.sendFile(REPORTER_HTML_PATH);
});

app.get("/_internal/reporteros.js", (_req, res) => {
  setNoIndexHeaders(res);
  return res.sendFile(REPORTER_JS_PATH);
});

app.get("/api/reporter/session", (req, res) => {
  res.json({
    authenticated: isReporterAuthenticated(req),
  });
});

app.post("/api/reporter/login", withRateLimit("reporter-login", RATE_LIMIT_CONFIG.reporterLogin), (req, res) => {
  if (!REPORTER_PASSWORD) {
    return res.status(503).json({
      message: "El acceso de reporteros no está configurado en el servidor.",
    });
  }

  const password = String(req.body?.password || "");
  const isValid = safeCompareText(password, REPORTER_PASSWORD);

  if (!isValid) {
    return res.status(401).json({
      message: "Credenciales inválidas.",
    });
  }

  const token = createReporterToken();
  setReporterCookie(res, token);

  return res.json({
    ok: true,
    message: "Sesión iniciada.",
  });
});

app.post("/api/reporter/logout", (_req, res) => {
  clearReporterCookie(res);
  return res.json({ ok: true });
});

app.post(
  "/api/reporter/upload-image",
  requireReporterAuth,
  withRateLimit("reporter-write", RATE_LIMIT_CONFIG.reporterWrite),
  async (req, res) => {
  const fileName = String(req.body?.fileName || "");
  const mimeType = String(req.body?.mimeType || "").toLowerCase().trim();
  const dataBase64 = String(req.body?.dataBase64 || "").trim();

  if (mimeType && !IMAGE_EXT_BY_MIME[mimeType]) {
    return res.status(400).json({
      message: "Formato de imagen no soportado. Usa JPG, PNG, WEBP o GIF.",
    });
  }

  if (!dataBase64) {
    return res.status(400).json({
      message: "La imagen está vacía o incompleta.",
    });
  }

  let imageBuffer;
  try {
    imageBuffer = Buffer.from(dataBase64, "base64");
  } catch (_error) {
    return res.status(400).json({
      message: "No se pudo decodificar la imagen enviada.",
    });
  }

  if (!imageBuffer.length) {
    return res.status(400).json({
      message: "La imagen está vacía.",
    });
  }

  if (imageBuffer.length > MAX_IMAGE_UPLOAD_BYTES) {
    return res.status(400).json({
      message: "La imagen supera el límite permitido de 4MB.",
    });
  }

  const detectedMime = detectImageMime(imageBuffer);
  if (!detectedMime || !IMAGE_EXT_BY_MIME[detectedMime]) {
    return res.status(400).json({
      message: "No se detectó una imagen válida. Usa JPG, PNG, WEBP o GIF reales.",
    });
  }

  if (mimeType && mimeType !== detectedMime) {
    return res.status(400).json({
      message: "El tipo de archivo no coincide con el contenido real de la imagen.",
    });
  }

  try {
    await fs.mkdir(UPLOADS_DIR, { recursive: true });

    let optimizedUpload = {
      buffer: imageBuffer,
      mimeType: detectedMime,
    };
    try {
      optimizedUpload = await optimizeUploadedImageBuffer(imageBuffer, detectedMime);
    } catch (error) {
      console.warn("No se pudo optimizar la imagen subida; se guardará el archivo original.", error);
    }

    const finalMime = IMAGE_EXT_BY_MIME[optimizedUpload.mimeType] ? optimizedUpload.mimeType : detectedMime;
    const extension = IMAGE_EXT_BY_MIME[finalMime];
    const baseName = sanitizeUploadBaseName(fileName);
    const unique = crypto.randomBytes(5).toString("hex");
    const finalName = `${Date.now()}-${unique}-${baseName}.${extension}`;
    const absolutePath = path.join(UPLOADS_DIR, finalName);

    await fs.writeFile(absolutePath, optimizedUpload.buffer);

    return res.status(201).json({
      ok: true,
      url: `/uploads/${finalName}`,
    });
  } catch (error) {
    console.error("Error subiendo imagen de noticia:", error);
    return res.status(500).json({
      message: "No se pudo guardar la imagen en el servidor.",
    });
  }
});

app.post(
  "/api/reporter/posts",
  requireReporterAuth,
  withRateLimit("reporter-write", RATE_LIMIT_CONFIG.reporterWrite),
  async (req, res) => {
  const parsed = blogPostCreateSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      message: "Hay campos inválidos o incompletos en la noticia.",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  try {
    const post = await createBlogPost(parsed.data);
    return res.status(201).json({ ok: true, post });
  } catch (error) {
    console.error("Error creando noticia:", error);
    return res.status(500).json({
      message: "No se pudo guardar la noticia.",
    });
  }
});

app.delete(
  "/api/reporter/posts/:id",
  requireReporterAuth,
  withRateLimit("reporter-write", RATE_LIMIT_CONFIG.reporterWrite),
  async (req, res) => {
  try {
    const removed = await deleteBlogPostById(req.params.id);

    if (!removed) {
      return res.status(404).json({
        message: "No se encontró la noticia a eliminar.",
      });
    }

    const uploadedImagePaths = resolveUploadedImageCandidatePaths(removed.image);
    if (uploadedImagePaths.length) {
      for (const uploadedImagePath of uploadedImagePaths) {
        try {
          await fs.unlink(uploadedImagePath);
        } catch (error) {
          if (error && error.code !== "ENOENT") {
            console.error("Error eliminando imagen de noticia:", error);
          }
        }
      }

      try {
        await purgeImageVariantsForUpload(removed.image);
      } catch (error) {
        console.error("Error eliminando variantes optimizadas:", error);
      }
    }

    return res.json({
      ok: true,
      removedId: removed.id,
    });
  } catch (error) {
    console.error("Error eliminando noticia:", error);
    return res.status(500).json({
      message: "No se pudo eliminar la noticia.",
    });
  }
});

app.post("/api/generate-visa-pdf", withRateLimit("visa-pdf", RATE_LIMIT_CONFIG.generatePdf), async (req, res) => {
  if (!RECAPTCHA_ENABLED) {
    return res.status(503).json({
      message: "Protección anti-bots no disponible temporalmente. Inténtalo más tarde.",
    });
  }

  const rawBody = req.body && typeof req.body === "object" ? req.body : {};
  const recaptchaToken = String(rawBody.recaptchaToken || "").trim();
  const recaptchaCheck = await verifyRecaptchaV3Token(recaptchaToken, getClientIp(req));

  if (!recaptchaCheck.ok) {
    const recaptchaErrors = Array.isArray(recaptchaCheck.body?.["error-codes"])
      ? recaptchaCheck.body["error-codes"].join(",")
      : "none";
    console.warn(
      `[security] Solicitud bloqueada por reCAPTCHA. reason=${recaptchaCheck.reason} action=${String(recaptchaCheck.body?.action || "n/a")} score=${String(recaptchaCheck.body?.score || "n/a")} errors=${recaptchaErrors}`
    );
    let statusCode = 403;
    let message = "No se pudo validar la solicitud. Inténtalo de nuevo.";

    if (recaptchaCheck.reason === "missing_token") {
      statusCode = 400;
      message = "No se recibió validación anti-bots. Recarga la página e inténtalo nuevamente.";
    }

    if (["request_failed", "google_http_error", "invalid_json"].includes(recaptchaCheck.reason)) {
      statusCode = 503;
      message = "No se pudo validar protección anti-bots temporalmente. Inténtalo en unos minutos.";
    }

    return res.status(statusCode).json({ message });
  }

  const formPayload = { ...rawBody };
  delete formPayload.recaptchaToken;
  const parsed = visaFormSchema.safeParse(formPayload);

  if (!parsed.success) {
    return res.status(400).json({
      message: "Hay campos inválidos o incompletos.",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  try {
    const pdfBuffer = await fillVisaPdf(parsed.data);

    const safePassport = String(parsed.data.numeroPasaporte || "solicitud")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 16);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="solicitud_visa_${safePassport || "generada"}.pdf"`
    );

    return res.send(pdfBuffer);
  } catch (error) {
    console.error("Error generando PDF:", error);
    return res.status(500).json({
      message: "No se pudo generar el PDF. Inténtalo de nuevo.",
    });
  }
});

app.use((_req, res) => {
  return res.status(404).type("text/plain; charset=utf-8").send("Página no encontrada.");
});

app.listen(port, () => {
  console.log(`Servidor activo en http://localhost:${port}`);
  console.log(`[reporteros] Ruta interna del panel: ${REPORTER_PORTAL_PATH}`);
  console.log(`[blog] Directorio de uploads: ${UPLOADS_DIR}`);
});
