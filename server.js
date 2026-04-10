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
const BLOG_STORAGE_DIR = String(process.env.BLOG_STORAGE_DIR || "").trim();
const SITE_BASE_URL = String(process.env.SITE_BASE_URL || "").trim();
const ALLOWED_ORIGINS = parseAllowedOrigins(String(process.env.ALLOWED_ORIGINS || ""), SITE_BASE_URL);
const RECAPTCHA_SITE_KEY = String(process.env.RECAPTCHA_SITE_KEY || "").trim();
const RECAPTCHA_SECRET_KEY = String(process.env.RECAPTCHA_SECRET_KEY || "").trim();
const RECAPTCHA_ACTION = String(process.env.RECAPTCHA_ACTION || "generate_visa_pdf").trim() || "generate_visa_pdf";
const RECAPTCHA_MIN_SCORE = parseRecaptchaMinScore(process.env.RECAPTCHA_MIN_SCORE);
const RECAPTCHA_ENABLED = Boolean(RECAPTCHA_SITE_KEY && RECAPTCHA_SECRET_KEY);
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
  "/blog.html",
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

function resolveBaseUrl(req) {
  const configured = normalizeBaseUrl(SITE_BASE_URL);
  if (configured) return configured;

  const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();

  const protocol = forwardedProto || req.protocol || "https";
  const host = forwardedHost || req.get("host") || "localhost";
  return `${protocol}://${host}`;
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

    const staticEntries = PUBLIC_SITE_PATHS.map((pathname) => {
      const priority = pathname === "/" ? "1.0" : pathname === "/blog.html" ? "0.9" : "0.7";
      const changefreq = pathname === "/" ? "daily" : "weekly";

      return {
        loc: makeAbsoluteUrl(baseUrl, pathname),
        lastmod: nowIso,
        changefreq,
        priority,
      };
    });

    const postEntries = posts.map((post) => ({
      loc: makeAbsoluteUrl(baseUrl, `/noticia.html?id=${encodeURIComponent(post.id)}`),
      lastmod: toIsoTimestamp(post.createdAt || post.date),
      changefreq: "weekly",
      priority: "0.8",
    }));

    res.type("application/xml; charset=utf-8");
    return res.send(buildSitemapXml([...staticEntries, ...postEntries]));
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
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(port, () => {
  console.log(`Servidor activo en http://localhost:${port}`);
  console.log(`[reporteros] Ruta interna del panel: ${REPORTER_PORTAL_PATH}`);
  console.log(`[blog] Directorio de uploads: ${UPLOADS_DIR}`);
});
