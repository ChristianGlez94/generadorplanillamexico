const blogSearch = document.getElementById("blogSearch");
const blogCategories = document.getElementById("blogCategories");
const blogCount = document.getElementById("blogCount");
const blogLastUpdate = document.getElementById("blogLastUpdate");
const featuredPost = document.getElementById("featuredPost");
const blogList = document.getElementById("blogList");
const blogRandomBtn = document.getElementById("blogRandomBtn");
const blogRandomResult = document.getElementById("blogRandomResult");
const blogPagination = document.getElementById("blogPagination");
const blogPageInfo = document.getElementById("blogPageInfo");
const blogPrevBtn = document.getElementById("blogPrevBtn");
const blogNextBtn = document.getElementById("blogNextBtn");
const blogPaginationLinks = document.getElementById("blogPaginationLinks");

if (
  blogSearch &&
  blogCategories &&
  blogCount &&
  blogLastUpdate &&
  featuredPost &&
  blogList &&
  blogRandomBtn &&
  blogRandomResult &&
  blogPagination &&
  blogPageInfo &&
  blogPrevBtn &&
  blogNextBtn
) {
  const state = {
    posts: [],
    query: "",
    category: "Todas",
    page: readInitialPageFromUrl(),
    pageSize: 15,
    totalItems: 0,
    totalPages: 1,
    hasPrevPage: false,
    hasNextPage: false,
    availableCategories: [],
    requestId: 0,
    loading: false,
  };

  init();
  setupCardInteractions(featuredPost);
  setupCardInteractions(blogList);

  const applySearch = debounce((value) => {
    state.query = String(value || "");
    state.page = 1;
    loadAndRenderPosts();
  }, 260);

  blogSearch.addEventListener("input", (event) => {
    applySearch(event.target.value);
  });

  blogCategories.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-category]");
    if (!button) return;

    const nextCategory = String(button.dataset.category || "Todas");
    if (nextCategory === state.category) return;

    state.category = nextCategory;
    state.page = 1;
    loadAndRenderPosts();
  });

  blogPrevBtn.addEventListener("click", () => {
    if (state.loading || !state.hasPrevPage) return;
    state.page = Math.max(1, state.page - 1);
    loadAndRenderPosts();
  });

  blogNextBtn.addEventListener("click", () => {
    if (state.loading || !state.hasNextPage) return;
    state.page += 1;
    loadAndRenderPosts();
  });

  blogRandomBtn.addEventListener("click", () => {
    if (!state.posts.length) {
      blogRandomResult.textContent = "No hay noticias disponibles con el filtro actual.";
      return;
    }

    const randomPost = state.posts[Math.floor(Math.random() * state.posts.length)];
    const url = buildPostDetailUrl(randomPost.id);
    blogRandomResult.innerHTML = `Sugerencia: <a href="${url}">${escapeHtml(randomPost.title)}</a>`;
  });

  async function init() {
    const hasServerRenderedFeatured = featuredPost.children.length > 0;
    const hasServerRenderedList = blogList.children.length > 0;
    const hasServerRenderedStats =
      blogCount.textContent.trim() !== "0 noticias" ||
      blogLastUpdate.textContent.trim() !== "Última actualización: --";

    if (!hasServerRenderedFeatured && !hasServerRenderedList) {
      featuredPost.innerHTML = '<p class="blog-empty">Cargando contenido...</p>';
      blogList.innerHTML = "";
    }

    if (!hasServerRenderedStats) {
      blogCount.textContent = "Cargando noticias...";
      blogLastUpdate.textContent = "Última actualización: --";
    }

    renderPagination();

    await loadAndRenderPosts();
  }

  async function loadAndRenderPosts() {
    const requestId = state.requestId + 1;
    state.requestId = requestId;
    state.loading = true;
    renderPagination();

    try {
      const data = await loadPostsFromApi({
        page: state.page,
        limit: state.pageSize,
        query: state.query,
        category: state.category,
      });

      if (requestId !== state.requestId) return;

      state.posts = data.posts;
      state.page = data.pagination.page;
      state.pageSize = data.pagination.limit;
      state.totalItems = data.pagination.totalItems;
      state.totalPages = data.pagination.totalPages;
      state.hasPrevPage = data.pagination.hasPrevPage;
      state.hasNextPage = data.pagination.hasNextPage;
      state.availableCategories = data.availableCategories;
      updatePageQueryParam(state.page);

      renderCategoryButtons();
      renderStats();
      renderFeatured();
      renderList();
      renderPagination();
    } catch (error) {
      if (requestId !== state.requestId) return;

      state.posts = [];
      state.totalItems = 0;
      state.totalPages = 1;
      state.hasPrevPage = false;
      state.hasNextPage = false;

      renderCategoryButtons();
      renderStats();
      featuredPost.innerHTML = `<p class="blog-empty">${escapeHtml(error.message)}</p>`;
      blogList.innerHTML = "";
      renderPagination();
    } finally {
      if (requestId === state.requestId) {
        state.loading = false;
        renderPagination();
      }
    }
  }

  function renderStats() {
    if (!state.totalItems) {
      blogCount.textContent = "0 noticias";
      blogLastUpdate.textContent = "Última actualización: --";
      return;
    }

    const firstVisible = (state.page - 1) * state.pageSize + 1;
    const lastVisible = firstVisible + state.posts.length - 1;
    const suffix = state.totalItems === 1 ? "noticia" : "noticias";
    blogCount.textContent = `Mostrando ${firstVisible}-${Math.max(firstVisible, lastVisible)} de ${state.totalItems} ${suffix}`;

    const reference = state.posts[0];
    const formatted = reference ? formatDate(reference.date) : "--";
    blogLastUpdate.textContent = `Última actualización: ${formatted}`;
  }

  function renderFeatured() {
    const post = state.posts[0];

    if (!post) {
      featuredPost.innerHTML = '<p class="blog-empty">No hay noticias para mostrar.</p>';
      return;
    }

    featuredPost.innerHTML = buildPostMarkup(post, true);
  }

  function renderList() {
    const listItems = state.posts.slice(1);

    if (!listItems.length) {
      if (state.posts.length) {
        blogList.innerHTML = '<p class="blog-empty">No hay más noticias en esta página.</p>';
      } else {
        blogList.innerHTML =
          '<p class="blog-empty">No hay noticias para este filtro. Prueba otra categoría o palabra.</p>';
      }
      return;
    }

    blogList.innerHTML = listItems.map((post) => buildPostMarkup(post, false)).join("");
  }

  function renderCategoryButtons() {
    const source = state.availableCategories.length
      ? state.availableCategories
      : [...new Set(state.posts.map((post) => post.category).filter(Boolean))];

    const categories = ["Todas", ...source];
    if (state.category !== "Todas" && !categories.includes(state.category)) {
      categories.push(state.category);
    }

    blogCategories.innerHTML = categories
      .map((category) => {
        const isActive = category === state.category;
        const activeClass = isActive ? " active" : "";
        return `<button type="button" class="blog-category-btn${activeClass}" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`;
      })
      .join("");
  }

  function renderPagination() {
    const shouldShow = state.totalItems > 0 && state.totalPages > 1;
    blogPagination.classList.toggle("hidden", !shouldShow);
    if (blogPaginationLinks) {
      blogPaginationLinks.classList.toggle("hidden", !shouldShow);
    }

    const loadingText = state.loading ? " (cargando...)" : "";
    blogPageInfo.textContent = `Página ${state.page} de ${state.totalPages}${loadingText}`;

    blogPrevBtn.disabled = state.loading || !state.hasPrevPage;
    blogNextBtn.disabled = state.loading || !state.hasNextPage;

    if (blogPaginationLinks) {
      blogPaginationLinks.innerHTML = buildCrawlerPaginationLinks({
        page: state.page,
        hasPrevPage: state.hasPrevPage,
        hasNextPage: state.hasNextPage,
      });
    }
  }

  function buildPostMarkup(post, isFeatured) {
    const reading = estimateReadingTime(post.content, post.description);
    const preview = isFeatured ? post.description : truncateText(post.description, 185);
    const tags = post.tags
      .slice(0, 3)
      .map((tag) => `<span class="blog-tag">${escapeHtml(tag)}</span>`)
      .join("");
    const wrapperClass = isFeatured ? "blog-featured-item" : "blog-card";
    const detailUrl = buildPostDetailUrl(post.id);
    const imageLoading = isFeatured ? "eager" : "lazy";
    const fetchPriority = isFeatured ? "high" : "low";
    const imageMarkup = buildPostImageMarkup({
      image: post.image,
      alt: post.alt,
      isFeatured,
      imageLoading,
      fetchPriority,
    });

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
            ${imageMarkup}
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

  function buildPostImageMarkup({ image, alt, isFeatured, imageLoading, fetchPriority }) {
    const cleanImage = String(image || "").trim();
    const safeAlt = escapeHtml(String(alt || "Imagen de la noticia"));

    if (!cleanImage) {
      return '<div class="blog-image-fallback" aria-hidden="true"></div>';
    }

    const optimized = buildOptimizedImageSources(cleanImage, isFeatured);
    if (!optimized) {
      return `
        <img
          src="${escapeHtml(cleanImage)}"
          alt="${safeAlt}"
          loading="${imageLoading}"
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
          loading="${imageLoading}"
          decoding="async"
          fetchpriority="${fetchPriority}"
        />
      </picture>
    `;
  }

  function buildOptimizedImageSources(imageUrl, isFeatured) {
    if (!isOptimizableUploadImage(imageUrl)) return null;

    const widths = isFeatured ? [480, 768, 1024, 1360] : [280, 420, 640];
    const quality = isFeatured ? 80 : 74;
    const sizes = isFeatured
      ? "(max-width: 900px) 92vw, 58vw"
      : "(max-width: 900px) 92vw, (max-width: 1120px) 44vw, 30vw";
    const webpSrcSet = widths
      .map((width) => `${buildOptimizedImageUrl(imageUrl, width, quality, "webp")} ${String(width)}w`)
      .join(", ");
    const fallbackSrcSet = widths
      .map((width) => `${buildOptimizedImageUrl(imageUrl, width, quality, "jpeg")} ${String(width)}w`)
      .join(", ");
    const fallbackWidth = widths[Math.max(0, widths.length - 2)] || widths[0];

    return {
      webpSrcSet,
      fallbackSrcSet,
      fallbackSrc: buildOptimizedImageUrl(imageUrl, fallbackWidth, quality, "jpeg"),
      sizes,
    };
  }

  function buildOptimizedImageUrl(sourceUrl, width, quality, format) {
    const params = new URLSearchParams();
    params.set("src", sourceUrl);
    params.set("w", String(width));
    params.set("q", String(quality));
    params.set("fm", format);
    return `/api/blog-image?${params.toString()}`;
  }

  function isOptimizableUploadImage(imageUrl) {
    const clean = String(imageUrl || "").trim();
    if (!clean.startsWith("/uploads/")) return false;
    return !/\.(svg|gif)(\?.*)?$/i.test(clean);
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

async function loadPostsFromApi({ page, limit, query, category }) {
  const params = new URLSearchParams();
  params.set("page", String(Math.max(1, Number(page) || 1)));
  params.set("limit", String(Math.max(1, Number(limit) || 15)));

  const trimmedQuery = String(query || "").trim();
  if (trimmedQuery) {
    params.set("q", trimmedQuery);
  }

  const trimmedCategory = String(category || "").trim();
  if (trimmedCategory && trimmedCategory !== "Todas") {
    params.set("category", trimmedCategory);
  }

  const response = await fetch(`/api/blog-posts?${params.toString()}`, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error("No se pudieron cargar las noticias.");
  }

  const data = await response.json();
  const rawPosts = Array.isArray(data?.posts) ? data.posts : [];
  const posts = rawPosts.map((post, index) => normalizePost(post, index));
  const availableCategories = Array.isArray(data?.availableCategories)
    ? data.availableCategories.map((item) => String(item || "").trim()).filter(Boolean)
    : [];

  return {
    posts,
    availableCategories,
    pagination: normalizePagination(data?.pagination, {
      requestedPage: page,
      requestedLimit: limit,
      itemCount: posts.length,
    }),
  };
}

function normalizePagination(rawPagination, fallback) {
  const requestedPage = Math.max(1, Number(fallback?.requestedPage) || 1);
  const requestedLimit = Math.max(1, Number(fallback?.requestedLimit) || 15);
  const itemCount = Math.max(0, Number(fallback?.itemCount) || 0);
  const totalItems = Math.max(itemCount, Number(rawPagination?.totalItems) || 0);
  const limit = Math.max(1, Number(rawPagination?.limit) || requestedLimit);
  const totalPages = Math.max(1, Number(rawPagination?.totalPages) || Math.ceil(totalItems / limit));
  const page = Math.min(totalPages, Math.max(1, Number(rawPagination?.page) || requestedPage));
  const hasPrevPage = page > 1;
  const hasNextPage = page < totalPages;

  return {
    page,
    limit,
    totalItems,
    totalPages,
    hasPrevPage,
    hasNextPage,
  };
}

function normalizePost(post, index) {
  const rawId = String(post?.id || `post-${index + 1}`).toLowerCase();
  const normalizedId = rawId.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const content = Array.isArray(post?.content) ? post.content.map((line) => String(line)) : [];

  return {
    id: normalizedId || `post-${index + 1}`,
    title: String(post?.title || "Noticia sin título"),
    date: String(post?.date || "1970-01-01"),
    category: String(post?.category || "General"),
    image: String(post?.image || ""),
    alt: String(post?.alt || "Imagen de la noticia"),
    description: String(post?.description || ""),
    content,
    tags: Array.isArray(post?.tags) ? post.tags.map((tag) => String(tag)) : [],
  };
}

function buildPostDetailUrl(postId) {
  const cleanId = String(postId || "").trim();
  if (!cleanId) return "/noticia.html";
  return `/noticia.html?id=${encodeURIComponent(cleanId)}`;
}

function readInitialPageFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const rawPage = String(params.get("page") || "").trim();
    const parsed = Number.parseInt(rawPage, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 1;
    return parsed;
  } catch (_error) {
    return 1;
  }
}

function buildPageHref(page) {
  const safePage = Math.max(1, Number(page) || 1);
  const params = new URLSearchParams(window.location.search);
  if (safePage <= 1) {
    params.delete("page");
  } else {
    params.set("page", String(safePage));
  }
  const query = params.toString();
  return `${window.location.pathname}${query ? `?${query}` : ""}`;
}

function updatePageQueryParam(page) {
  const nextHref = buildPageHref(page);
  const currentHref = `${window.location.pathname}${window.location.search}`;
  if (nextHref === currentHref) return;
  window.history.replaceState({}, "", nextHref);
}

function buildCrawlerPaginationLinks({ page, hasPrevPage, hasNextPage }) {
  const safePage = Math.max(1, Number(page) || 1);
  const prevMarkup = hasPrevPage
    ? `<a class="blog-page-link" href="${escapeHtml(buildPageHref(safePage - 1))}" rel="prev">Ir a la página anterior</a>`
    : '<span class="blog-page-link is-disabled">Sin página anterior</span>';
  const nextMarkup = hasNextPage
    ? `<a class="blog-page-link" href="${escapeHtml(buildPageHref(safePage + 1))}" rel="next">Ir a la página siguiente</a>`
    : '<span class="blog-page-link is-disabled">Sin página siguiente</span>';

  return `${prevMarkup}${nextMarkup}`;
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

function debounce(fn, waitMs) {
  let timeoutId = null;

  return (...args) => {
    if (timeoutId) {
      window.clearTimeout(timeoutId);
    }

    timeoutId = window.setTimeout(() => {
      timeoutId = null;
      fn(...args);
    }, waitMs);
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
