const TYPES = {
  incidencia: {
    label: "Reportar una incidencia",
    icon: "!",
    needs: [
      "Módulo o pantalla donde ocurrió",
      "Pasos detallados para reproducirlo",
      "Al menos una captura de pantalla",
    ],
  },
  mejora: {
    label: "Nueva función o mejora",
    icon: "↗",
    needs: [
      "Qué problema de negocio resuelve",
      "Cómo se vería el cambio ideal",
      "Prioridad aproximada para el equipo",
    ],
  },
  cliente: {
    label: "Problema de cliente",
    icon: "👤",
    needs: [
      "Nombre o código del cliente",
      "Qué reportó exactamente",
      "Captura o correo del reclamo si existe",
    ],
  },
};

const authGate = document.getElementById("auth-gate");
const appShell = document.getElementById("app-shell");
const loginForm = document.getElementById("login-form");
const loginStatus = document.getElementById("login-status");
const loginBtn = document.getElementById("login-btn");
const userLabel = document.getElementById("user-label");
const logoutBtn = document.getElementById("logout-btn");
const toggleAuth = document.getElementById("toggle-auth");
let registering = false;
let submitting = false;
let pendingSubmission = null;
const mutationHeaders = { "X-Tickets-Request": "1" };
toggleAuth.addEventListener("click", () => {
  registering = !registering;
  document.getElementById("auth-title").textContent = registering ? "Crea tu cuenta" : "Inicia sesión";
  document.getElementById("auth-description").textContent = registering ? "Regístrate para enviar tus solicitudes de soporte." : "Entra con tu cuenta para enviar una solicitud de soporte.";
  document.getElementById("register-name-field").hidden = !registering;
  document.getElementById("register-name").required = registering;
  const password = document.getElementById("login-password");
  password.autocomplete = registering ? "new-password" : "current-password";
  password.minLength = registering ? 12 : 1;
  document.getElementById("registration-hint").hidden = !registering;
  loginBtn.textContent = registering ? "Crear cuenta" : "Entrar";
  toggleAuth.textContent = registering ? "Ya tengo cuenta. Iniciar sesión" : "¿No tienes cuenta? Regístrate";
  setLoginStatus("");
});
fetch("/api/auth/config").then(response => response.json()).then(data => {
  toggleAuth.hidden = !data.registrationEnabled;
}).catch(() => {});

const form = document.getElementById("ticket-form");
const fileInput = document.getElementById("capturas");
const dropzone = document.getElementById("dropzone");
const fileList = document.getElementById("file-list");
const statusEl = document.getElementById("status");
const submitBtn = document.getElementById("submit-btn");
const sideTitle = document.getElementById("side-title");
const sideChecklist = document.getElementById("side-checklist");
const sideIcon = document.querySelector(".side-head .type-icon");

const projectSelect = document.getElementById("project_id");
const projectsStatus = document.getElementById("projects-status");
const reloadProjects = document.getElementById("reload-projects");

async function loadProjects() {
  projectSelect.disabled = true;
  submitBtn.disabled = true;
  reloadProjects.disabled = true;
  const previous = projectSelect.value;
  projectSelect.replaceChildren(new Option("Cargando proyectos...", ""));
  projectsStatus.textContent = "";
  try {
    const res = await fetch("/api/proyectos", { credentials: "same-origin", cache: "no-store" });
    const data = await res.json();
    if (res.status === 401) showLogin();
    if (!res.ok) throw new Error(data.error || "No se pudieron cargar los proyectos.");
    projectSelect.replaceChildren(new Option("Selecciona un proyecto", ""));
    for (const project of data) projectSelect.add(new Option(project.name, project.id));
    if (data.some(project => project.id === previous)) projectSelect.value = previous;
    if (!data.length) throw new Error("No hay proyectos disponibles en este workspace.");
    projectSelect.disabled = false;
    submitBtn.disabled = submitting;
  } catch (err) {
    projectSelect.replaceChildren(new Option("Sin proyectos disponibles", ""));
    projectsStatus.textContent = err.message;
  } finally { reloadProjects.disabled = false; }
}
reloadProjects.addEventListener("click", loadProjects);

let selectedType = "incidencia";
let selectedFiles = [];
let currentUser = null;

function setStatus(msg, kind = "") {
  statusEl.textContent = msg;
  statusEl.className = `status ${kind}`.trim();
}

function setLoginStatus(msg, kind = "") {
  loginStatus.textContent = msg;
  loginStatus.className = `status ${kind}`.trim();
}

function showApp(user) {
  try { pendingSubmission = JSON.parse(sessionStorage.getItem(`tickets-pending:${user.id}`)); }
  catch { pendingSubmission = null; }
  currentUser = user;
  authGate.hidden = true;
  appShell.hidden = false;
  userLabel.textContent = user.display_name || user.email;
  loadProjects();
}

function showLogin() {
  currentUser = null;
  appShell.hidden = true;
  authGate.hidden = false;
}

function renderSide() {
  const meta = TYPES[selectedType];
  sideTitle.textContent = meta.label;
  sideIcon.textContent = meta.icon;
  sideChecklist.innerHTML = meta.needs.map((n) => `<li>${n}</li>`).join("");
}

function renderFiles() {
  fileList.replaceChildren(...selectedFiles.map(file => {
    const item = document.createElement("li");
    item.textContent = `${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)`;
    return item;
  }));
}

function addFiles(fileListLike) {
  const incoming = Array.from(fileListLike || []);
  for (const file of incoming) {
    const okType =
      file.type.startsWith("image/") || file.type === "application/pdf";
    if (!okType) {
      setStatus(`Archivo no permitido: ${file.name}`, "err");
      continue;
    }
    if (file.size > 10 * 1024 * 1024) {
      setStatus(`${file.name} supera 10MB`, "err");
      continue;
    }
    if (selectedFiles.length >= 10) {
      setStatus("Máximo 10 capturas", "err");
      break;
    }
    selectedFiles.push(file);
  }
  renderFiles();
}

async function checkAuth() {
  try {
    const res = await fetch("/api/me", { credentials: "same-origin" });
    const data = await res.json();
    if (res.ok && data.authenticated) {
      showApp(data.user);
      return;
    }
  } catch {
    /* offline */
  }
  showLogin();
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setLoginStatus("");
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  if (!email || !password) {
    setLoginStatus("Completá email y contraseña.", "err");
    return;
  }
  loginBtn.disabled = true;
  toggleAuth.disabled = true;
  setLoginStatus(registering ? "Creando cuenta…" : "Iniciando sesión…");
  try {
    const res = await fetch(registering ? "/api/auth/register" : "/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { ...mutationHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name: document.getElementById("register-name").value.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Login falló");
    showApp(data.user);
    setLoginStatus("");
    document.getElementById("login-password").value = "";
  } catch (err) {
    setLoginStatus(err.message || "No se pudo entrar", "err");
  } finally {
    loginBtn.disabled = false;
    toggleAuth.disabled = false;
  }
});

logoutBtn.addEventListener("click", async () => {
  if (submitting) return;
  try {
    const response = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", headers: mutationHeaders });
    if (!response.ok) throw new Error();
    form.reset();
    selectedFiles = [];
    if (currentUser) sessionStorage.removeItem(`tickets-pending:${currentUser.id}`);
    pendingSubmission = null;
    renderFiles();
    showLogin();
  } catch { setStatus("No se pudo cerrar la sesión. Intenta nuevamente.", "err"); }
});

document.querySelectorAll(".type-card").forEach((card) => {
  card.addEventListener("click", () => {
    document.querySelectorAll(".type-card").forEach((c) => {
      c.classList.remove("is-selected");
      c.setAttribute("aria-pressed", "false");
    });
    card.classList.add("is-selected");
    card.setAttribute("aria-pressed", "true");
    selectedType = card.dataset.type;
    renderSide();
  });
});

dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  addFiles(fileInput.files);
  fileInput.value = "";
});

["dragenter", "dragover"].forEach((ev) => {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add("is-drag");
  });
});
["dragleave", "drop"].forEach((ev) => {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove("is-drag");
  });
});
dropzone.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (submitting) return;
  setStatus("");

  if (!currentUser) {
    showLogin();
    setLoginStatus("Inicia sesión para enviar tu ticket.", "err");
    return;
  }

  const project_id = projectSelect.value;
  const titulo = document.getElementById("titulo").value.trim();
  const prioridad = document.getElementById("prioridad").value;
  const descripcion = document.getElementById("descripcion").value.trim();
  const modulo = document.getElementById("modulo").value.trim();
  const pasos = document.getElementById("pasos").value.trim();

  if (!project_id || projectSelect.disabled || !titulo || !descripcion || !modulo || !pasos) {
    setStatus("Completá todos los campos obligatorios.", "err");
    return;
  }

  const body = new FormData();
  body.append("project_id", project_id);
  body.append("tipo", selectedType);
  body.append("tipoLabel", TYPES[selectedType].label);
  body.append("titulo", titulo);
  body.append("prioridad", prioridad);
  body.append("descripcion", descripcion);
  body.append("modulo", modulo);
  body.append("pasos", pasos);
  for (const file of selectedFiles) body.append("capturas", file);

  // Preserve the key for unchanged retries; server also verifies the actual bytes.
  submitting = true;
  submitBtn.disabled = true;
  logoutBtn.disabled = true;
  setStatus("Enviando tu solicitud…");

  try {
    const content = JSON.stringify([project_id, selectedType, titulo, prioridad, descripcion, modulo, pasos,
      await Promise.all(selectedFiles.map(async file => [file.name, file.type,
        Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))).join(",")]))]);
    const signature = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)))).join(",");
    if (!pendingSubmission || pendingSubmission.signature !== signature) {
      pendingSubmission = { signature, key: crypto.randomUUID() };
    }
    sessionStorage.setItem(`tickets-pending:${currentUser.id}`, JSON.stringify(pendingSubmission));
    const res = await fetch("/api/tickets", {
      method: "POST",
      credentials: "same-origin",
      headers: { ...mutationHeaders, "Idempotency-Key": pendingSubmission.key },
      body,
    });
    const data = await res.json();
    if (res.status === 401) {
      showLogin();
      setLoginStatus(data.error || "Sesión expirada. Volvé a entrar.", "err");
      throw new Error(data.error || "No autenticado");
    }
    if (!res.ok) throw new Error(data.error || "No se pudo crear");

    const id = data.plane?.identifier || data.plane?.id;
    setStatus(`Listo: ${id || data.message}. ${(data.warnings || []).join(" ")}`, "ok");
    sessionStorage.removeItem(`tickets-pending:${currentUser.id}`);
    pendingSubmission = null;
    form.reset();
    document.getElementById("prioridad").value = "media";
    selectedFiles = [];
    renderFiles();
  } catch (err) {
    if (!String(err.message).includes("autenticado")) {
      setStatus(err.message || "Error al crear el ticket", "err");
    }
  } finally {
    submitting = false;
    logoutBtn.disabled = false;
    submitBtn.disabled = projectSelect.disabled;
  }
});

renderSide();
checkAuth();
