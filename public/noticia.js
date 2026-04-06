const newsDetail = document.getElementById("newsDetail");
const relatedNews = document.getElementById("relatedNews");

if (newsDetail && relatedNews) {
  initDetailPage();
}

async function initDetailPage() {
  const params = new URLSearchParams(window.location.search);
  const postId = String(params.get("id") || "").trim();

  if (!postId) {
    newsDetail.innerHTML = '<p class="blog-empty">No se especifico la noticia a consultar.</p>';
    relatedNews.innerHTML = "";
    return;
  }

  try {
    const [post, list] = await Promise.all([loadPost(postId), loadPostList()]);
    renderPost(post);
    renderRelated(post, list);
  } catch (error) {
    newsDetail.innerHTML = `<p class="blog-empty">${escapeHtml(error.message)}</p>`;
    relatedNews.innerHTML = "";
  }
}

async function loadPost(postId) {
  const response = await fetch(`/api/blog-posts/${encodeURIComponent(postId)}`, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error("No fue posible abrir la noticia solicitada.");
  }

  const data = await response.json();
  if (!data?.post) {
    throw new Error("La noticia no esta disponible.");
  }

  return normalizePost(data.post);
}

async function loadPostList() {
  const response = await fetch("/api/blog-posts", {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    return [];
  }

  const data = await response.json();
  const posts = Array.isArray(data?.posts) ? data.posts : [];
  return posts.map(normalizePost);
}

function renderPost(post) {
  const paragraphs = Array.isArray(post.content) && post.content.length
    ? post.content
    : [post.description];

  const tags = post.tags
    .map((tag) => `<span class="blog-tag">${escapeHtml(tag)}</span>`)
    .join("");

  document.title = `${post.title} | Blog`;

  newsDetail.innerHTML = `
    <div class="blog-detail-meta">
      <span class="blog-chip">${escapeHtml(post.category)}</span>
      <span class="blog-date">${escapeHtml(formatDate(post.date))}</span>
    </div>
    <h2>${escapeHtml(post.title)}</h2>
    <figure class="blog-detail-image">
      <img src="${escapeHtml(post.image)}" alt="${escapeHtml(post.alt)}" loading="eager" />
    </figure>
    <p class="blog-detail-summary">${escapeHtml(post.description)}</p>
    <div class="blog-detail-content">
      ${paragraphs.map((line) => `<p>${escapeHtml(String(line))}</p>`).join("")}
    </div>
    <div class="blog-tags">${tags}</div>
  `;
}

function renderRelated(currentPost, list) {
  const related = list
    .filter((item) => item.id !== currentPost.id)
    .sort((a, b) => parseDate(b.date) - parseDate(a.date))
    .slice(0, 3);

  if (!related.length) {
    relatedNews.innerHTML = '<p class="blog-empty">No hay mas noticias para mostrar por ahora.</p>';
    return;
  }

  relatedNews.innerHTML = related
    .map((post) => {
      const url = `/noticia.html?id=${encodeURIComponent(post.id)}`;
      return `
        <article class="related-news-card">
          <h3><a class="blog-title-link" href="${url}">${escapeHtml(post.title)}</a></h3>
          <p>${escapeHtml(post.description)}</p>
          <a class="blog-open-link" href="${url}">Leer completa</a>
        </article>
      `;
    })
    .join("");
}

function normalizePost(post) {
  return {
    id: String(post?.id || "").trim(),
    title: String(post?.title || "Noticia"),
    date: String(post?.date || "1970-01-01"),
    category: String(post?.category || "General"),
    image: String(post?.image || ""),
    alt: String(post?.alt || "Imagen de la noticia"),
    description: String(post?.description || ""),
    content: Array.isArray(post?.content) ? post.content.map((line) => String(line)) : [],
    tags: Array.isArray(post?.tags) ? post.tags.map((tag) => String(tag)) : [],
  };
}

function parseDate(value) {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return new Date("1970-01-01");
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
