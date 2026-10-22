const express = require("express");

function installPortalAuth(app, store, { registrationEnabled = true } = {}) {
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    // A cross-origin HTML form cannot add this header. No CORS is enabled.
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.get("X-Tickets-Request") !== "1") {
      return res.status(403).json({ error: "Solicitud no válida. Recarga la página." });
    }
    req.portalUser = store.sessionUser(req.session?.token);
    next();
  });
  app.get("/api/auth/config", (_req, res) => res.json({ registrationEnabled }));
  app.get("/api/me", (req, res) => req.portalUser
    ? res.json({ authenticated: true, user: req.portalUser })
    : res.status(401).json({ authenticated: false }));

  const router = express.Router();
  for (const action of ["login", "register"]) {
    router.post(`/${action}`, async (req, res) => {
      if (action === "register" && !registrationEnabled) return res.status(403).json({ error: "El registro está deshabilitado." });
      const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
      const windowMs = 15 * 60 * 1000;
      if (!store.allowAttempt(`${action}:ip:${req.ip}`, action === "register" ? 10 : 50, windowMs)
          || !store.allowAttempt(`${action}:email:${email}`, 15, windowMs)) {
        res.set("Retry-After", "900");
        return res.status(429).json({ error: "Demasiados intentos. Intenta de nuevo en 15 minutos." });
      }
      try {
        const user = action === "register" ? await store.register(req.body || {}) : await store.login(email, req.body?.password);
        store.logout(req.session?.token);
        req.session = { token: store.createSession(user.id) };
        res.status(action === "register" ? 201 : 200).json({ ok: true, user });
      } catch (error) {
        if (!error.status) console.error("portal auth:", error.code || "storage error");
        res.status(error.status || 500).json({ error: error.status ? error.message : "No se pudo completar la operación." });
      }
    });
  }
  router.post("/logout", (req, res) => {
    store.logout(req.session?.token);
    req.session = null;
    res.json({ ok: true });
  });
  app.use("/api/auth", router);
}

function requireAuth(req, res, next) {
  if (!req.portalUser) return res.status(401).json({ error: "Inicia sesión para crear tickets.", code: "AUTH_REQUIRED" });
  next();
}

module.exports = { installPortalAuth, requireAuth };
