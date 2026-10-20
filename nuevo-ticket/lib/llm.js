const path = require("path");
const { spawn } = require("child_process");
const { CURSOR_API_KEY, LLM_MODEL } = require("./config");

const PRIORITY_MAP = {
  baja: "low",
  media: "medium",
  alta: "high",
  urgente: "urgent",
  low: "low",
  medium: "medium",
  high: "high",
  urgent: "urgent",
};

const ROOT = path.join(__dirname, "..");
const PYTHON =
  process.env.CURSOR_PYTHON ||
  (process.platform === "win32"
    ? path.join(ROOT, ".venv-cursor312", "Scripts", "python.exe")
    : "python3");
const ANALYZE_SCRIPT = path.join(ROOT, "scripts", "analyze_ticket.py");

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function paragraphs(text) {
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("");
}

function buildLocalTemplate(form, files, reporter) {
  const project = form.project;
  const priority = PRIORITY_MAP[form.prioridad] || "medium";
  const fileLines = (files || [])
    .map(
      (f) =>
        `<li><code>${escapeHtml(f.nombre || f.name)}</code> (adjunto en Plane)</li>`
    )
    .join("");

  const description_html = [
    `<h2>${escapeHtml(form.titulo)}</h2>`,
    `<p><strong>Tipo:</strong> ${escapeHtml(form.tipoLabel || form.tipo)}</p>`,
    `<p><strong>Módulo/pantalla:</strong> ${escapeHtml(form.modulo)}</p>`,
    `<p><strong>Reportado por:</strong> ${escapeHtml(reporter.display_name)} (${escapeHtml(reporter.email)})</p>`,
    `<h3>Descripción</h3>`,
    paragraphs(form.descripcion),
    `<h3>Pasos para reproducir</h3>`,
    paragraphs(form.pasos),
    files?.length
      ? `<h3>Capturas (Floci S3)</h3><ul>${fileLines}</ul>`
      : `<p><em>Sin capturas adjuntas.</em></p>`,
    `<p><em>Generado por Nuevo Ticket (plantilla local).</em></p>`,
  ].join("");

  return {
    project_id: project.id,
    project_identifier: project.identifier,
    project_name: project.name,
    name: String(form.titulo).trim().slice(0, 255),
    priority,
    description_html,
    analysis_source: "local",
    summary: `Ticket ${form.tipo} en ${form.modulo} → proyecto ${project.identifier}`,
  };
}

function extractJson(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("El LLM no devolvió JSON");
  return JSON.parse(candidate.slice(start, end + 1));
}

function buildPrompt(form, files, reporter) {
  return [
    "Sos un analista de soporte. Convertí este reporte en un ticket de Plane.",
    "Respondé SOLO con un JSON válido (sin markdown) con esta forma:",
    "{",
    '  "name": "título corto y claro del ticket",',
    '  "priority": "urgent" | "high" | "medium" | "low",',
    '  "summary": "1-2 oraciones del análisis",',
    '  "description_html": "HTML limpio con h2/h3/p/ul/li/code"',
    "}",
    `Proyecto elegido: ${form.project.name}. Incluye quien reporta.`,
    "Si hay capturas, describí qué se ve. Español, profesional, sin scripts.",
    "",
    `Tipo: ${form.tipoLabel || form.tipo}`,
    `Título sugerido: ${form.titulo}`,
    `Prioridad del usuario: ${form.prioridad}`,
    `Módulo: ${form.modulo}`,
    `Reportado por: ${reporter.display_name} <${reporter.email}>`,
    "",
    "Descripción:",
    form.descripcion,
    "",
    "Pasos:",
    form.pasos,
    "",
    "Archivos en Floci:",
    ...(files || []).map((f) => `- ${f.nombre}: ${f.url || f.s3Uri}`),
  ].join("\n");
}

function runCursorPython(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [ANALYZE_SCRIPT], {
      cwd: ROOT,
      env: { ...process.env, CURSOR_API_KEY: payload.api_key },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const line = stdout.trim().split(/\n/).filter(Boolean).pop() || "";
      try {
        resolve({ code, data: JSON.parse(line), stderr });
      } catch {
        reject(
          new Error(
            `Cursor Python SDK no devolvió JSON (code=${code}): ${line || stderr || "sin salida"}`
          )
        );
      }
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

/**
 * Analiza con Cursor Python SDK (docs: https://cursor.com/docs/sdk/python).
 * Sin API key o si falla → plantilla local.
 */
async function analyzeTicket(form, files, reporter) {
  const fallback = buildLocalTemplate(form, files, reporter);

  if (!CURSOR_API_KEY) {
    return fallback;
  }

  const images = [];
  for (const file of files || []) {
    if (!file.mime?.startsWith("image/") || !file.buffer) continue;
    images.push({
      data: file.buffer.toString("base64"),
      mime_type: file.mime,
    });
  }

  try {
    const { code, data, stderr } = await runCursorPython({
      api_key: CURSOR_API_KEY,
      model: LLM_MODEL,
      cwd: ROOT,
      prompt: buildPrompt(form, files, reporter),
      images,
    });

    if (!data?.ok || !data.result) {
      const msg = data?.error || stderr || `exit ${code}`;
      console.warn("Cursor Python SDK failed:", msg);
      return {
        ...fallback,
        analysis_source: "local-fallback",
        llm_error: String(msg).slice(0, 300),
      };
    }

    const parsed = extractJson(data.result);
    const project = form.project;
    const priority =
      PRIORITY_MAP[parsed.priority] || PRIORITY_MAP[form.prioridad] || "medium";

    let description_html = String(parsed.description_html || "").trim();
    if (!description_html) {
      description_html = fallback.description_html;
    } else if (!description_html.includes(reporter.email)) {
      description_html += `<p><strong>Reportado por:</strong> ${escapeHtml(reporter.display_name)} (${escapeHtml(reporter.email)})</p>`;
    }

    return {
      project_id: project.id,
      project_identifier: project.identifier,
      project_name: project.name,
      name: String(parsed.name || form.titulo).trim().slice(0, 255),
      priority,
      description_html,
      analysis_source: "cursor-python-sdk",
      summary: String(parsed.summary || fallback.summary),
      model: data.model || LLM_MODEL,
    };
  } catch (err) {
    console.warn("Cursor Python SDK error:", err.message);
    return {
      ...fallback,
      analysis_source: "local-fallback",
      llm_error: err.message,
    };
  }
}

module.exports = { analyzeTicket, buildLocalTemplate, PRIORITY_MAP };
