const blogSearch = document.getElementById("blogSearch");
const blogCategories = document.getElementById("blogCategories");
const blogCount = document.getElementById("blogCount");
const blogLastUpdate = document.getElementById("blogLastUpdate");
const featuredPost = document.getElementById("featuredPost");
const blogList = document.getElementById("blogList");
const blogRandomBtn = document.getElementById("blogRandomBtn");
const blogRandomResult = document.getElementById("blogRandomResult");

if (
  blogSearch &&
  blogCategories &&
  blogCount &&
  blogLastUpdate &&
  featuredPost &&
  blogList &&
  blogRandomBtn &&
  blogRandomResult
) {
  const state = {
    posts: [],
    filtered: [],
    query: "",
    category: "Todas",
  };

  init();
  setupCardInteractions(featuredPost);
  setupCardInteractions(blogList);

  async function init() {
    blogCount.textContent = "Cargando noticias...";
    blogLastUpdate.textContent = "Ultima actualizacion: --";
    featuredPost.innerHTML = '<p class="blog-empty">Cargando contenido...</p>';
    blogList.innerHTML = "";

    try {
      const posts = await loadPostsFromApi();
      state.posts = posts;
      state.filtered = posts;

      renderCategoryButtons();
      applyFilters();
    } catch (error) {
      blogCount.textContent = "0 noticias";
      featuredPost.innerHTML = `<p class="blog-empty">${escapeHtml(error.message)}</p>`;
      blogList.innerHTML = "";
    }
  }

  blogSearch.addEventListener("input", (event) => {
    state.query = String(event.target.value || "");
    applyFilters();
  });

  blogCategories.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-category]");
    if (!button) return;

    state.category = button.dataset.category || "Todas";
    applyFilters();
  });

  blogRandomBtn.addEventListener("click", () => {
    if (!state.filtered.length) {
      blogRandomResult.textContent = "No hay noticias disponibles con el filtro actual.";
      return;
    }

    const randomPost = state.filtered[Math.floor(Math.random() * state.filtered.length)];
    const url = `/noticia.html?id=${encodeURIComponent(randomPost.id)}`;
    blogRandomResult.innerHTML = `Sugerencia: <a href="${url}">${escapeHtml(randomPost.title)}</a>`;
  });

  function applyFilters() {
    const query = state.query.trim().toLowerCase();
    const category = state.category;

    state.filtered = state.posts.filter((post) => {
      const textToSearch = [post.title, post.description, post.category, post.tags.join(" ")]
        .join(" ")
        .toLowerCase();

      const matchesQuery = !query || textToSearch.includes(query);
      const matchesCategory = category === "Todas" || post.category === category;
      return matchesQuery && matchesCategory;
    });

    renderCategoryButtons();
    renderStats();
    renderFeatured();
    renderList();
  }

  function renderStats() {
    const total = state.filtered.length;
    const suffix = total === 1 ? "noticia" : "noticias";
    blogCount.textContent = `${total} ${suffix}`;

    const reference = state.filtered[0] || state.posts[0];
    const formatted = reference ? formatDate(reference.date) : "--";
    blogLastUpdate.textContent = `Ultima actualizacion: ${formatted}`;
  }

  function renderFeatured() {
    const post = state.filtered[0];

    if (!post) {
      featuredPost.innerHTML = '<p class="blog-empty">No hay noticias para mostrar.</p>';
      return;
    }

    featuredPost.innerHTML = buildPostMarkup(post, true);
  }

  function renderList() {
    const listItems = state.filtered.slice(1);

    if (!listItems.length) {
      blogList.innerHTML =
        '<p class="blog-empty">No hay mas noticias para este filtro. Prueba otra categoria.</p>';
      return;
    }

    blogList.innerHTML = listItems.map((post) => buildPostMarkup(post, false)).join("");
  }

  function renderCategoryButtons() {
    const categories = ["Todas", ...new Set(state.posts.map((post) => post.category))];
    blogCategories.innerHTML = categories
      .map((category) => {
        const isActive = category === state.category;
        const activeClass = isActive ? " active" : "";
        return `<button type="button" class="blog-category-btn${activeClass}" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`;
      })
      .join("");
  }

  function buildPostMarkup(post, isFeatured) {
    const reading = estimateReadingTime(post.content, post.description);
    const preview = isFeatured ? post.description : truncateText(post.description, 185);
    const tags = post.tags
      .slice(0, 3)
      .map((tag) => `<span class="blog-tag">${escapeHtml(tag)}</span>`)
      .join("");
    const wrapperClass = isFeatured ? "blog-featured-item" : "blog-card";
    const detailUrl = `/noticia.html?id=${encodeURIComponent(post.id)}`;

    return `
      <article
        id="post-${escapeHtml(post.id)}"
        class="${wrapperClass}"
        data-detail-url="${detailUrl}"
        tabindex="0"
        role="link"
      >
        <figure class="blog-media">
          <a href="${detailUrl}" class="blog-image-link">
            <img src="${escapeHtml(post.image)}" alt="${escapeHtml(post.alt)}" loading="lazy" />
          </a>
        </figure>
        <div>
          <div class="blog-meta-line">
            <span class="blog-chip">${escapeHtml(post.category)}</span>
            <span class="blog-date">${escapeHtml(formatDate(post.date))}</span>
            <span class="blog-reading">${reading} min de lectura</span>
          </div>
          <h3><a class="blog-title-link" href="${detailUrl}">${escapeHtml(post.title)}</a></h3>
          <p>${escapeHtml(preview)}</p>
          <div class="blog-tags">${tags}</div>
          <a class="blog-open-link" href="${detailUrl}">Leer noticia completa</a>
        </div>
      </article>
    `;
  }
}

function setupCardInteractions(container) {
  container.addEventListener("click", (event) => {
    const article = event.target.closest("article[data-detail-url]");
    if (!article) return;
    if (event.target.closest("a, button")) return;

    const detailUrl = article.dataset.detailUrl;
    if (detailUrl) {
      window.location.href = detailUrl;
    }
  });

  container.addEventListener("keydown", (event) => {
    const article = event.target.closest("article[data-detail-url]");
    if (!article) return;

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const detailUrl = article.dataset.detailUrl;
      if (detailUrl) {
        window.location.href = detailUrl;
      }
    }
  });
}

async function loadPostsFromApi() {
  const response = await fetch("/api/blog-posts", {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error("No se pudieron cargar las noticias.");
  }

  const data = await response.json();
  const posts = Array.isArray(data?.posts) ? data.posts : [];

  return posts
    .map((post, index) => normalizePost(post, index))
    .sort((a, b) => parseDate(b.date) - parseDate(a.date));
}

function normalizePost(post, index) {
  const rawId = String(post?.id || `post-${index + 1}`).toLowerCase();
  const normalizedId = rawId.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const content = Array.isArray(post?.content) ? post.content.map((line) => String(line)) : [];

  return {
    id: normalizedId || `post-${index + 1}`,
    title: String(post?.title || "Noticia sin titulo"),
    date: String(post?.date || "1970-01-01"),
    category: String(post?.category || "General"),
    image: String(post?.image || ""),
    alt: String(post?.alt || "Imagen de la noticia"),
    description: String(post?.description || ""),
    content,
    tags: Array.isArray(post?.tags) ? post.tags.map((tag) => String(tag)) : [],
  };
}

function parseDate(value) {
  const raw = String(value || "").trim();
  const ymdMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymdMatch) {
    const year = Number(ymdMatch[1]);
    const monthIndex = Number(ymdMatch[2]) - 1;
    const day = Number(ymdMatch[3]);
    // Usamos medio dia local para evitar desplazamientos por zona horaria.
    return new Date(year, monthIndex, day, 12, 0, 0, 0);
  }

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return new Date(1970, 0, 1, 12, 0, 0, 0);
  }
  return date;
}

function formatDate(value) {
  const date = parseDate(value);
  try {
    return new Intl.DateTimeFormat("es-MX", { dateStyle: "long" }).format(date);
  } catch (_error) {
    return value;
  }
}

function truncateText(text, maxChars) {
  const clean = String(text || "").trim();
  if (clean.length <= maxChars) return clean;
  const slice = clean.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  return `${slice.slice(0, lastSpace > 30 ? lastSpace : maxChars).trim()}...`;
}

function estimateReadingTime(content, description) {
  const contentText = Array.isArray(content) && content.length ? content.join(" ") : description;
  const words = String(contentText || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(words / 170));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
