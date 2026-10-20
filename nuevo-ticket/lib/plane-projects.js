const { PLANE_API_URL, PLANE_WORKSPACE_SLUG, PLANE_MCP_API_KEY } = require("./config");

async function listProjects() {
  const endpoint = `${PLANE_API_URL}/api/v1/workspaces/${encodeURIComponent(PLANE_WORKSPACE_SLUG)}/projects/`;
  const projects = new Map();
  const cursors = new Set();
  let cursor;
  do {
    const url = new URL(endpoint);
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url, {
      headers: { "x-api-key": PLANE_MCP_API_KEY },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Plane projects: HTTP ${response.status}`);
    const data = await response.json();
    const items = Array.isArray(data) ? data : data.results;
    if (!Array.isArray(items)) throw new Error("Respuesta de proyectos inválida");
    for (const { id, name, identifier } of items) {
      if (!id || !name || !identifier) throw new Error("Proyecto inválido en Plane");
      projects.set(id, { id, name, identifier });
    }
    cursor = data.next_page_results ? data.next_cursor : null;
    if (data.next_page_results && (!cursor || cursors.has(cursor))) {
      throw new Error("Paginación de proyectos inválida");
    }
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return [...projects.values()];
}

module.exports = { listProjects };
