function normalizePathname(pathname) {
  const clean = String(pathname || "").trim();
  if (!clean) return "/";
  if (clean === "/index.html") return "/";
  return clean.endsWith("/") && clean !== "/" ? clean.slice(0, -1) : clean;
}

function toAbsolutePath(href) {
  const raw = String(href || "").trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw, window.location.origin);
    return normalizePathname(parsed.pathname);
  } catch (_error) {
    return "";
  }
}

function markCurrentNavigationLink() {
  const currentPath = normalizePathname(window.location.pathname);
  const currentIsBlog = currentPath === "/" || currentPath === "/blog.html";
  const selectors = ".hero-nav a, .footer-links a";
  const links = document.querySelectorAll(selectors);

  links.forEach((link) => {
    const linkPath = toAbsolutePath(link.getAttribute("href"));
    if (!linkPath) return;

    const matches =
      currentPath === linkPath ||
      (linkPath === "/" && currentPath === "/noticia.html") ||
      (linkPath === "/" && currentIsBlog);

    if (matches) {
      link.classList.add("is-current");
      link.setAttribute("aria-current", "page");
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", markCurrentNavigationLink, { once: true });
} else {
  markCurrentNavigationLink();
}
