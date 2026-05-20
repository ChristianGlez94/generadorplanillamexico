function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizePostId(value) {
  return String(value || "").trim();
}

function buildNutPostUrl(postId) {
  const cleanId = normalizePostId(postId);
  if (!cleanId) return "/noticia.html";
  return `/noticia.html?id=${encodeURIComponent(cleanId)}`;
}

function truncateText(value, maxChars = 200) {
  const clean = String(value || "").trim();
  if (!clean) return "";
  if (clean.length <= maxChars) return clean;

  const sliced = clean.slice(0, maxChars);
  const lastSpace = sliced.lastIndexOf(" ");
  const cut = lastSpace > 45 ? lastSpace : maxChars;
  return `${sliced.slice(0, cut).trim()}...`;
}

function formatNutNewsDate(value) {
  const clean = String(value || "").trim();
  if (!clean) return "--";

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean);
  if (!match) return clean;

  const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0);
  if (Number.isNaN(parsed.getTime())) return clean;

  try {
    return new Intl.DateTimeFormat("es-MX", { dateStyle: "long" }).format(parsed);
  } catch (_error) {
    return clean;
  }
}

function buildNutNewsCardMarkup(post) {
  const safePost = post || {};
  const detailUrl = buildNutPostUrl(safePost.id);
  const title = escapeHtml(safePost.title || "Noticia NUT");
  const description = escapeHtml(truncateText(safePost.description, 205));
  const category = escapeHtml(safePost.category || "Noticias NUT");
  const date = escapeHtml(formatNutNewsDate(safePost.date));

  return `
    <article class="nut-news-card">
      <div class="blog-meta-line">
        <span class="blog-chip">${category}</span>
        <span class="blog-date">${date}</span>
      </div>
      <h3><a class="blog-title-link" href="${detailUrl}">${title}</a></h3>
      <p>${description}</p>
      <a class="blog-open-link" href="${detailUrl}">Leer noticia completa</a>
    </article>
  `;
}

function setNutNewsStatus(root, message, tone = "") {
  const status = root.querySelector("[data-nut-news-status]");
  if (!status) return;
  status.textContent = message;
  status.classList.remove("ok", "error");
  if (tone) status.classList.add(tone);
}

function renderNutNewsList(root, posts) {
  const list = root.querySelector("[data-nut-news-list]");
  if (!list) return;

  if (!Array.isArray(posts) || !posts.length) {
    list.innerHTML = '<p class="blog-empty">No hay asignaciones de citas NUT publicadas por ahora.</p>';
    return;
  }

  list.innerHTML = posts.map((post) => buildNutNewsCardMarkup(post)).join("");
}

function setNutNewsCount(root, count, total) {
  const countElement = root.querySelector("[data-nut-news-count]");
  if (!countElement) return;

  if (!count) {
    countElement.textContent = "0 noticias NUT";
    return;
  }

  if (total > count) {
    countElement.textContent = `Mostrando ${count} de ${total} noticias NUT de asignaciones de citas.`;
    return;
  }

  countElement.textContent = `${count} noticias NUT de asignaciones de citas.`;
}

async function loadNutNewsForRoot(root) {
  const limit = Number.parseInt(String(root.dataset.nutNewsLimit || "4"), 10);
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : 4;
  const endpoint = `/api/blog-posts?topic=nut_assignments&page=1&limit=${safeLimit}`;

  setNutNewsStatus(root, "Cargando noticias NUT...");

  try {
    const response = await fetch(endpoint, {
      headers: {
        Accept: "application/json",
      },
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || "No se pudieron cargar las noticias NUT.");
    }

    const posts = Array.isArray(payload.posts) ? payload.posts : [];
    const totalItems = Number(payload?.pagination?.totalItems || posts.length);
    renderNutNewsList(root, posts);
    setNutNewsCount(root, posts.length, totalItems);
    setNutNewsStatus(root, "");
  } catch (error) {
    renderNutNewsList(root, []);
    setNutNewsCount(root, 0, 0);
    setNutNewsStatus(
      root,
      error?.message || "No se pudieron cargar las noticias NUT en este momento.",
      "error"
    );
  }
}

function initNutNewsPanels() {
  const roots = document.querySelectorAll("[data-nut-news-root]");
  if (!roots.length) return;

  roots.forEach((root) => {
    loadNutNewsForRoot(root);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initNutNewsPanels, { once: true });
} else {
  initNutNewsPanels();
}
