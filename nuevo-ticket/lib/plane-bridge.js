const { PLANE_BRIDGE_URL, PLANE_BRIDGE_SECRET, PLANE_WORKSPACE_SLUG, PLANE_WEB_URL } = require("./config");

async function createPortalWorkItem(template, user, requestId, fingerprint) {
  const response = await fetch(`${PLANE_BRIDGE_URL}/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${PLANE_BRIDGE_SECRET}` },
    signal: AbortSignal.timeout(60000),
    body: JSON.stringify({
      user, request_id: requestId, fingerprint,
      project_id: template.project_id,
      name: template.name, priority: template.priority, description_html: template.description_html,
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "No se pudo registrar el ticket. Intenta nuevamente.");
    error.status = [400, 403, 409, 422].includes(response.status) ? response.status : 502;
    throw error;
  }
  if (!data.id || !data.created_by) throw new Error("La integración no confirmó la autoría del ticket.");
  return {
    ...data,
    url: `${PLANE_WEB_URL}/${PLANE_WORKSPACE_SLUG}/browse/${data.identifier}/`,
  };
}

module.exports = { createPortalWorkItem };
