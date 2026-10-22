const { DatabaseSync } = require("node:sqlite");
const { mkdirSync } = require("node:fs");
const path = require("node:path");
const { randomUUID, randomBytes, scrypt, timingSafeEqual, createHash } = require("node:crypto");
const { promisify } = require("node:util");
const derive = promisify(scrypt);
const digest = value => createHash("sha256").update(value).digest("hex");
const publicUser = row => row ? ({ id: row.id, email: row.email, display_name: row.display_name }) : null;
const failure = (message, status = 400) => Object.assign(new Error(message), { status });

class PortalStore {
  constructor(filename) {
    if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
        plane_user_id TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attempts (
        key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS submissions (
        user_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, template TEXT, result TEXT,
        created_at INTEGER NOT NULL, PRIMARY KEY(user_id, request_id)
      );
    `);
  }

  async register({ email, password, name } = {}) {
    email = typeof email === "string" ? email.trim().toLowerCase() : "";
    name = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw failure("Introduce un correo válido.");
    if (name.length < 2 || name.length > 120) throw failure("El nombre debe tener entre 2 y 120 caracteres.");
    if (typeof password !== "string" || password.length < 12 || password.length > 128) throw failure("La contraseña debe tener entre 12 y 128 caracteres.");
    const salt = randomBytes(16).toString("hex");
    const key = await derive(password, salt, 64);
    const user = { id: randomUUID(), email, display_name: name };
    try {
      this.db.prepare("INSERT INTO users(id,email,display_name,password_hash,created_at) VALUES(?,?,?,?,?)")
        .run(user.id, email, name, `scrypt:${salt}:${key.toString("hex")}`, Date.now());
    } catch (error) {
      if (error.message.includes("UNIQUE")) throw failure("No se pudo registrar ese correo. Si ya tienes cuenta, inicia sesión.", 409);
      throw error;
    }
    return user;
  }

  async login(email, password) {
    if (typeof email !== "string" || typeof password !== "string" || password.length > 128) throw failure("Correo o contraseña incorrectos.", 401);
    const row = this.db.prepare("SELECT * FROM users WHERE email=?").get(email.trim().toLowerCase());
    const [, salt, expected] = (row?.password_hash || `scrypt:${"0".repeat(32)}:${"0".repeat(128)}`).split(":");
    const actual = await derive(password, salt, 64);
    if (!timingSafeEqual(actual, Buffer.from(expected, "hex")) || !row) throw failure("Correo o contraseña incorrectos.", 401);
    return publicUser(row);
  }

  createSession(userId) {
    const token = randomBytes(32).toString("hex");
    this.db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(Date.now());
    this.db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(digest(token), userId, Date.now() + 12 * 60 * 60 * 1000);
    return token;
  }

  sessionUser(token) {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return null;
    return publicUser(this.db.prepare("SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?")
      .get(digest(token), Date.now()));
  }

  logout(token) {
    if (typeof token === "string") this.db.prepare("DELETE FROM sessions WHERE token_hash=?").run(digest(token));
  }

  allowAttempt(key, limit, windowMs) {
    const now = Date.now();
    this.db.prepare("DELETE FROM attempts WHERE expires_at<=?").run(now);
    const row = this.db.prepare(`INSERT INTO attempts VALUES(?,1,?) ON CONFLICT(key)
      DO UPDATE SET count=count+1 RETURNING count`).get(digest(key), now + windowMs);
    return row.count <= limit;
  }

  submission(userId, requestId, fingerprint) {
    this.db.prepare("INSERT OR IGNORE INTO submissions(user_id,request_id,fingerprint,created_at) VALUES(?,?,?,?)")
      .run(userId, requestId, fingerprint, Date.now());
    const row = this.db.prepare("SELECT * FROM submissions WHERE user_id=? AND request_id=?").get(userId, requestId);
    if (row.fingerprint !== fingerprint) throw failure("Este envío corresponde a otros datos. Inicia un nuevo envío.", 409);
    return { template: row.template && JSON.parse(row.template), result: row.result && JSON.parse(row.result) };
  }

  saveTemplate(userId, requestId, template) {
    this.db.prepare("UPDATE submissions SET template=? WHERE user_id=? AND request_id=?").run(JSON.stringify(template), userId, requestId);
  }

  finishSubmission(userId, requestId, result, planeUserId) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE submissions SET result=? WHERE user_id=? AND request_id=?").run(JSON.stringify(result), userId, requestId);
      this.db.prepare("UPDATE users SET plane_user_id=? WHERE id=?").run(planeUserId, userId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  close() { this.db.close(); }
}

module.exports = { PortalStore, digest };
