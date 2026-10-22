const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const express = require("express");
const cookieSession = require("cookie-session");
const { PortalStore } = require("../lib/portal-store");
const { installPortalAuth, requireAuth } = require("../lib/portal-auth");
const { buildLocalTemplate } = require("../lib/llm");

const account = { name: "María García", email: "maria@example.test", password: "a long local password 123" };

test("accounts, revoked sessions and submissions survive reopening the database", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tickets-auth-"));
  let store = new PortalStore(path.join(dir, "test.sqlite"));
  try {
    const user = await store.register(account);
    const hash = store.db.prepare("SELECT password_hash FROM users").get().password_hash;
    assert.ok(hash.startsWith("scrypt:"));
    assert.ok(!hash.includes(account.password));
    assert.equal(store.db.prepare("SELECT plane_user_id FROM users").get().plane_user_id, null);
    await assert.rejects(store.login(account.email, "wrong password"), { status: 401 });
    await assert.rejects(store.register({ ...account, email: "MARIA@example.test" }), { status: 409 });
    const token = store.createSession(user.id);
    store.submission(user.id, "request-one", "fingerprint");
    store.saveTemplate(user.id, "request-one", { name: "Test" });
    store.finishSubmission(user.id, "request-one", { ok: true }, "plane-user");
    store.close();
    store = new PortalStore(path.join(dir, "test.sqlite"));
    assert.deepEqual(await store.login("MARIA@example.test", account.password), user);
    assert.deepEqual(store.sessionUser(token), user);
    assert.deepEqual(store.submission(user.id, "request-one", "fingerprint").result, { ok: true });
    assert.throws(() => store.submission(user.id, "request-one", "different"), { status: 409 });
    store.logout(token);
    assert.equal(store.sessionUser(token), null);
    assert.equal(store.sessionUser("forged"), null);
    const expired = store.createSession(user.id);
    store.db.prepare("UPDATE sessions SET expires_at=0").run();
    assert.equal(store.sessionUser(expired), null);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("registration validates input and rate limits persist", async () => {
  const store = new PortalStore(":memory:");
  try {
    await assert.rejects(store.register({ ...account, password: "short" }), { status: 400 });
    await assert.rejects(store.register({ ...account, email: "invalid" }), { status: 400 });
    await assert.rejects(store.register({ ...account, name: " " }), { status: 400 });
    assert.equal(store.allowAttempt("login:test", 2, 60000), true);
    assert.equal(store.allowAttempt("login:test", 2, 60000), true);
    assert.equal(store.allowAttempt("login:test", 2, 60000), false);
  } finally { store.close(); }
});

test("HTTP registration is independent of Plane; legacy sessions and cross-site mutations rejected", async () => {
  const store = new PortalStore(":memory:");
  const app = express();
  app.use(cookieSession({ name: "test", keys: ["test-only-secret"], httpOnly: true, sameSite: "lax" }));
  app.use(express.json());
  installPortalAuth(app, store);
  app.get("/private", requireAuth, (req, res) => res.json(req.portalUser));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { "Content-Type": "application/json", "X-Tickets-Request": "1" };
  try {
    let response = await fetch(`${base}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(account) });
    assert.equal(response.status, 403);
    response = await fetch(`${base}/api/auth/register`, { method: "POST", headers, body: JSON.stringify(account) });
    assert.equal(response.status, 201);
    const data = await response.json();
    assert.equal(data.user.display_name, account.name);
    assert.ok(!JSON.stringify(data).includes("password"));
    const cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    response = await fetch(`${base}/api/me`, { headers: { cookie } });
    assert.equal(response.status, 200);
    await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { ...headers, cookie } });
    response = await fetch(`${base}/api/me`, { headers: { cookie } });
    assert.equal(response.status, 401); // copying a pre-logout cookie cannot restore the session
    response = await fetch(`${base}/api/auth/login`, { method: "POST", headers, body: JSON.stringify(account) });
    assert.equal(response.status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); store.close(); }
});

test("generated description contains no injected reporter identity", () => {
  const template = buildLocalTemplate({ project: { id: "project", identifier: "SUP", name: "Soporte" },
    titulo: "Error de impresión", tipo: "incidencia", modulo: "Impresión", descripcion: "No imprime", pasos: "Enviar", prioridad: "media" }, [],
    { display_name: "María", email: account.email });
  assert.ok(!template.description_html.includes("Reportado por"));
  assert.ok(!template.description_html.includes(account.email));
});
