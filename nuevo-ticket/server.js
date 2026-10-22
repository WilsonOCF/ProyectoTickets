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
const { PortalStore, digest } = require("./lib/portal-store");
const { installPortalAuth, requireAuth } = require("./lib/portal-auth");
const { listProjects } = require("./lib/plane-projects");
const { analyzeTicket } = require("./lib/llm");
const { createPortalWorkItem } = require("./lib/plane-bridge");
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
const portalStore = new PortalStore(config.TICKETS_DATABASE_PATH);
const inFlight = new Set();
const production = process.env.NODE_ENV === "production";
if (production) app.set("trust proxy", 1);
app.use(
  cookieSession({
    name: "nt_portal_session",
    keys: [SESSION_SECRET],
    maxAge: 12 * 60 * 60 * 1000,
    httpOnly: true,
    secure: SESSION_COOKIE_SECURE,
    sameSite: "lax",
  })
);
app.use(express.json({ limit: "1mb" }));
installPortalAuth(app, portalStore, { registrationEnabled: config.TICKETS_REGISTRATION_ENABLED });
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

app.get("/api/proyectos", requireAuth, async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try { res.json(await listProjects()); }
  catch (err) {
    console.error("projects:", err.message);
    res.status(502).json({ error: "No se pudieron cargar los proyectos de Plane. Intenta nuevamente." });
  }
});

app.post("/api/tickets", requireAuth, (req, res, next) => {
  if (!portalStore.allowAttempt(`tickets:${req.portalUser.id}`, 10, 60000)) {
    res.set("Retry-After", "60");
    return res.status(429).json({ error: "Has enviado varias solicitudes. Espera un minuto antes de reintentar." });
  }
  next();
}, upload.array("capturas", 10), async (req, res) => {
  let flightKey;
  try {
    if (!PLANE_MCP_API_KEY) {
      return res.status(503).json({
        error:
          "El servicio de soporte todavía no está configurado. Contacta al administrador.",
      });
    }

    const { project_id, tipo, titulo, prioridad, descripcion, modulo, pasos } =
      req.body;

    if (![tipo, titulo, prioridad, descripcion, modulo, pasos].every(value => typeof value === "string" && value.trim() && value.length <= 20000)
        || titulo.length > 255 || !["incidencia", "mejora", "cliente"].includes(tipo)
        || !["baja", "media", "alta", "urgente"].includes(prioridad)) {
      return res.status(400).json({ error: "Faltan campos obligatorios." });
    }

    const requestId = req.get("Idempotency-Key");
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(requestId || "")) {
      return res.status(400).json({ error: "Falta el identificador del envío. Recarga la página." });
    }
    const reporter = req.portalUser;
    const fingerprint = digest(JSON.stringify({ project_id, tipo, titulo, prioridad, descripcion, modulo, pasos,
      files: (req.files || []).map(file => [file.originalname, file.mimetype, digest(file.buffer)]) }));
    const submission = portalStore.submission(reporter.id, requestId, fingerprint);
    if (submission.result) return res.json(submission.result);
    const key = `${reporter.id}:${requestId}`;
    if (inFlight.has(key)) return res.status(409).json({ error: "Este envío sigue procesándose. Espera antes de reintentar." });
    flightKey = key;
    inFlight.add(key);

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

    const folderName = `${reporter.id}/${requestId}_${slugify(titulo)}`;
    const prefix = `${folderName}/`;

    const savedFiles = [];
    const filesForLlm = [];
    for (const [index, file] of (req.files || []).entries()) {
      const safe = file.originalname.replace(/[<>:"/\\|?*]/g, "_");
      const key = `${prefix}capturas/${index}_${safe}`;
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
      tipoLabel: { incidencia: "Incidencia", mejora: "Mejora", cliente: "Problema de cliente" }[tipo],
      titulo: String(titulo).trim(),
      prioridad,
      descripcion: String(descripcion).trim(),
      modulo: String(modulo).trim(),
      pasos: String(pasos).trim(),
    };

    const template = submission.template || await analyzeTicket(form, filesForLlm);
    portalStore.saveTemplate(reporter.id, requestId, template);
    const planeIssue = await createPortalWorkItem(template, reporter, requestId, fingerprint);

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
    const warnings = planeAttachments.some(item => !item.ok)
      ? ["El ticket fue creado, pero algunos adjuntos no pudieron cargarse."] : [];
    const result = {
      ok: true,
      plane: { id: planeIssue.id, identifier: planeIssue.identifier },
      analysis: ticket.analysis,
      warnings,
      message: `Ticket ${planeIssue.identifier} creado`,
    };
    // Persist success before backups: a failed S3 write must not duplicate a work item.
    portalStore.finishSubmission(reporter.id, requestId, result, planeIssue.created_by);
    try {
      await putJson(`${prefix}ticket.json`, ticket);
      await putText(`${prefix}template.html`, template.description_html, "text/html; charset=utf-8");
      await putText(`${prefix}ticket.md`, md);
    } catch (error) {
      console.error("ticket backup:", error.name);
      result.warnings.push("El ticket fue creado, pero su copia de respaldo está pendiente.");
      portalStore.finishSubmission(reporter.id, requestId, result, planeIssue.created_by);
    }
    res.json(result);
  } catch (err) {
    console.error("ticket failed:", err.status || err.name);
    res.status(err.status || 502).json({ error: err.status ? err.message : "No se pudo confirmar el envío. Puedes reintentar; conservaremos el mismo identificador." });
  } finally { if (flightKey) inFlight.delete(flightKey); }
});

app.use((error, _req, res, _next) => {
  res.status(400).json({ error: error instanceof multer.MulterError ? "Revisa los adjuntos: máximo 10 archivos de 10 MB." : "La solicitud no es válida." });
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
