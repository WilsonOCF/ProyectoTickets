const { PLANE_MCP_URL, PLANE_MCP_API_KEY, PLANE_WORKSPACE_SLUG, PLANE_WEB_URL } =
  require("./config");

function parseSseJson(text) {
  const lines = String(text || "").split(/\n/);
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      return JSON.parse(line.slice(6));
    }
  }
  // plain JSON fallback
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Respuesta MCP inválida: ${String(text).slice(0, 200)}`);
  }
}

async function mcpRequest(body, sessionId) {
  if (!PLANE_MCP_API_KEY) {
    throw new Error(
      "Falta PLANE_MCP_API_KEY en .env (token personal de Plane para el MCP)."
    );
  }

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${PLANE_MCP_API_KEY}`,
    "x-workspace-slug": PLANE_WORKSPACE_SLUG,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch(PLANE_MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  return {
    sessionId: res.headers.get("mcp-session-id") || sessionId || null,
    payload: body.method?.startsWith("notifications/") ? null : parseSseJson(text),
  };
}

async function withMcpSession(fn) {
  const init = await mcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "nuevo-ticket", version: "1.0.0" },
    },
  });

  const sessionId = init.sessionId;
  await mcpRequest(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionId
  );

  return fn(sessionId);
}

function parseToolResult(payload) {
  const result = payload?.result;
  if (!result || result.isError) {
    const errText =
      result?.content?.[0]?.text || JSON.stringify(payload).slice(0, 400);
    throw new Error(errText);
  }
  if (result.structuredContent?.result) return result.structuredContent.result;
  try {
    return JSON.parse(result.content?.[0]?.text || "{}");
  } catch {
    return null;
  }
}

/**
 * Crea un work item en Plane vía MCP HTTP (tools/call workitem create).
 */
async function createWorkItemViaMcp(template) {
  const workitem = await withMcpSession(async (sessionId) => {
    const call = await mcpRequest(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "workitem",
          arguments: {
            action: "create",
            project_id: template.project_id,
            name: template.name,
            priority: template.priority,
            description_html: template.description_html,
          },
        },
      },
      sessionId
    );
    return parseToolResult(call.payload);
  });

  if (!workitem?.id) {
    throw new Error("MCP creó el ticket pero no devolvió id");
  }

  const sequence = workitem.sequence_id;
  const identifier =
    sequence != null
      ? `${template.project_identifier}-${sequence}`
      : workitem.id;

  return {
    id: workitem.id,
    identifier,
    sequence_id: sequence,
    project_id: template.project_id,
    name: workitem.name || template.name,
    priority: workitem.priority || template.priority,
    url: `${PLANE_WEB_URL}/${PLANE_WORKSPACE_SLUG}/browse/${identifier}/`,
    raw: workitem,
  };
}

/**
 * Actualiza la descripción del work item (p. ej. para incrustar previews de capturas).
 */
async function updateWorkItemDescription(projectId, workitemId, descriptionHtml) {
  await withMcpSession(async (sessionId) => {
    const call = await mcpRequest(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "workitem",
          arguments: {
            action: "update",
            project_id: projectId,
            workitem_id: workitemId,
            description_html: descriptionHtml,
          },
        },
      },
      sessionId
    );
    return parseToolResult(call.payload);
  });
}

module.exports = { createWorkItemViaMcp, updateWorkItemDescription };
