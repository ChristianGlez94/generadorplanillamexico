const fs = require("fs/promises");
const path = require("path");

const BUNDLED_BLOG_FILE_PATH = path.join(__dirname, "blog-posts.json");
const BLOG_STORAGE_DIR = String(process.env.BLOG_STORAGE_DIR || "").trim();
const BLOG_FILE_PATH = BLOG_STORAGE_DIR
  ? path.join(path.resolve(BLOG_STORAGE_DIR), "blog-posts.json")
  : BUNDLED_BLOG_FILE_PATH;
const MAX_PARAGRAPH_CHARS = 420;
let ensureStorePromise = null;

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
}

function todayYmd() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeTags(rawTags) {
  const asText = Array.isArray(rawTags) ? rawTags.join(",") : String(rawTags || "");
  const tags = asText
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 8);

  return [...new Set(tags)];
}

function collapseSpaces(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function splitLongText(rawLine) {
  const line = collapseSpaces(rawLine);
  if (!line) return [];
  if (line.length <= MAX_PARAGRAPH_CHARS) return [line];

  const chunks = [];
  let remaining = line;

  while (remaining.length > MAX_PARAGRAPH_CHARS) {
    const candidate = remaining.slice(0, MAX_PARAGRAPH_CHARS);
    const cutAt = candidate.lastIndexOf(" ");
    const splitIndex = cutAt > Math.floor(MAX_PARAGRAPH_CHARS * 0.55) ? cutAt : MAX_PARAGRAPH_CHARS;

    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function normalizeParagraphs(rawContent, fallbackDescription) {
  if (Array.isArray(rawContent)) {
    const cleaned = rawContent.flatMap((line) => splitLongText(line)).filter(Boolean);
    if (cleaned.length) return cleaned;
  }

  const text = String(rawContent || "")
    .split(/\r?\n+/)
    .flatMap((line) => splitLongText(line))
    .filter(Boolean);

  if (text.length) return text;

  return splitLongText(fallbackDescription);
}

function sortByDateDesc(a, b) {
  const first = String(a.date || "");
  const second = String(b.date || "");

  if (first === second) {
    const firstCreated = String(a.createdAt || "");
    const secondCreated = String(b.createdAt || "");
    return secondCreated.localeCompare(firstCreated);
  }

  return second.localeCompare(first);
}

function buildIdentitySeed(item, fallbackIndex = 0) {
  return String(item?.id || item?.title || `noticia-${fallbackIndex + 1}`);
}

function buildPostIdentity(item, fallbackIndex = 0) {
  return slugify(buildIdentitySeed(item, fallbackIndex));
}

async function syncBundledPostsIntoPersistentStore() {
  if (!BLOG_STORAGE_DIR || BLOG_FILE_PATH === BUNDLED_BLOG_FILE_PATH) return;

  try {
    const [bundledRaw, storeRaw] = await Promise.all([
      fs.readFile(BUNDLED_BLOG_FILE_PATH, "utf8"),
      fs.readFile(BLOG_FILE_PATH, "utf8"),
    ]);
    const bundledParsed = JSON.parse(bundledRaw);
    const storeParsed = JSON.parse(storeRaw);

    if (!Array.isArray(bundledParsed) || !Array.isArray(storeParsed)) return;

    const knownIds = new Set(
      storeParsed.map((item, index) => buildPostIdentity(item, index)).filter(Boolean)
    );

    const missing = bundledParsed.filter((item, index) => {
      const identity = buildPostIdentity(item, index);
      if (!identity || knownIds.has(identity)) return false;
      knownIds.add(identity);
      return true;
    });

    if (!missing.length) return;

    const merged = [...missing, ...storeParsed];
    await fs.writeFile(BLOG_FILE_PATH, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  } catch (_error) {
    // No detenemos la app por fallos de sincronización automática.
  }
}

async function ensureStoreExistsInner() {
  if (BLOG_STORAGE_DIR) {
    await fs.mkdir(path.dirname(BLOG_FILE_PATH), { recursive: true });
  }

  try {
    await fs.access(BLOG_FILE_PATH);
  } catch (_error) {
    if (BLOG_FILE_PATH !== BUNDLED_BLOG_FILE_PATH) {
      try {
        const bundledRaw = await fs.readFile(BUNDLED_BLOG_FILE_PATH, "utf8");
        const bundledParsed = JSON.parse(bundledRaw);

        if (Array.isArray(bundledParsed)) {
          await fs.writeFile(BLOG_FILE_PATH, `${JSON.stringify(bundledParsed, null, 2)}\n`, "utf8");
          return;
        }
      } catch (_copyError) {
        // Si falla la copia del contenido inicial, continúa con archivo vacío.
      }
    }

    await fs.writeFile(BLOG_FILE_PATH, "[]\n", "utf8");
    return;
  }

  await syncBundledPostsIntoPersistentStore();
}

async function ensureStoreExists() {
  if (!ensureStorePromise) {
    ensureStorePromise = ensureStoreExistsInner().catch((error) => {
      ensureStorePromise = null;
      throw error;
    });
  }

  await ensureStorePromise;
}

async function readPosts() {
  await ensureStoreExists();
  const raw = await fs.readFile(BLOG_FILE_PATH, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error("El archivo de noticias no tiene un formato válido.");
  }

  return parsed
    .map((item, index) => {
      const title = String(item?.title || "").trim();
      if (!title) return null;

      const id = buildPostIdentity(item, index) || `noticia-${index + 1}`;
      const description = collapseSpaces(item?.description || "");

      return {
        id,
        title,
        date: String(item?.date || todayYmd()),
        category: String(item?.category || "General").trim(),
        image: String(item?.image || "").trim(),
        alt: String(item?.alt || "Imagen de la noticia").trim(),
        description,
        content: normalizeParagraphs(item?.content, description),
        tags: normalizeTags(item?.tags),
        createdAt: String(item?.createdAt || new Date().toISOString()),
      };
    })
    .filter(Boolean)
    .sort(sortByDateDesc);
}

async function writePosts(posts) {
  const safe = Array.isArray(posts) ? posts : [];
  await fs.writeFile(BLOG_FILE_PATH, `${JSON.stringify(safe, null, 2)}\n`, "utf8");
}

async function listBlogPosts() {
  return readPosts();
}

async function getBlogPostById(postId) {
  const safeId = slugify(postId);
  if (!safeId) return null;
  const posts = await readPosts();
  return posts.find((post) => post.id === safeId) || null;
}

async function createBlogPost(input) {
  const posts = await readPosts();
  const title = String(input.title || "").trim();
  const category = String(input.category || "").trim();
  const image = String(input.image || "").trim();
  const alt = String(input.alt || "").trim();
  const description = collapseSpaces(input.description || "");
  const date = String(input.date || todayYmd()).trim();
  const content = normalizeParagraphs(input.content, description);
  const tags = normalizeTags(input.tags);

  const baseSlug = slugify(title) || "nueva-noticia";
  let id = baseSlug;
  let counter = 2;

  while (posts.some((post) => post.id === id)) {
    id = `${baseSlug}-${counter}`;
    counter += 1;
  }

  const post = {
    id,
    title,
    date,
    category,
    image,
    alt,
    description,
    content,
    tags,
    createdAt: new Date().toISOString(),
  };

  posts.unshift(post);
  posts.sort(sortByDateDesc);
  await writePosts(posts);
  return post;
}

async function deleteBlogPostById(postId) {
  const safeId = slugify(postId);
  if (!safeId) return null;

  const posts = await readPosts();
  const index = posts.findIndex((post) => post.id === safeId);
  if (index < 0) return null;

  const [removed] = posts.splice(index, 1);
  await writePosts(posts);
  return removed;
}

module.exports = {
  listBlogPosts,
  getBlogPostById,
  createBlogPost,
  deleteBlogPostById,
};
