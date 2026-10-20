const path = require("path");
const express = require("express");
const multer = require("multer");
const cookieSession = require("cookie-session");
const {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");

const config = require("./lib/config");
const { loginWithPassword } = require("./lib/plane-auth");
const { listProjects } = require("./lib/plane-projects");
const { analyzeTicket } = require("./lib/llm");
const { createWorkItemViaMcp } = require("./lib/plane-mcp");
const { attachFilesToWorkItem } = require("./lib/plane-attachments");

const {
  PORT,
  SESSION_SECRET,
  SESSION_COOKIE_SECURE,
  FLOCI_ENDPOINT,
  FLOCI_BUCKET: BUCKET,
  AWS_REGION,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  PLANE_MCP_API_KEY,
  CURSOR_API_KEY,
  LLM_MODEL,
} = config;

const s3 = new S3Client({
  region: AWS_REGION,
  endpoint: FLOCI_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

const app = express();
const production = process.env.NODE_ENV === "production";
if (production) app.set("trust proxy", 1);
app.use(
  cookieSession({
    name: "nt_session",
    keys: [SESSION_SECRET],
    maxAge: 12 * 60 * 60 * 1000,
    httpOnly: true,
    secure: SESSION_COOKIE_SECURE,
    sameSite: "lax",
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function slugify(text) {
  return (
    String(text || "ticket")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "ticket"
  );
}

async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
  }
}

async function putJson(key, obj) {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: Buffer.from(JSON.stringify(obj, null, 2), "utf8"),
      ContentType: "application/json",
    })
  );
}

async function putText(key, text, contentType = "text/markdown; charset=utf-8") {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: Buffer.from(text, "utf8"),
      ContentType: contentType,
    })
  );
}

async function putFile(key, buffer, contentType) {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType || "application/octet-stream",
    })
  );
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter(_req, file, cb) {
    const ok =
      file.mimetype.startsWith("image/") || file.mimetype === "application/pdf";
    cb(ok ? null : new Error("Solo imagen o PDF (máx. 10MB)"), ok);
  },
});

function requireAuth(req, res, next) {
  if (!req.session?.user?.id) {
    return res.status(401).json({
      error: "Tenés que iniciar sesión en Plane para crear tickets.",
      code: "AUTH_REQUIRED",
    });
  }
  next();
}

app.get("/api/health", async (_req, res) => {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }), {
      abortSignal: AbortSignal.timeout(4000),
    });
    res.json({
      ok: true,
      storage: "floci-s3",
      mcpConfigured: Boolean(PLANE_MCP_API_KEY),
      llmConfigured: Boolean(CURSOR_API_KEY),
      llmModel: LLM_MODEL,
      llmProvider: "cursor-python-sdk",
    });
  } catch (err) {
    res.status(503).json({
      ok: false,
      error:
        "No se pudo comprobar el almacenamiento. Revisa la configuración y los logs del servidor.",
    });
  }
});

// Comprueba el proceso sin depender de servicios externos.
app.get("/api/live", (_req, res) => res.json({ ok: true }));

app.get("/api/me", (req, res) => {
  if (!req.session?.user?.id) {
    return res.status(401).json({ authenticated: false });
  }
  res.json({ authenticated: true, user: req.session.user });
});

app.get("/api/proyectos", requireAuth, async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try { res.json(await listProjects()); }
  catch (err) {
    console.error("projects:", err.message);
    res.status(502).json({ error: "No se pudieron cargar los proyectos de Plane. Intenta nuevamente." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email y contraseña son obligatorios." });
    }
    // Valida contra Plane (email/password). Si falla, nadie puede spamear tickets.
    const { user } = await loginWithPassword(email, password);
    req.session.user = user;
    res.json({ ok: true, user });
  } catch (err) {
    console.error("login:", err.message);
    res.status(401).json({ error: err.message || "No se pudo iniciar sesión" });
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.post("/api/tickets", requireAuth, upload.array("capturas", 10), async (req, res) => {
  try {
    if (!PLANE_MCP_API_KEY) {
      return res.status(503).json({
        error:
          "Falta PLANE_MCP_API_KEY en .env. Sin eso no se puede crear el ticket en Plane vía MCP.",
      });
    }

    const { project_id, tipo, tipoLabel, titulo, prioridad, descripcion, modulo, pasos } =
      req.body;

    if (!tipo || !titulo || !prioridad || !descripcion || !modulo || !pasos) {
      return res.status(400).json({ error: "Faltan campos obligatorios." });
    }

    if (typeof project_id !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(project_id)) {
      return res.status(400).json({ error: "Selecciona un proyecto válido." });
    }
    let projects;
    try { projects = await listProjects(); }
    catch (err) {
      console.error("projects:", err.message);
      return res.status(502).json({ error: "No se pudo validar el proyecto en Plane. Intenta nuevamente." });
    }
    const project = projects.find(item => item.id === project_id);
    if (!project) return res.status(400).json({ error: "El proyecto seleccionado ya no está disponible en este workspace." });
    await ensureBucket();

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const folderName = `${stamp}_${slugify(titulo)}`;
    const prefix = `${folderName}/`;

    const savedFiles = [];
    const filesForLlm = [];
    for (const file of req.files || []) {
      const safe = file.originalname.replace(/[<>:"/\\|?*]/g, "_");
      const key = `${prefix}capturas/${safe}`;
      await putFile(key, file.buffer, file.mimetype);
      const meta = {
        nombre: safe,
        key,
        s3Uri: `s3://${BUCKET}/${key}`,
        url: `${FLOCI_ENDPOINT}/${BUCKET}/${key}`,
        mime: file.mimetype,
        bytes: file.size,
      };
      savedFiles.push(meta);
      filesForLlm.push({ ...meta, buffer: file.buffer });
    }

    const form = {
      project_id,
      project,
      tipo,
      tipoLabel,
      titulo: String(titulo).trim(),
      prioridad,
      descripcion: String(descripcion).trim(),
      modulo: String(modulo).trim(),
      pasos: String(pasos).trim(),
    };

    const reporter = req.session.user;
    const template = await analyzeTicket(form, filesForLlm, reporter);
    const planeIssue = await createWorkItemViaMcp(template);

    // Attachments en el work item (lo que pidió el jefe: ver la imagen en Plane).
    // Floci S3 queda como backup/copia; lo importante para TI es el attach.
    const planeAttachments = await attachFilesToWorkItem(
      planeIssue.project_id,
      planeIssue.id,
      filesForLlm
    );
    planeIssue.attachments = planeAttachments;

    const ticket = {
      id: folderName,
      creadoEn: new Date().toISOString(),
      ...form,
      capturas: savedFiles,
      reporter,
      analysis: {
        source: template.analysis_source,
        summary: template.summary,
        model: template.model || null,
        project: template.project_identifier,
        priority: template.priority,
      },
      plane: planeIssue,
      storage: {
        provider: "floci+plane-attachment",
        endpoint: FLOCI_ENDPOINT,
        bucket: BUCKET,
        prefix,
      },
    };

    await putJson(`${prefix}ticket.json`, ticket);
    await putText(
      `${prefix}template.html`,
      template.description_html,
      "text/html; charset=utf-8"
    );

    const md = [
      `# ${planeIssue.identifier}: ${template.name}`,
      "",
      `- **Plane:** ${planeIssue.url}`,
      `- **Proyecto:** ${template.project_identifier}`,
      `- **Prioridad:** ${template.priority}`,
      `- **Análisis:** ${template.analysis_source}`,
      `- **Reportado por:** ${reporter.display_name} (${reporter.email})`,
      `- **Floci:** \`s3://${BUCKET}/${prefix}\``,
      "",
      template.summary || "",
      "",
    ].join("\n");
    await putText(`${prefix}ticket.md`, md);

    res.json({
      ok: true,
      ticket,
      plane: planeIssue,
      analysis: ticket.analysis,
      message: `Ticket ${planeIssue.identifier} creado en Plane`,
    });
  } catch (err) {
    console.error(err);
    const hint = /ECONNREFUSED|connect/i.test(err.message || "")
      ? " Revisá Floci (4566) y el MCP Plane (8211)."
      : "";
    res.status(500).json({ error: (err.message || "Error al crear ticket") + hint });
  }
});

app.listen(PORT, config.HOST, async () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log("");
  console.log("Nuevo Ticket listo");
  console.log(`  App:      ${url}`);
  console.log(`  Floci S3: ${FLOCI_ENDPOINT}`);
  console.log(`  Bucket:   ${BUCKET}`);
  console.log(`  MCP:      ${config.PLANE_MCP_URL}`);
  console.log(`  MCP key:  ${PLANE_MCP_API_KEY ? "OK" : "FALTA (.env)"}`);
  console.log(
    `  LLM:      ${CURSOR_API_KEY ? `Cursor Python SDK (model=${LLM_MODEL})` : "plantilla local (sin CURSOR_API_KEY)"}`
  );
  console.log("");
  try {
    await ensureBucket();
    console.log(`  Bucket "${BUCKET}" OK`);
  } catch (err) {
    console.log(`  AVISO: Floci no responde (${err.message})`);
  }
  console.log("");
  if (production || process.env.OPEN_BROWSER === "false") return;
  try {
    const open = (await import("open")).default;
    await open(url);
  } catch {
    /* ignore */
  }
});
