// Optional UI check: PLAYWRIGHT_MODULE may point to a temporary playwright install.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { tmpdir } = require("node:os");
const path = require("node:path");

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const email = `browser-${randomUUID()}@example.test`;
  const password = "browser-password-test-123";
  try {
    await page.goto("http://127.0.0.1:15179");
    await page.locator("#auth-gate").waitFor({ state: "visible" });
    assert.equal(await page.locator("#app-shell").isVisible(), false);
    await page.locator("#toggle-auth").click();
    await page.locator("#register-name").fill("María Navegador");
    await page.locator("#login-email").fill(email);
    await page.locator("#login-password").fill(password);
    await page.screenshot({ path: path.join(tmpdir(), "tickets-register.png") });
    await page.locator("#login-btn").click();
    await page.locator("#app-shell").waitFor({ state: "visible" });
    assert.equal(await page.locator("#user-label").innerText(), "María Navegador");
    async function fillTicket() {
      await page.waitForFunction(() => !document.querySelector("#project_id").disabled);
      await page.locator("#project_id").selectOption({ index: 1 });
      for (const [id, value] of Object.entries({ titulo: "Prueba desde navegador", descripcion: "El botón no responde", modulo: "Ventas", pasos: "Abrir ventas y pulsar el botón" })) await page.locator(`#${id}`).fill(value);
    }
    await fillTicket();
    let interrupted = false;
    const keys = [];
    await page.route("**/api/tickets", async route => {
      keys.push(route.request().headers()["idempotency-key"]);
      if (!interrupted) {
        interrupted = true;
        const response = await route.fetch();
        assert.equal(response.status(), 200, await response.text());
        await route.abort("failed"); // simulate losing the response after the server commits
      } else await route.continue();
    });
    await page.locator("#submit-btn").click();
    await page.locator("#status.err").waitFor({ state: "visible", timeout: 90000 });
    await page.reload();
    await page.locator("#app-shell").waitFor({ state: "visible" });
    await fillTicket();
    await page.locator("#submit-btn").click();
    await page.locator("#status.ok").waitFor({ state: "visible", timeout: 90000 });
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
    const output = execFileSync("docker", ["exec", "tickets-portal-check-plane-ticket-bridge-1", "python", "-c",
      `import os; os.environ.setdefault('DJANGO_SETTINGS_MODULE','plane.settings.production'); import django; django.setup(); from plane.db.models import Issue; print(Issue.objects.filter(created_by__email=${JSON.stringify(email)}).count())`], { encoding: "utf8" });
    assert.equal(output.trim().split("\n").at(-1), "1");
    await page.screenshot({ path: path.join(tmpdir(), "tickets-created.png") });
    await page.locator("#logout-btn").click();
    await page.locator("#auth-gate").waitFor({ state: "visible" });
    // The form may still be in registration mode after signing out.
    if (await page.locator("#register-name-field").isVisible()) await page.locator("#toggle-auth").click();
    await page.locator("#login-email").fill(email);
    await page.locator("#login-password").fill(password);
    await page.locator("#login-btn").click();
    await page.locator("#app-shell").waitFor({ state: "visible" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(tmpdir(), "tickets-mobile.png"), fullPage: true });
    assert.deepEqual(errors, []);
    console.log("PASS: browser register/login/logout, submit, lost-response retry across reload without duplicate, mobile layout, no JS errors.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
