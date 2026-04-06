const path = require("path");
const crypto = require("crypto");
const fs = require("fs/promises");
const express = require("express");
const cors = require("cors");

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
const UPLOADS_DIR = path.join(__dirname, "public", "uploads");
const MAX_IMAGE_UPLOAD_BYTES = 4 * 1024 * 1024;
const useSecureCookie = process.env.NODE_ENV === "production";
const IMAGE_EXT_BY_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

if (!REPORTER_PASSWORD) {
  console.warn(
    "[reporteros] REPORTER_PASSWORD no esta configurada. El acceso de reporteros quedara bloqueado."
  );
}

if (!process.env.REPORTER_SESSION_SECRET) {
  console.warn(
    "[reporteros] REPORTER_SESSION_SECRET no esta configurada. Usa una clave larga en produccion."
  );
}

app.use(cors());
app.use((_req, res, next) => {
  // Evita servir una version antigua del formulario o JS por cache del navegador.
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

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
  const cookie = `${REPORTER_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${REPORTER_SESSION_TTL_SECONDS}${secureFlag}`;
  res.setHeader("Set-Cookie", cookie);
}

function clearReporterCookie(res) {
  const secureFlag = useSecureCookie ? "; Secure" : "";
  const cookie = `${REPORTER_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secureFlag}`;
  res.setHeader("Set-Cookie", cookie);
}

function requireReporterAuth(req, res, next) {
  if (!isReporterAuthenticated(req)) {
    return res.status(401).json({
      message: "Debes iniciar sesion en el area de reporteros.",
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

app.get("/api/blog-posts", async (_req, res) => {
  try {
    const posts = await listBlogPosts();
    return res.json({ posts });
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
        message: "No se encontro la noticia solicitada.",
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

app.post("/api/reporter/login", (req, res) => {
  if (!REPORTER_PASSWORD) {
    return res.status(503).json({
      message: "El acceso de reporteros no esta configurado en el servidor.",
    });
  }

  const password = String(req.body?.password || "");
  const isValid = safeCompareText(password, REPORTER_PASSWORD);

  if (!isValid) {
    return res.status(401).json({
      message: "Credenciales invalidas.",
    });
  }

  const token = createReporterToken();
  setReporterCookie(res, token);

  return res.json({
    ok: true,
    message: "Sesion iniciada.",
  });
});

app.post("/api/reporter/logout", (_req, res) => {
  clearReporterCookie(res);
  return res.json({ ok: true });
});

app.post("/api/reporter/upload-image", requireReporterAuth, async (req, res) => {
  const fileName = String(req.body?.fileName || "");
  const mimeType = String(req.body?.mimeType || "").toLowerCase().trim();
  const dataBase64 = String(req.body?.dataBase64 || "").trim();

  if (!IMAGE_EXT_BY_MIME[mimeType]) {
    return res.status(400).json({
      message: "Formato de imagen no soportado. Usa JPG, PNG, WEBP o GIF.",
    });
  }

  if (!dataBase64) {
    return res.status(400).json({
      message: "La imagen esta vacia o incompleta.",
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
      message: "La imagen esta vacia.",
    });
  }

  if (imageBuffer.length > MAX_IMAGE_UPLOAD_BYTES) {
    return res.status(400).json({
      message: "La imagen supera el limite permitido de 4MB.",
    });
  }

  try {
    await fs.mkdir(UPLOADS_DIR, { recursive: true });

    const extension = IMAGE_EXT_BY_MIME[mimeType];
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

app.post("/api/reporter/posts", requireReporterAuth, async (req, res) => {
  const parsed = blogPostCreateSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      message: "Hay campos invalidos o incompletos en la noticia.",
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

app.delete("/api/reporter/posts/:id", requireReporterAuth, async (req, res) => {
  try {
    const removed = await deleteBlogPostById(req.params.id);

    if (!removed) {
      return res.status(404).json({
        message: "No se encontro la noticia a eliminar.",
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

app.post("/api/generate-visa-pdf", async (req, res) => {
  const parsed = visaFormSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      message: "Hay campos invalidos o incompletos.",
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
      message: "No se pudo generar el PDF. Intente de nuevo.",
    });
  }
});

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(port, () => {
  console.log(`Servidor activo en http://localhost:${port}`);
  console.log(`[reporteros] Ruta interna del panel: ${REPORTER_PORTAL_PATH}`);
});
