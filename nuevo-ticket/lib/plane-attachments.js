const { PLANE_API_URL, PLANE_WORKSPACE_SLUG, PLANE_MCP_API_KEY } = require("./config");

function apiHeaders(json = false) {
  const h = { "X-Api-Key": PLANE_MCP_API_KEY };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

/**
 * Sube capturas como attachments del work item (se ven en Plane → Attachments).
 * Flujo API v1: crear asset → POST a MinIO/S3 firmado → confirmar is_uploaded.
 * Floci queda como copia de respaldo; lo que el equipo mira es el attach.
 */
async function attachFilesToWorkItem(projectId, workitemId, files) {
  if (!files?.length) return [];

  const base =
    `${PLANE_API_URL}/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}` +
    `/projects/${projectId}/work-items/${workitemId}/attachments/`;

  const uploaded = [];

  for (const file of files) {
    if (!file.buffer) continue;
    const name = file.nombre || file.name || "captura.png";
    const type = file.mime || "application/octet-stream";
    const size = file.buffer.length || file.bytes || 0;

    try {
      // 1) pedir URL firmada
      const createRes = await fetch(base, {
        method: "POST",
        headers: apiHeaders(true),
        body: JSON.stringify({ name, type, size }),
      });
      const createBody = await createRes.json().catch(() => ({}));
      if (!createRes.ok) {
        uploaded.push({
          nombre: name,
          ok: false,
          error: createBody.error || JSON.stringify(createBody).slice(0, 200),
        });
        continue;
      }

      const assetId = createBody.asset_id;
      const uploadData = createBody.upload_data;
      if (!assetId || !uploadData?.url || !uploadData?.fields) {
        uploaded.push({
          nombre: name,
          ok: false,
          error: "Respuesta de attach incompleta (sin upload_data)",
        });
        continue;
      }

      // 2) subir bytes a MinIO/S3 de Plane
      const s3Form = new FormData();
      for (const [k, v] of Object.entries(uploadData.fields)) {
        s3Form.append(k, v);
      }
      s3Form.append(
        "file",
        new Blob([file.buffer], { type }),
        name
      );

      const s3Res = await fetch(uploadData.url, {
        method: "POST",
        body: s3Form,
      });
      if (!s3Res.ok) {
        const errText = await s3Res.text();
        uploaded.push({
          nombre: name,
          ok: false,
          error: `S3 upload ${s3Res.status}: ${errText.slice(0, 200)}`,
        });
        continue;
      }

      // 3) confirmar
      const confirmRes = await fetch(`${base}${assetId}/`, {
        method: "PATCH",
        headers: apiHeaders(true),
        body: JSON.stringify({ is_uploaded: true }),
      });
      if (!confirmRes.ok && confirmRes.status !== 204) {
        const errText = await confirmRes.text();
        uploaded.push({
          nombre: name,
          ok: false,
          error: `Confirm ${confirmRes.status}: ${errText.slice(0, 200)}`,
        });
        continue;
      }

      uploaded.push({
        nombre: name,
        ok: true,
        id: assetId,
        asset_url: createBody.asset_url || null,
      });
    } catch (err) {
      console.warn("attachment error:", err.message);
      uploaded.push({ nombre: name, ok: false, error: err.message });
    }
  }

  return uploaded;
}

module.exports = { attachFilesToWorkItem };
