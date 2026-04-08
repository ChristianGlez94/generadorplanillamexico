require('dotenv').config();
const path = require("path");
const crypto = require("crypto");
const fs = require("fs/promises");
const express = require("express");
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
const LEGACY_UPLOADS_DIR = path.join(__dirname, "public", "uploads");
const UPLOADS_DIR = BLOG_STORAGE_DIR
  ? path.join(path.resolve(BLOG_STORAGE_DIR), "uploads")
  : LEGACY_UPLOADS_DIR;
const MAX_IMAGE_UPLOAD_BYTES = 4 * 1024 * 1024;
const useSecureCookie = process.env.NODE_ENV === "production";
const IMAGE_EXT_BY_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
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
app.use((_req, res, next) => {
  // Evita servir una version antigua del formulario o JS por cache del navegador.
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "10mb" }));
app.use("/uploads", express.static(UPLOADS_DIR));
if (path.resolve(UPLOADS_DIR) !== path.resolve(LEGACY_UPLOADS_DIR)) {
  app.use("/uploads", express.static(LEGACY_UPLOADS_DIR));
}
app.use(express.static(path.join(__dirname, "public")));

async function ensureUploadsDir() {
  try {
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
  } catch (error) {
    console.error("No se pudo preparar el directorio de uploads:", error);
  }
}

void ensureUploadsDir();

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

    const extension = IMAGE_EXT_BY_MIME[detectedMime];
    const baseName = sanitizeUploadBaseName(fileName);
    const unique = crypto.randomBytes(5).toString("hex");
    const finalName = `${Date.now()}-${unique}-${baseName}.${extension}`;
    const absolutePath = path.join(UPLOADS_DIR, finalName);

    await fs.writeFile(absolutePath, imageBuffer);

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

    const uploadedImagePath = resolveUploadedImagePath(removed.image);
    if (uploadedImagePath) {
      try {
        await fs.unlink(uploadedImagePath);
      } catch (error) {
        if (error && error.code !== "ENOENT") {
          console.error("Error eliminando imagen de noticia:", error);
        }
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
  const parsed = visaFormSchema.safeParse(req.body);

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
