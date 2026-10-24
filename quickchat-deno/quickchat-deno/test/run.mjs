import { spawn } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const PORT = 4411, BASE = 'http://127.0.0.1:' + PORT, FILE = '/tmp/qc-test-kv.json';
try { fs.unlinkSync(FILE); } catch (_e) { /* none */ }
let proc;
async function start() {
  proc = spawn('node', ['test/serve.mjs'], { env: { ...process.env, PORT: String(PORT), KV_PATH: FILE, ADMIN_KEY: 'sekret' }, stdio: ['ignore', 'inherit', 'inherit'] });
  for (let i = 0; i < 50; i++) { try { const r = await fetch(BASE + '/healthz'); if (r.ok) return; } catch (_e) { /* wait */ } await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('server did not start');
}
async function stop() { proc.kill(); await new Promise((r) => setTimeout(r, 300)); }

function client() {
  let cookie = '';
  const c = async (method, path, body, headers) => {
    const r = await fetch(BASE + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(headers || {}) }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const sc = r.headers.getSetCookie();
    if (sc.length) { const v = sc[sc.length - 1].split(';')[0]; cookie = v.endsWith('=') ? '' : v; }
    const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (_e) { /* not json */ }
    return { status: r.status, j, headers: r.headers, text: t };
  };
  c.cookie = () => cookie; c.setCookie = (v) => { cookie = v; };
  return c;
}
let n = 0;
const ok = (name) => console.log('ok ' + (++n) + ' - ' + name);

await start();
const g = client(), owner = client(), bob = client(), eve = client();

// static
let r = await g('GET', '/');
assert.equal(r.status, 200); assert.match(r.text, /Quick Chat/); assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
r = await g('GET', '/app.js'); assert.equal(r.status, 200); assert.match(r.text, /suggestions/);
r = await g('GET', '/style.css'); assert.equal(r.status, 200);
ok('static files served with CSP');

// guests
r = await g('POST', '/api/join', { name: 'Sam' }); assert.equal(r.status, 201);
const sam = r.j.user;
r = await owner('POST', '/api/join', { name: 'Sam' }); assert.equal(r.status, 201); // same name allowed
r = await g('POST', '/api/join', { name: '' }); assert.equal(r.status, 400);
ok('guests join, duplicate names allowed');

// channels
r = await g('POST', '/api/messages', { text: 'hello', ch: 'general' }); assert.equal(r.status, 201); const gm = r.j.message;
r = await g('POST', '/api/messages', { text: 'add dark mode', ch: 'suggestions' }); assert.equal(r.status, 201); const sug = r.j.message; assert.equal(sug.ch, 'suggestions');
r = await g('POST', '/api/messages', { text: 'https://x.com', ch: 'links' }); assert.equal(r.status, 403); assert.equal(r.j.error, 'You do not have permission to send messages in this channel.');
ok('general + suggestions open, links blocked for non-owner');

// roles
r = await owner('POST', '/api/role', { code: 'nope' }); assert.equal(r.status, 403);
r = await owner('POST', '/api/role', { code: 'gg' }); assert.equal(r.j.user.role, 'owner');
r = await owner('POST', '/api/messages', { text: 'https://example.com big', ch: 'links' }); assert.equal(r.status, 201);
r = await owner('POST', '/api/profile', { roleLabel: 'Boss', nameColor: '#00ff00' }); assert.equal(r.j.user.roleLabel, 'Boss'); assert.equal(r.j.user.nameColor, '#00ff00');
r = await g('POST', '/api/profile', { roleLabel: 'x' }); assert.equal(r.status, 403);
r = await g('POST', '/api/role', { code: 'gh' }); assert.equal(r.j.user.role, 'jl');
ok('roles, link posting, label/color');

// accounts
r = await bob('POST', '/api/register', { username: 'Bob', password: 'a' }); assert.equal(r.status, 201);
const bobU = r.j.user;
r = await eve('POST', '/api/register', { username: 'bob', password: 'b' }); assert.equal(r.status, 409);
r = await eve('POST', '/api/login', { username: 'bob', password: 'wrong' }); assert.equal(r.status, 401);
r = await eve('POST', '/api/login', { username: 'bob', password: 'a' }); assert.equal(r.status, 200); assert.equal(r.j.user.id, bobU.id);
ok('accounts: register, duplicate, bad and good login');

// DMs
const conv = [sam.id, bobU.id].sort().join('~');
r = await g('POST', '/api/dms/' + conv, { text: 'secret hi' }); assert.equal(r.status, 201);
r = await bob('GET', '/api/dms/' + conv); assert.equal(r.j.messages.length, 1);
const stranger = client(); await stranger('POST', '/api/join', { name: 'Zed' });
r = await stranger('GET', '/api/dms/' + conv); assert.equal(r.status, 403);
const ownerId = (await owner('GET', '/api/me')).j.user.id;
r = await owner('GET', '/api/dms/' + conv); assert.equal(r.status, 200); assert.equal(r.j.messages[0].text, 'secret hi');
r = await owner('POST', '/api/dms/' + conv, { text: 'spy' }); assert.equal(r.status, 403);
r = await owner('GET', '/api/dms'); assert.equal(r.j.dms.length, 1); assert.equal(r.j.dms[0].mine, false);
r = await stranger('GET', '/api/dms'); assert.equal(r.j.dms.length, 0);
ok('DMs private, owner can read all, cannot write');

// sync
r = await bob('GET', '/api/sync?conv=' + conv);
assert.equal(r.status, 200); assert.equal(r.j.messages.length, 3); assert.equal(r.j.convMessages.length, 1); assert.equal(r.j.dms.length, 1);
r = await stranger('GET', '/api/sync?conv=' + conv); assert.equal(r.j.convMessages, undefined);
ok('sync returns channels, DMs and the open conversation');

// delete
r = await bob('DELETE', '/api/messages/' + sug.id + '?ch=suggestions'); assert.equal(r.status, 403);
r = await stranger('DELETE', '/api/messages/' + gm.id + '?ch=general'); assert.equal(r.status, 403);
r = await owner('DELETE', '/api/messages/' + gm.id + '?ch=general'); assert.equal(r.status, 403);
r = await owner('DELETE', '/api/messages/' + sug.id + '?ch=suggestions'); assert.equal(r.status, 200);
r = await g('DELETE', '/api/messages/' + gm.id + '?ch=general'); assert.equal(r.status, 200);
r = await g('GET', '/api/messages'); assert.equal(r.j.messages.some((m) => m.id === sug.id || m.id === gm.id), false);
ok('delete rules (own; owner may clear suggestions only)');

// live updates
const ctl = new AbortController();
const sse = await fetch(BASE + '/api/stream', { headers: { cookie: g.cookie() }, signal: ctl.signal });
assert.equal(sse.headers.get('content-type'), 'text/event-stream');
const rd = sse.body.getReader(); let got = '';
const waiter = (async () => { const dec = new TextDecoder(); for (;;) { const x = await rd.read(); if (x.done) return; got += dec.decode(x.value); if (got.includes('"tick"')) return; } })();
await new Promise((r) => setTimeout(r, 400));
await bob('POST', '/api/messages', { text: 'tick me', ch: 'general' });
await Promise.race([waiter, new Promise((_, rej) => setTimeout(() => rej(new Error('no tick event')), 4000))]);
ctl.abort();
ok('live update tick arrives after someone posts');

// backup round trip
r = await owner('GET', '/api/admin/export'); assert.equal(r.status, 403);
r = await owner('GET', '/api/admin/export', undefined, { 'x-admin-key': 'sekret' }); assert.equal(r.status, 200);
const backup = r.text; const bj = JSON.parse(backup);
assert.ok(bj.messages.some((m) => m.ch === 'links')); assert.ok(bj.dms.length === 1);
r = await owner('POST', '/api/admin/import', backup, { 'x-admin-key': 'sekret' }); assert.equal(r.status, 200); assert.equal(r.j.dms, 1);
r = await eve('POST', '/api/login', { username: 'bob', password: 'a' }); assert.equal(r.status, 200);
ok('export and restore keep accounts, messages, DMs');

// cross-site requests are refused
r = await g('POST', '/api/messages', { text: 'evil', ch: 'general' }, { origin: 'https://evil.example' }); assert.equal(r.status, 403);
ok('foreign origin refused');

// restart: everything must still be there
const savedCookie = eve.cookie(); // restore signs everyone out, so use the login made after it
await stop(); await start();
const again = client(); again.setCookie(savedCookie);
r = await again('GET', '/api/sync'); assert.equal(r.status, 200); assert.equal(r.j.user.id, bobU.id);
assert.ok(r.j.messages.some((m) => m.text === 'tick me'));
const back = client(); r = await back('POST', '/api/login', { username: 'bob', password: 'a' }); assert.equal(r.status, 200);
ok('after a full restart: still signed in, messages and accounts remain');

await stop();
console.log('\nall ' + n + ' checks passed');
process.exit(0);
