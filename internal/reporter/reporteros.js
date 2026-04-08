const MAX_UPLOAD_MB = 4;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

const loginForm = document.getElementById("reporterLoginForm");
const passwordInput = document.getElementById("reporterPassword");
const loginBtn = document.getElementById("reporterLoginBtn");
const logoutBtn = document.getElementById("reporterLogoutBtn");
const sessionMessage = document.getElementById("reporterSessionMessage");
const postSection = document.getElementById("reporterPostSection");
const postForm = document.getElementById("reporterPostForm");
const postBtn = document.getElementById("reporterPostBtn");
const postMessage = document.getElementById("reporterPostMessage");
const postContentInput = document.getElementById("postContent");
const insertLinkBtn = document.getElementById("insertLinkBtn");
const postDateInput = document.getElementById("postDate");
const postImageFileInput = document.getElementById("postImageFile");
const reloadPostsBtn = document.getElementById("reporterReloadPostsBtn");
const reporterPostsList = document.getElementById("reporterPostsList");

if (
  loginForm &&
  passwordInput &&
  loginBtn &&
  logoutBtn &&
  sessionMessage &&
  postSection &&
  postForm &&
  postBtn &&
  postMessage &&
  postContentInput &&
  insertLinkBtn &&
  postDateInput &&
  postImageFileInput &&
  reloadPostsBtn &&
  reporterPostsList
) {
  initReporterPage();
}

async function initReporterPage() {
  postDateInput.value = buildTodayDate();
  bindEvents();
  await refreshSession();
}

function bindEvents() {
  loginForm.addEventListener("submit", onLoginSubmit);
  logoutBtn.addEventListener("click", onLogoutClick);
  postForm.addEventListener("submit", onCreatePost);
  insertLinkBtn.addEventListener("click", onInsertLinkClick);
  reloadPostsBtn.addEventListener("click", () => {
    void loadReporterPosts();
  });
  reporterPostsList.addEventListener("click", (event) => {
    const deleteBtn = event.target.closest("button[data-delete-id]");
    if (!deleteBtn) return;
    const postId = String(deleteBtn.dataset.deleteId || "").trim();
    if (!postId) return;
    void deleteReporterPost(postId, deleteBtn);
  });
}

function onInsertLinkClick() {
  const start = Number(postContentInput.selectionStart || 0);
  const end = Number(postContentInput.selectionEnd || 0);
  const selectedText = String(postContentInput.value.slice(start, end) || "").trim();

  const rawUrl = window.prompt(
    "Pega la URL completa del enlace (debe iniciar con http:// o https://):",
    "https://"
  );
  if (rawUrl === null) return;

  const url = String(rawUrl || "").trim();
  if (!/^https?:\/\/\S+$/i.test(url)) {
    setPostMessageText("URL inválida. Debe iniciar con http:// o https://", "error");
    return;
  }

  const suggestedText = selectedText || "Fuente oficial";
  const rawLabel = window.prompt("Texto visible del enlace:", suggestedText);
  if (rawLabel === null) return;

  const label = sanitizeLinkLabel(rawLabel) || url;
  const markdownLink = `[${label}](${url})`;

  const before = postContentInput.value.slice(0, start);
  const after = postContentInput.value.slice(end);
  const needsLeftSpace = before.length > 0 && !/\s$/.test(before);
  const needsRightSpace = after.length > 0 && !/^\s/.test(after);
  const textToInsert = `${needsLeftSpace ? " " : ""}${markdownLink}${needsRightSpace ? " " : ""}`;

  postContentInput.focus();
  if (typeof postContentInput.setRangeText === "function") {
    postContentInput.setRangeText(textToInsert, start, end, "end");
  } else {
    postContentInput.value = `${before}${textToInsert}${after}`;
  }

  postContentInput.dispatchEvent(new Event("input", { bubbles: true }));
  setPostMessageText("Enlace insertado en el contenido.", "ok");
}

async function onLoginSubmit(event) {
  event.preventDefault();

  const password = passwordInput.value.trim();
  if (!password) {
    setSessionMessage("Debes escribir la contraseña.", "error");
    return;
  }

  loginBtn.disabled = true;
  setSessionMessage("Iniciando sesión...");

  try {
    const response = await fetch("/api/reporter/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.message || "No fue posible iniciar sesión.");
    }

    passwordInput.value = "";
    setSessionMessage("Sesión iniciada correctamente.", "ok");
    await refreshSession();
  } catch (error) {
    setSessionMessage(error.message || "Error iniciando sesión.", "error");
  } finally {
    loginBtn.disabled = false;
  }
}

async function onLogoutClick() {
  logoutBtn.disabled = true;
  setSessionMessage("Cerrando sesión...");

  try {
    await fetch("/api/reporter/logout", { method: "POST" });
  } catch (_error) {
    // Aunque falle la solicitud, forzamos refresco de estado.
  } finally {
    await refreshSession();
    logoutBtn.disabled = false;
  }
}

async function onCreatePost(event) {
  event.preventDefault();

  if (!postForm.checkValidity()) {
    postForm.reportValidity();
    return;
  }

  const imageFile = postImageFileInput.files && postImageFileInput.files[0];
  if (!imageFile) {
    setPostMessageText("Debes seleccionar una imagen desde la PC.", "error");
    return;
  }

  if (imageFile.size > MAX_UPLOAD_BYTES) {
    setPostMessageText(`La imagen supera el límite de ${MAX_UPLOAD_MB}MB.`, "error");
    return;
  }

  const formData = new FormData(postForm);

  postBtn.disabled = true;
  setPostMessageText("Subiendo imagen y publicando noticia...");

  try {
    const imageUrl = await uploadImageFile(imageFile);

    const payload = {
      title: String(formData.get("title") || "").trim(),
      category: String(formData.get("category") || "").trim(),
      image: imageUrl,
      alt: String(formData.get("alt") || "").trim(),
      date: String(formData.get("date") || "").trim(),
      tags: String(formData.get("tags") || "").trim(),
      description: String(formData.get("description") || "").trim(),
      content: String(formData.get("content") || "").trim(),
    };

    const response = await fetch("/api/reporter/posts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const firstIssue = data?.issues?.[0]?.message;
      throw new Error(firstIssue || data?.message || "No se pudo publicar la noticia.");
    }

    const postId = String(data?.post?.id || "");
    const detailUrl = `/noticia.html?id=${encodeURIComponent(postId)}`;

    postForm.reset();
    postDateInput.value = buildTodayDate();
    setPostMessageHtml(`Noticia publicada. <a href="${detailUrl}">Abrir noticia</a>`, "ok");
    await loadReporterPosts();
  } catch (error) {
    setPostMessageText(error.message || "No se pudo publicar la noticia.", "error");
  } finally {
    postBtn.disabled = false;
  }
}

async function uploadImageFile(file) {
  const base64 = await readFileAsBase64(file);

  const response = await fetch("/api/reporter/upload-image", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fileName: file.name,
      mimeType: file.type,
      dataBase64: base64,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.message || "No se pudo subir la imagen.");
  }

  return String(data?.url || "").trim();
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new Error("No se pudo leer la imagen seleccionada."));
    };
    reader.onload = () => {
      const raw = String(reader.result || "");
      const commaIndex = raw.indexOf(",");
      const payload = commaIndex >= 0 ? raw.slice(commaIndex + 1) : raw;
      resolve(payload);
    };
    reader.readAsDataURL(file);
  });
}

async function refreshSession() {
  try {
    const response = await fetch("/api/reporter/session", {
      headers: {
        Accept: "application/json",
      },
    });

    const data = await response.json().catch(() => ({}));
    const authenticated = Boolean(data?.authenticated);
    toggleAuthenticatedUI(authenticated);
    if (authenticated) {
      await loadReporterPosts();
    } else {
      reporterPostsList.innerHTML = "";
    }
  } catch (_error) {
    toggleAuthenticatedUI(false);
    reporterPostsList.innerHTML = "";
  }
}

function toggleAuthenticatedUI(authenticated) {
  postSection.classList.toggle("hidden", !authenticated);
  passwordInput.disabled = authenticated;
  loginBtn.classList.toggle("hidden", authenticated);
  logoutBtn.classList.toggle("hidden", !authenticated);

  if (authenticated) {
    setSessionMessage("Sesión activa: ya puedes publicar noticias.", "ok");
  } else {
    setSessionMessage("Sesión cerrada. Inicia sesión para publicar.", "");
  }
}

async function loadReporterPosts() {
  reporterPostsList.innerHTML = '<p class="blog-empty">Cargando publicaciones...</p>';

  try {
    const response = await fetch("/api/blog-posts", {
      headers: {
        Accept: "application/json",
      },
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.message || "No se pudo cargar el listado de noticias.");
    }

    const posts = Array.isArray(data?.posts) ? data.posts : [];
    if (!posts.length) {
      reporterPostsList.innerHTML = '<p class="blog-empty">No hay publicaciones registradas.</p>';
      return;
    }

    reporterPostsList.innerHTML = posts
      .map((post) => {
        const postId = String(post?.id || "").trim();
        const title = escapeHtml(String(post?.title || "Sin título"));
        const date = escapeHtml(String(post?.date || "--"));
        const category = escapeHtml(String(post?.category || "General"));
        const openUrl = `/noticia.html?id=${encodeURIComponent(postId)}`;

        return `
          <article class="reporter-post-item">
            <div>
              <h4>${title}</h4>
              <p>${date} · ${category}</p>
            </div>
            <div class="reporter-post-actions">
              <a class="blog-open-link" href="${openUrl}" target="_blank" rel="noopener noreferrer">Ver</a>
              <button type="button" class="btn-danger" data-delete-id="${escapeHtml(postId)}">Eliminar</button>
            </div>
          </article>
        `;
      })
      .join("");
  } catch (error) {
    reporterPostsList.innerHTML = `<p class="blog-empty">${escapeHtml(error.message || "Error cargando publicaciones.")}</p>`;
  }
}

async function deleteReporterPost(postId, button) {
  const approved = window.confirm(
    "Esta acción eliminará la noticia y, si aplica, su imagen subida. ¿Deseas continuar?"
  );
  if (!approved) return;

  button.disabled = true;

  try {
    const response = await fetch(`/api/reporter/posts/${encodeURIComponent(postId)}`, {
      method: "DELETE",
      headers: {
        Accept: "application/json",
      },
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.message || "No se pudo eliminar la noticia.");
    }

    setPostMessageText("Noticia eliminada correctamente.", "ok");
    await loadReporterPosts();
  } catch (error) {
    setPostMessageText(error.message || "No se pudo eliminar la noticia.", "error");
  } finally {
    button.disabled = false;
  }
}

function setSessionMessage(text, tone = "") {
  sessionMessage.textContent = text;
  sessionMessage.classList.remove("ok", "error");
  if (tone) sessionMessage.classList.add(tone);
}

function setPostMessageText(text, tone = "") {
  postMessage.textContent = text;
  postMessage.classList.remove("ok", "error");
  if (tone) postMessage.classList.add(tone);
}

function setPostMessageHtml(html, tone = "") {
  postMessage.innerHTML = html;
  postMessage.classList.remove("ok", "error");
  if (tone) postMessage.classList.add(tone);
}

function sanitizeLinkLabel(value) {
  return String(value || "")
    .replace(/\r?\n+/g, " ")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .trim();
}

function buildTodayDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
