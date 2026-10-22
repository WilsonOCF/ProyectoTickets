// Run only against the disposable stack from tests/portal-compose.yml.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const base = 'http://127.0.0.1:15179';
const email = `maria-${randomUUID()}@example.test`;
const password = 'portal-test-password-123';
let cookie = '';
async function request(route, options = {}) {
  const res = await fetch(base + route, { ...options, headers: { cookie, 'X-Tickets-Request': '1', ...options.headers } });
  const cookies = res.headers.getSetCookie();
  if (cookies.length) cookie = cookies.map(v => v.split(';')[0]).join('; ');
  return { status: res.status, body: await res.json() };
}
function planeCheck(code) {
  const out = execFileSync('docker', ['exec', '-i', 'tickets-portal-check-plane-ticket-bridge-1', 'python', '-c',
    "import os; os.environ.setdefault('DJANGO_SETTINGS_MODULE','plane.settings.production'); import django; django.setup(); " + code], { encoding: 'utf8' });
  return out.trim().split('\n').at(-1);
}
const user = await request('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password, name: 'María García' }) });
assert.equal(user.status, 201, JSON.stringify(user.body));
assert.equal(planeCheck(`from plane.db.models import User; print(User.objects.filter(email=${JSON.stringify(email)}).count())`), '0');
assert.equal((await request('/api/me')).body.user.email, email);
const projects = await request('/api/proyectos');
assert.equal(projects.status, 200, JSON.stringify(projects.body));
assert.equal(projects.body.length, 2);
const key = randomUUID();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
function form(project, title = 'Impresión de comprobante') {
  const body = new FormData();
  for (const [name, value] of Object.entries({ project_id: project.id, tipo: 'incidencia', titulo: title, prioridad: 'media', descripcion: 'No imprime al pulsar el botón', modulo: 'Facturación', pasos: 'Abrir y pulsar imprimir' })) body.append(name, value);
  body.append('capturas', new Blob([png], { type: 'image/png' }), 'captura.png');
  return body;
}
const first = await request('/api/tickets', { method: 'POST', headers: { 'Idempotency-Key': key }, body: form(projects.body[0]) });
assert.equal(first.status, 200, JSON.stringify(first.body));
assert.equal(first.body.warnings.length, 0, JSON.stringify(first.body));
const replay = await request('/api/tickets', { method: 'POST', headers: { 'Idempotency-Key': key }, body: form(projects.body[0]) });
assert.deepEqual(replay.body, first.body);
const mismatch = await request('/api/tickets', { method: 'POST', headers: { 'Idempotency-Key': key }, body: form(projects.body[0], 'Otro contenido') });
assert.equal(mismatch.status, 409);
const second = await request('/api/tickets', { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: form(projects.body[1]) });
assert.equal(second.status, 200, JSON.stringify(second.body));
assert.notEqual(second.body.plane.id, first.body.plane.id);
const stats = JSON.parse(planeCheck(`import json; from plane.db.models import User, Issue, WorkspaceMember, ProjectMember; u=User.objects.get(email=${JSON.stringify(email)}); print(json.dumps({'users':User.objects.filter(email=u.email).count(),'name':u.display_name,'password':u.has_usable_password(),'workspace_roles':list(WorkspaceMember.objects.filter(member=u).values_list('role',flat=True)),'project_roles':list(ProjectMember.objects.filter(member=u).values_list('role',flat=True)),'issues':Issue.objects.filter(created_by=u).count(),'description':Issue.objects.get(id=${JSON.stringify(first.body.plane.id)}).description_html}))`));
assert.equal(stats.users, 1);
assert.equal(stats.name, 'María García');
assert.equal(stats.password, false);
assert.deepEqual(stats.workspace_roles, [5]);
assert.deepEqual(stats.project_roles, [15, 15]);
assert.equal(stats.issues, 2);
assert.ok(!stats.description.includes(email));
assert.ok(!stats.description.includes('Reportado por'));
const savedCookie = cookie;
await request('/api/auth/logout', { method: 'POST' });
cookie = savedCookie;
assert.equal((await request('/api/me')).status, 401);
const login = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
assert.equal(login.status, 200);
// A portal registration must never take over an existing Plane account.
await request('/api/auth/logout', { method: 'POST' });
const existingEmail = `existing-${randomUUID()}@example.test`;
planeCheck(`from plane.db.models import User; u=User(username=${JSON.stringify(randomUUID())},email=${JSON.stringify(existingEmail)},display_name='Existing user'); u.set_unusable_password(); u.save(); print('created')`);
const collision = await request('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: existingEmail, password, name: 'Another name' }) });
assert.equal(collision.status, 201);
const conflict = await request('/api/tickets', { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: form(projects.body[0]) });
assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
assert.equal(planeCheck(`from plane.db.models import User; print(User.objects.get(email=${JSON.stringify(existingEmail)}).display_name)`), 'Existing user');
console.log('PASS: independent signup/login; lazy Plane identity; two projects; real author; attachments; idempotency; logout; existing-account protection.');
