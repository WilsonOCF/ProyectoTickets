const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { execFileSync } = require("node:child_process");
const assert = require("node:assert/strict");
const path = require("node:path");
const { tmpdir } = require("node:os");
(async () => {
  const output = execFileSync("docker", ["exec", "tickets-portal-check-plane-ticket-bridge-1", "python", "-c",
    "import os; os.environ.setdefault('DJANGO_SETTINGS_MODULE','plane.settings.production'); import django; django.setup(); import json; from plane.db.models import Issue; i=Issue.objects.filter(created_by__username__startswith='tickets_',created_by__display_name='María García').order_by('-created_at').first(); print(json.dumps({'identifier':str(i.project.identifier)+'-'+str(i.sequence_id),'name':i.created_by.display_name}))"], { encoding: "utf8" });
  const issue = JSON.parse(output.trim().split("\n").at(-1));
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const base = "http://localhost:13079";
  try {
    const csrf = await (await context.request.get(`${base}/auth/get-csrf-token/`)).json();
    const login = await context.request.post(`${base}/auth/sign-in/`, { form: { email: "portal-owner@example.test", password: "portal-owner-test-password-123" }, headers: { "X-CSRFToken": csrf.csrf_token, Origin: base, Referer: `${base}/` }, maxRedirects: 0 });
    assert.equal(login.status(), 302, await login.text());
    const me = await context.request.get(`${base}/api/users/me/`);
    assert.equal(me.status(), 200, await me.text());
    const page = await context.newPage();
    await page.goto(`${base}/crs/browse/${issue.identifier}/`);
    const label = page.getByText(/^Created by$/i);
    try { await label.waitFor({ state: "visible", timeout: 30000 }); }
    catch (error) {
      await page.screenshot({ path: path.join(tmpdir(), "plane-author-debug.png") });
      console.error("Plane URL:", page.url(), "Page:", (await page.locator("body").innerText()).slice(0, 1800));
      throw error;
    }
    const property = label.locator("../..");
    await page.getByText(issue.name, { exact: true }).first().waitFor({ state: "visible" });
    await page.screenshot({ path: path.join(tmpdir(), "plane-created-by.png") });
    assert.ok((await property.innerText()).includes(issue.name), await property.innerText());
    console.log("PASS: official pinned Plane UI displays María García in Created by.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
