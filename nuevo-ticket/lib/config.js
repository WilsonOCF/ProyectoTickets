require("dotenv").config({ quiet: true });
const production = process.env.NODE_ENV === "production";
const CURSOR_API_KEY = process.env.CURSOR_API_KEY || process.env.LLM_API_KEY || "";
const model = String(process.env.LLM_MODEL || process.env.CURSOR_MODEL || "auto").trim();
if (production) {
  const required = ["SESSION_SECRET", "PLANE_API_URL", "PLANE_WEB_URL", "PLANE_WORKSPACE_SLUG", "PLANE_MCP_URL", "PLANE_MCP_API_KEY", "FLOCI_ENDPOINT", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];
  const missing = required.filter(key => !process.env[key]?.trim());
  if (missing.length) throw new Error("Faltan variables de entorno: " + missing.join(", "));
  if (process.env.SESSION_SECRET.length < 32 || process.env.SESSION_SECRET === "nuevo-ticket-dev-secret-change-me") throw new Error("SESSION_SECRET debe ser un secreto aleatorio de al menos 32 caracteres.");
  const internalUrlKeys = ["PLANE_API_URL", "PLANE_MCP_URL", "FLOCI_ENDPOINT"];
  for (const key of internalUrlKeys) {
    let url;
    try { url = new URL(process.env[key]); } catch { throw new Error(key + " debe ser una URL válida."); }
    if (!["http:", "https:"].includes(url.protocol)) throw new Error(key + " debe usar HTTP o HTTPS.");
    if (["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(url.hostname)) {
      throw new Error(key + " apunta al host local; usa el nombre del servicio Docker (api, plane-mcp, floci).");
    }
  }
  let webUrl;
  try { webUrl = new URL(process.env.PLANE_WEB_URL); } catch { throw new Error("PLANE_WEB_URL debe ser una URL válida."); }
  if (!["http:", "https:"].includes(webUrl.protocol)) throw new Error("PLANE_WEB_URL debe usar HTTP o HTTPS.");
}
function sessionCookieSecure() {
  const flag = String(process.env.SESSION_COOKIE_SECURE || "").toLowerCase();
  if (flag === "true" || flag === "1") return true;
  if (flag === "false" || flag === "0") return false;
  const publicUrl = process.env.TICKETS_PUBLIC_URL || process.env.PUBLIC_URL || "";
  if (publicUrl.startsWith("https://")) return true;
  return false;
}
module.exports = {
  PORT: Number(process.env.PORT || 5179),
  HOST: process.env.HOST || (production ? "0.0.0.0" : "127.0.0.1"),
  SESSION_SECRET: process.env.SESSION_SECRET || "nuevo-ticket-dev-secret-change-me",
  PLANE_API_URL: (process.env.PLANE_API_URL || "http://localhost:3000").replace(/\/$/, ""),
  PLANE_WEB_URL: (process.env.PLANE_WEB_URL || "http://localhost:3000").replace(/\/$/, ""),
  PLANE_WORKSPACE_SLUG: process.env.PLANE_WORKSPACE_SLUG || "",
  PLANE_MCP_URL: process.env.PLANE_MCP_URL || "http://127.0.0.1:8211/mcp",
  PLANE_MCP_API_KEY: process.env.PLANE_MCP_API_KEY || "",
  FLOCI_ENDPOINT: process.env.FLOCI_ENDPOINT || "http://127.0.0.1:4566",
  FLOCI_BUCKET: process.env.FLOCI_BUCKET || "tickets",
  AWS_REGION: process.env.AWS_REGION || "us-east-1",
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || "test",
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || "test",
  CURSOR_API_KEY,
  LLM_API_KEY: CURSOR_API_KEY,
  LLM_MODEL: model.toLowerCase() === "autho" ? "auto" : model,
  SESSION_COOKIE_SECURE: sessionCookieSecure(),
};
