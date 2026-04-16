const newsDetail = document.getElementById("newsDetail");
const relatedNews = document.getElementById("relatedNews");

if (newsDetail && relatedNews) {
  initDetailPage();
}

async function initDetailPage() {
  const params = new URLSearchParams(window.location.search);
  const postId = String(params.get("id") || "").trim();

  if (!postId) {
    newsDetail.innerHTML = '<p class="blog-empty">No se especificó la noticia a consultar.</p>';
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
    throw new Error("La noticia no está disponible.");
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
  const reading = estimateReadingTime(paragraphs, post.description);

  const tags = post.tags
    .map((tag) => `<span class="blog-tag">${escapeHtml(tag)}</span>`)
    .join("");

  document.title = `${post.title} | Blog`;

  newsDetail.innerHTML = `
    <div class="blog-detail-meta">
      <span class="blog-chip">${escapeHtml(post.category)}</span>
      <span class="blog-date">${escapeHtml(formatDate(post.date))}</span>
      <span class="blog-reading">${reading} min de lectura</span>
      <span class="blog-date">Autor: Equipo editorial</span>
    </div>
    <h2>${escapeHtml(post.title)}</h2>
    <figure class="blog-detail-image">
      ${buildDetailImageMarkup(post.image, post.alt)}
    </figure>
    <p class="blog-detail-summary">${escapeHtml(post.description)}</p>
    <div class="blog-detail-content">
      ${paragraphs.map((line) => `<p>${linkifyText(line)}</p>`).join("")}
    </div>
    <div class="blog-tags">${tags}</div>
  `;
}

function buildDetailImageMarkup(imageUrl, altText) {
  const cleanImage = String(imageUrl || "").trim();
  const safeAlt = escapeHtml(String(altText || "Imagen de la noticia"));

  if (!cleanImage) {
    return '<div class="blog-image-fallback" aria-hidden="true"></div>';
  }

  const optimized = buildOptimizedImageSources(cleanImage);
  if (!optimized) {
    return `<img src="${escapeHtml(cleanImage)}" alt="${safeAlt}" loading="eager" fetchpriority="high" decoding="async" />`;
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
        loading="eager"
        fetchpriority="high"
        decoding="async"
      />
    </picture>
  `;
}

function buildOptimizedImageSources(imageUrl) {
  if (!isOptimizableUploadImage(imageUrl)) return null;

  const widths = [720, 1024, 1360, 1680];
  const quality = 80;
  const sizes = "(max-width: 900px) 92vw, 78vw";
  const webpSrcSet = widths
    .map((width) => `${buildOptimizedImageUrl(imageUrl, width, quality, "webp")} ${String(width)}w`)
    .join(", ");
  const fallbackSrcSet = widths
    .map((width) => `${buildOptimizedImageUrl(imageUrl, width, quality, "jpeg")} ${String(width)}w`)
    .join(", ");

  return {
    webpSrcSet,
    fallbackSrcSet,
    fallbackSrc: buildOptimizedImageUrl(imageUrl, widths[1], quality, "jpeg"),
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

function linkifyText(value) {
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
    const { cleanUrl, suffix } = splitTrailingUrlPunctuation(rawUrl);

    html += linkifyPlainText(input.slice(lastIndex, offset));
    html += cleanUrl ? buildExternalLink(cleanUrl, linkText || cleanUrl) : escapeHtml(rawMatch);

    if (suffix) {
      html += escapeHtml(suffix);
    }

    lastIndex = offset + rawMatch.length;
    match = markdownLinkPattern.exec(input);
  }

  html += linkifyPlainText(input.slice(lastIndex));
  return html;
}

function linkifyPlainText(value) {
  const input = String(value || "");
  const urlPattern = /https?:\/\/[^\s<>"']+/gi;
  let html = "";
  let lastIndex = 0;
  let match = urlPattern.exec(input);

  while (match) {
    const rawUrl = String(match[0] || "");
    const offset = Number(match.index || 0);
    const { cleanUrl, suffix } = splitTrailingUrlPunctuation(rawUrl);

    html += escapeHtml(input.slice(lastIndex, offset));

    html += cleanUrl ? buildExternalLink(cleanUrl, cleanUrl) : escapeHtml(rawUrl);

    if (suffix) {
      html += escapeHtml(suffix);
    }

    lastIndex = offset + rawUrl.length;
    match = urlPattern.exec(input);
  }

  html += escapeHtml(input.slice(lastIndex));
  return html;
}

function buildExternalLink(url, label) {
  const safeUrl = escapeHtml(String(url || ""));
  const safeLabel = escapeHtml(String(label || ""));
  return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`;
}

function splitTrailingUrlPunctuation(url) {
  let cleanUrl = String(url || "");
  let suffix = "";

  while (/[),.;:!?]$/.test(cleanUrl)) {
    suffix = cleanUrl.slice(-1) + suffix;
    cleanUrl = cleanUrl.slice(0, -1);
  }

  return { cleanUrl, suffix };
}

function renderRelated(currentPost, list) {
  const related = list
    .filter((item) => item.id !== currentPost.id)
    .sort((a, b) => parseDate(b.date) - parseDate(a.date))
    .slice(0, 3);

  if (!related.length) {
    relatedNews.innerHTML = '<p class="blog-empty">No hay más noticias para mostrar por ahora.</p>';
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

function estimateReadingTime(content, description) {
  const contentText = Array.isArray(content) && content.length ? content.join(" ") : description;
  const words = String(contentText || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(words / 170));
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
  if (Number.isNaN(date.getTime())) return new Date(1970, 0, 1, 12, 0, 0, 0);
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
