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
    submitBtn.disabled = false;
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
  fileList.innerHTML = selectedFiles
    .map((f) => {
      const mb = (f.size / (1024 * 1024)).toFixed(2);
      return `<li>${f.name} <span>(${mb} MB)</span></li>`;
    })
    .join("");
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
  setLoginStatus("Validando con Plane…");
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
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
  }
});

logoutBtn.addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
  showLogin();
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
  setStatus("");

  if (!currentUser) {
    showLogin();
    setLoginStatus("Tenés que estar logueado en Plane.", "err");
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

  submitBtn.disabled = true;
  setStatus("Analizando y creando ticket en Plane vía MCP…");

  try {
    const res = await fetch("/api/tickets", {
      method: "POST",
      credentials: "same-origin",
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
    const url = data.plane?.url;
    setStatus(
      url
        ? `Listo: ${id} — ${url}`
        : `Listo: ${data.message}`,
      "ok"
    );
    form.reset();
    document.getElementById("prioridad").value = "media";
    selectedFiles = [];
    renderFiles();
  } catch (err) {
    if (!String(err.message).includes("autenticado")) {
      setStatus(err.message || "Error al crear el ticket", "err");
    }
  } finally {
    submitBtn.disabled = false;
  }
});

renderSide();
checkAuth();
