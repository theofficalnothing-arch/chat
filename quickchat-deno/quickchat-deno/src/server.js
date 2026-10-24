// Quick Chat for Deno / Deno Deploy.
// Everything is stored in Deno KV, so it survives restarts, sleeping and moving between servers.
// No state is kept in memory between requests (except short caches), so many copies of the app can run at once.

import { INDEX_HTML, APP_JS, STYLE_CSS } from './assets.js';

const enc = new TextEncoder();
function env(name, fallback) { try { return Deno.env.get(name) || fallback; } catch (_e) { return fallback; } }

const INVITE_CODE = env('INVITE_CODE', '');
const OWNER_CODE = env('OWNER_CODE', 'gg');
const JL_CODE = env('JL_CODE', 'gh');
const ADMIN_KEY = env('ADMIN_KEY', '');
const KV_PATH = env('KV_PATH', undefined);
const CHANNELS = ['general', 'links', 'suggestions'];
const chanOf = (v) => (CHANNELS.indexOf(v) >= 0 ? v : 'general');
const MAX_MESSAGES = 5000;
const MAX_DMS_PER_CONV = 5000;
const SESSION_MS = 365 * 24 * 3600 * 1000;
const PBKDF2_ITERATIONS = 100000;

const kv = await Deno.openKv(KV_PATH);

const ASSETS = {
  '/': [INDEX_HTML, 'text/html; charset=utf-8'],
  '/index.html': [INDEX_HTML, 'text/html; charset=utf-8'],
  '/app.js': [APP_JS, 'application/javascript; charset=utf-8'],
  '/style.css': [STYLE_CSS, 'text/css; charset=utf-8']
};

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

// ---------- small helpers ----------
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
function unhex(s) { const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.substr(i * 2, 2), 16); return a; }
async function sha(s) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))); }
function ctEqual(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
async function safeEqual(a, b) { return ctEqual(await sha(String(a)), await sha(String(b))); }
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const newId = () => String(Date.now()).padStart(13, '0') + '-' + randHex(3);

async function derive(pw, salt, iters) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iters }, key, 256));
}
async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return 'pbkdf2$' + PBKDF2_ITERATIONS + '$' + hex(salt) + '$' + hex(await derive(pw, salt, PBKDF2_ITERATIONS));
}
async function checkPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  const iters = parseInt(parts[1], 10);
  if (parts.length !== 4 || parts[0] !== 'pbkdf2' || !(iters > 0 && iters <= 1000000) || !/^[0-9a-f]{32}$/.test(parts[2])) {
    await derive(pw, new Uint8Array(16), PBKDF2_ITERATIONS); // same work whether or not the account exists
    return false;
  }
  return ctEqual(hex(await derive(pw, unhex(parts[2]), iters)), parts[3]);
}

const cleanName = (s) => String(s || '').trim().replace(/\s+/g, ' ');
const validName = (s) => s.length >= 2 && s.length <= 30 && /^[\p{L}\p{N} ._'-]+$/u.test(s);
const validLogin = (s) => /^[a-z0-9._-]{2,30}$/.test(s);
const validPassword = (s) => typeof s === 'string' && s.length >= 1 && s.length <= 200;
const validLabel = (s) => s.length >= 1 && s.length <= 24 && !/[\u0000-\u001f\u007f<>]/.test(s);
const NAME_ERR = "Names are 2 to 30 characters: letters, numbers, spaces and . _ ' -";
const LOGIN_ERR = 'Usernames are 2 to 30 characters: letters, numbers and . _ -';
const PW_ERR = 'Enter a password (1 to 200 characters).';

const convId = (a, b) => [a, b].sort().join('~');
function parseConv(c) {
  const p = String(c || '').split('~');
  if (p.length !== 2 || p[0] === p[1] || !/^[0-9a-f-]{36}$/.test(p[0]) || !/^[0-9a-f-]{36}$/.test(p[1])) return null;
  return p[0] < p[1] ? p : null;
}

function pubUser(u) { return { id: u.id, name: u.name, role: u.role || null, roleLabel: u.roleLabel || null, nameColor: u.nameColor || null }; }
function pubSelf(u) { const p = pubUser(u); p.login = u.login || null; return p; }
function ghost(id) { return { id, name: 'Former member', role: null, roleLabel: null, nameColor: null }; }
function pubMsg(m, um) {
  const u = um.get(m.uid);
  const o = u ? pubUser(u) : ghost(m.uid);
  const out = { id: m.id, uid: m.uid, name: o.name, role: o.role, roleLabel: o.roleLabel, nameColor: o.nameColor, text: m.text, ts: m.ts };
  if (m.conv) out.conv = m.conv; else out.ch = m.ch || 'general';
  return out;
}

// ---------- storage helpers ----------
async function list(prefix, opts) {
  const out = [];
  for await (const e of kv.list({ prefix }, opts || {})) out.push(e);
  return out;
}
const userCache = new Map();
async function getUsers(ids) {
  const out = new Map(), need = [], now = Date.now();
  for (const id of new Set(ids)) {
    const c = userCache.get(id);
    if (c && c.exp > now) out.set(id, c.u); else need.push(id);
  }
  for (let i = 0; i < need.length; i += 10) {
    const chunk = need.slice(i, i + 10);
    const rs = await kv.getMany(chunk.map((id) => ['user', id]));
    rs.forEach((r, j) => { if (r.value) { userCache.set(chunk[j], { u: r.value, exp: now + 4000 }); out.set(chunk[j], r.value); } });
  }
  return out;
}
async function getUser(id) { return (await kv.get(['user', id])).value; }
// Read, change and write a user, retrying if someone else changed it at the same moment.
async function updateUser(id, fn) {
  for (let i = 0; i < 6; i++) {
    const cur = await kv.get(['user', id]);
    if (!cur.value) return null;
    const u = JSON.parse(JSON.stringify(cur.value));
    const res = fn(u);
    if (res) return { error: res };
    const r = await kv.atomic().check(cur).set(['user', id], u).commit();
    if (r.ok) { userCache.delete(id); return { user: u }; }
  }
  return { error: 'Please try again.' };
}
const tick = (atomic) => atomic.sum(['tick'], 1n);

async function limited(name, max, windowMs) {
  const key = ['rl', name, Math.floor(Date.now() / windowMs)];
  for (let i = 0; i < 6; i++) {
    const cur = await kv.get(key);
    const n = (cur.value || 0) + 1;
    const r = await kv.atomic().check(cur).set(key, n, { expireIn: windowMs * 2 }).commit();
    if (r.ok) return n > max;
  }
  return false;
}
const localBuckets = new Map();
function limitedLocal(key, max, windowMs) {
  const now = Date.now();
  let b = localBuckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; localBuckets.set(key, b); }
  if (localBuckets.size > 5000) for (const [k, v] of localBuckets) if (v.reset < now) localBuckets.delete(k);
  return ++b.n > max;
}

// ---------- request helpers ----------
function parseCookies(req) {
  const out = {};
  String(req.headers.get('cookie') || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) { try { out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch (_e) { /* ignore */ } }
  });
  return out;
}
function clientIp(req, info) {
  const xff = String(req.headers.get('x-forwarded-for') || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : ((info && info.remoteAddr && info.remoteAddr.hostname) || 'unknown');
}
function isHttps(req) { return new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https'; }
function baseHeaders(extra) {
  const h = new Headers(extra || {});
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'same-origin');
  h.set('X-Frame-Options', 'DENY');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Content-Security-Policy', CSP);
  h.set('Strict-Transport-Security', 'max-age=31536000');
  return h;
}
function json(obj, status, cookies, extra) {
  const h = baseHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  if (extra) for (const k of Object.keys(extra)) h.set(k, extra[k]);
  (cookies || []).forEach((c) => h.append('Set-Cookie', c));
  return new Response(JSON.stringify(obj), { status: status || 200, headers: h });
}
async function readJson(req, limit) {
  limit = limit || 20000;
  const len = parseInt(req.headers.get('content-length') || '0', 10);
  if (len > limit) throw new Error('too large');
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length > limit) throw new Error('too large');
  if (!buf.length) return {};
  try { return JSON.parse(new TextDecoder().decode(buf)); } catch (_e) { throw new Error('bad json'); }
}
function sessionCookie(req, token, maxAge) {
  return 'qc_session=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (isHttps(req) ? '; Secure' : '');
}
async function startSession(req, uid) {
  const token = randHex(32), h = await sha(token);
  await kv.atomic()
    .set(['session', h], { uid }, { expireIn: SESSION_MS })
    .set(['usess', uid, h], 1, { expireIn: SESSION_MS })
    .commit();
  return sessionCookie(req, token, Math.floor(SESSION_MS / 1000));
}
async function currentUser(req) {
  const t = parseCookies(req).qc_session;
  if (!t) return { user: null };
  const h = await sha(t);
  const s = await kv.get(['session', h]);
  if (!s.value) return { user: null };
  const user = await getUser(s.value.uid);
  return { user: user || null, sessionHash: h };
}

// ---------- shared reads ----------
async function channelMessages() {
  const parts = await Promise.all(CHANNELS.map((c) => list(['msg', c], { reverse: true, limit: 200 })));
  const all = [].concat(...parts).map((e) => e.value).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const um = await getUsers(all.map((m) => m.uid));
  return all.map((m) => pubMsg(m, um));
}
async function dmSummaries(me) {
  const entries = me.role === 'owner' ? await list(['allconvs'], { limit: 500 }) : await list(['convs', me.id], { limit: 500 });
  const rows = entries.map((e) => e.value).filter((c) => c && parseConv(c.conv));
  const ids = [];
  rows.forEach((c) => c.conv.split('~').forEach((x) => ids.push(x)));
  const um = await getUsers(ids);
  const out = rows.map((c) => {
    const p = c.conv.split('~');
    const gu = (id) => { const u = um.get(id); return u ? pubUser(u) : ghost(id); };
    return { conv: c.conv, mine: p.indexOf(me.id) >= 0, a: gu(p[0]), b: gu(p[1]), last: { ts: c.ts, uid: c.uid, text: String(c.text).slice(0, 80) } };
  });
  out.sort((x, y) => y.last.ts - x.last.ts);
  return out;
}
async function convMessages(conv) {
  const rows = (await list(['dm', conv], { reverse: true, limit: 200 })).map((e) => e.value).reverse();
  const um = await getUsers(rows.map((m) => m.uid));
  return rows.map((m) => pubMsg(m, um));
}
async function pruneChannel(ch) {
  const rows = await list(['msg', ch], { reverse: true, limit: MAX_MESSAGES + 200 });
  const extra = rows.slice(MAX_MESSAGES);
  for (let i = 0; i < extra.length; i += 100) {
    const a = kv.atomic();
    extra.slice(i, i + 100).forEach((e) => a.delete(e.key));
    await a.commit();
  }
}

// ---------- live updates ----------
// Every change bumps ['tick']. Each open page watches it and re-reads what it needs, so it works across many copies of the app.
function eventStream(req) {
  const e = new TextEncoder();
  let reader = null, hb = null, poll = null, closed = false, closeStream = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (s) => { if (!closed) { try { controller.enqueue(e.encode(s)); } catch (_e) { closed = true; } } };
      const stop = () => {
        closed = true;
        if (hb) clearInterval(hb);
        if (poll) clearInterval(poll);
        if (reader) { try { reader.cancel(); } catch (_e) { /* ignore */ } }
      };
      const startPoll = () => {
        if (poll || closed) return;
        let last = null;
        poll = setInterval(async () => {
          try {
            const v = (await kv.get(['tick'])).value;
            const s = v === null || v === undefined ? '0' : String(v.value !== undefined ? v.value : v);
            if (last !== null && s !== last) send('data: {"type":"tick"}\n\n');
            last = s;
          } catch (_e) { /* try again next time */ }
        }, 3000);
      };
      send('retry: 3000\n\n');
      hb = setInterval(() => send(': ping\n\n'), 20000);
      let watching = false;
      try {
        if (typeof kv.watch === 'function') {
          reader = kv.watch([['tick']]).getReader();
          watching = true;
          let first = true;
          (async () => {
            try {
              while (!closed) {
                const r = await reader.read();
                if (r.done) break;
                if (first) { first = false; continue; }
                send('data: {"type":"tick"}\n\n');
              }
            } catch (_e) { /* watch not usable, poll instead */ }
            if (!closed) startPoll();
          })();
        }
      } catch (_e) { watching = false; }
      if (!watching) startPoll();
      req.signal.addEventListener('abort', stop);
      closeStream = stop;
    },
    cancel() { closeStream(); }
  });
  const h = baseHeaders({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
  return new Response(stream, { status: 200, headers: h });
}

// ---------- backups ----------
async function adminOk(req, me) {
  return !!ADMIN_KEY && !!me && me.role === 'owner' && await safeEqual(req.headers.get('x-admin-key') || '', ADMIN_KEY);
}
function sanitizeImport(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.users) || !Array.isArray(d.messages)) throw new Error('This is not a Quick Chat backup.');
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const seen = new Set();
  const users = d.users.slice(0, 20000).map((u) => {
    if (!u || typeof u.id !== 'string' || !/^[0-9a-f-]{36}$/.test(u.id) || seen.has(u.id)) return null;
    seen.add(u.id);
    const o = { id: u.id, name: str(u.name, 30) || 'Member', created: Number(u.created) || Date.now() };
    if (typeof u.login === 'string' && validLogin(u.login)) o.login = u.login;
    if (typeof u.pass === 'string' && /^pbkdf2\$\d{1,7}\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(u.pass)) o.pass = u.pass;
    if (u.role === 'owner' || u.role === 'jl') o.role = u.role;
    if (typeof u.roleLabel === 'string' && validLabel(u.roleLabel)) o.roleLabel = u.roleLabel;
    if (typeof u.nameColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(u.nameColor)) o.nameColor = u.nameColor.toLowerCase();
    return o;
  }).filter(Boolean);
  let n = 0;
  const mkId = (ts) => String(ts).padStart(13, '0') + '-' + (n++).toString(16).padStart(6, '0');
  const messages = d.messages.slice(-MAX_MESSAGES * 2).map((m) => {
    if (!m || typeof m.uid !== 'string') return null;
    const ts = Number(m.ts) || 0;
    return { id: mkId(ts), uid: m.uid, ch: chanOf(m.ch), text: str(m.text, 2000), ts };
  }).filter(Boolean);
  const dms = (Array.isArray(d.dms) ? d.dms : []).slice(-100000).map((m) => {
    if (!m || typeof m.uid !== 'string' || !parseConv(m.conv)) return null;
    const ts = Number(m.ts) || 0;
    return { id: mkId(ts), uid: m.uid, conv: m.conv, text: str(m.text, 2000), ts };
  }).filter(Boolean);
  return { users, messages, dms };
}
async function writeBatches(ops) { // ops: array of (atomic) => void
  for (let i = 0; i < ops.length; i += 80) {
    const a = kv.atomic();
    ops.slice(i, i + 80).forEach((f) => f(a));
    const r = await a.commit();
    if (!r.ok) throw new Error('Could not write the backup.');
  }
}
async function wipe(prefixes) {
  for (const p of prefixes) {
    const keys = (await list([p])).map((e) => e.key);
    for (let i = 0; i < keys.length; i += 100) {
      const a = kv.atomic();
      keys.slice(i, i + 100).forEach((k) => a.delete(k));
      await a.commit();
    }
  }
}

// ---------- the app ----------
async function handle(req, info) {
  const url = new URL(req.url);
  const p = url.pathname;
  const method = req.method;

  if (method === 'GET' && ASSETS[p]) {
    return new Response(ASSETS[p][0], { status: 200, headers: baseHeaders({ 'Content-Type': ASSETS[p][1], 'Cache-Control': 'no-cache' }) });
  }
  if (method === 'GET' && p === '/healthz') return new Response('ok');
  if (!p.startsWith('/api/')) return new Response('Not found', { status: 404, headers: baseHeaders() });

  if (method !== 'GET') {
    const origin = req.headers.get('origin');
    let okOrigin = false;
    if (origin) { try { const oh = new URL(origin).host; okOrigin = oh === url.host || oh === req.headers.get('host'); } catch (_e) { okOrigin = false; } }
    else { const sf = req.headers.get('sec-fetch-site'); okOrigin = !sf || sf === 'same-origin' || sf === 'none'; }
    if (!okOrigin) return json({ error: 'Blocked request' }, 403);
  }

  try {
    const ip = clientIp(req, info);
    const { user: me, sessionHash } = await currentUser(req);

    if (method === 'GET' && p === '/api/me') {
      return json({ user: me ? pubSelf(me) : null, inviteRequired: !!INVITE_CODE, backups: !!ADMIN_KEY });
    }

    // ----- joining -----
    if (method === 'POST' && (p === '/api/join' || p === '/api/register' || p === '/api/login')) {
      if (await limited('auth:' + ip, 20, 10 * 60000)) return json({ error: 'Too many attempts. Wait a few minutes and try again.' }, 429);
      const b = await readJson(req);

      if (p === '/api/join') {
        const name = cleanName(b.name);
        if (INVITE_CODE && !(await safeEqual(String(b.invite || ''), INVITE_CODE))) return json({ error: 'That room code is not right.' }, 403);
        if (!validName(name)) return json({ error: NAME_ERR }, 400);
        const g = { id: crypto.randomUUID(), name, created: Date.now() };
        await kv.set(['user', g.id], g);
        return json({ user: pubSelf(g) }, 201, [await startSession(req, g.id)]);
      }

      const login = String(b.username || '').trim().toLowerCase();
      const pw = b.password;

      if (p === '/api/register') {
        if (INVITE_CODE && !(await safeEqual(String(b.invite || ''), INVITE_CODE))) return json({ error: 'That room code is not right.' }, 403);
        if (!validLogin(login)) return json({ error: LOGIN_ERR }, 400);
        if (!validPassword(pw)) return json({ error: PW_ERR }, 400);
        const nu = { id: crypto.randomUUID(), name: login, login, pass: await hashPassword(pw), created: Date.now() };
        const r = await kv.atomic().check({ key: ['login', login], versionstamp: null }).set(['login', login], nu.id).set(['user', nu.id], nu).commit();
        if (!r.ok) return json({ error: 'That username is taken. Pick another.' }, 409);
        return json({ user: pubSelf(nu) }, 201, [await startSession(req, nu.id)]);
      }

      // sign in
      if (await limited('login:' + login, 10, 10 * 60000)) return json({ error: 'Too many tries for that username. Wait a few minutes.' }, 429);
      const idRow = validLogin(login) ? await kv.get(['login', login]) : { value: null };
      const lu = idRow.value ? await getUser(idRow.value) : null;
      const good = validPassword(pw) ? await checkPassword(pw, lu && lu.pass) : false;
      if (!lu || !good) return json({ error: 'Wrong username or password.' }, 401);
      return json({ user: pubSelf(lu) }, 200, [await startSession(req, lu.id)]);
    }

    if (method === 'POST' && p === '/api/logout') {
      if (sessionHash) await kv.delete(['session', sessionHash]);
      return json({ ok: true }, 200, [sessionCookie(req, '', 0)]);
    }

    if (!me) return json({ error: 'Join the chat first.' }, 401);

    // ----- account -----
    if (method === 'POST' && p === '/api/account') {
      if (await limited('acct:' + ip, 20, 10 * 60000)) return json({ error: 'Too many attempts. Wait a few minutes.' }, 429);
      if (me.login) return json({ error: 'You already have a login.' }, 400);
      const ab = await readJson(req);
      const al = String(ab.username || '').trim().toLowerCase();
      if (!validLogin(al)) return json({ error: LOGIN_ERR }, 400);
      if (!validPassword(ab.password)) return json({ error: PW_ERR }, 400);
      const pass = await hashPassword(ab.password);
      const cur = await kv.get(['user', me.id]);
      if (!cur.value || cur.value.login) return json({ error: 'You already have a login.' }, 400);
      const nu = Object.assign({}, cur.value, { login: al, pass });
      const r = await kv.atomic().check({ key: ['login', al], versionstamp: null }).check(cur).set(['login', al], me.id).set(['user', me.id], nu).commit();
      if (!r.ok) return json({ error: 'That username is taken. Pick another.' }, 409);
      userCache.delete(me.id);
      return json({ user: pubSelf(nu) });
    }
    if (method === 'POST' && p === '/api/password') {
      if (await limited('pw:' + me.id, 10, 10 * 60000)) return json({ error: 'Too many attempts. Wait a few minutes.' }, 429);
      if (!me.login) return json({ error: 'Create a login first.' }, 400);
      const pb = await readJson(req);
      if (!validPassword(pb.password)) return json({ error: PW_ERR }, 400);
      const pass = await hashPassword(pb.password);
      const res = await updateUser(me.id, (u) => { u.pass = pass; });
      if (!res || res.error) return json({ error: (res && res.error) || 'Please try again.' }, 400);
      for (const e of await list(['usess', me.id])) {
        const h = e.key[2];
        if (h !== sessionHash) await kv.atomic().delete(['session', h]).delete(e.key).commit();
      }
      return json({ ok: true });
    }

    // ----- roles and profile -----
    if (method === 'POST' && p === '/api/role') {
      if (await limited('role:' + me.id, 10, 10 * 60000) || await limited('roleip:' + ip, 30, 10 * 60000)) return json({ error: 'Too many tries. Wait a few minutes.' }, 429);
      const rb = await readJson(req);
      const code = String(rb.code || '').trim().toLowerCase();
      const isOwner = await safeEqual(code, OWNER_CODE.toLowerCase());
      const isJl = await safeEqual(code, JL_CODE.toLowerCase());
      if (!isOwner && !isJl) return json({ error: "That code isn't valid." }, 403);
      const newRole = isOwner ? 'owner' : 'jl';
      const res = await updateUser(me.id, (u) => { if (u.role !== newRole) { u.role = newRole; delete u.roleLabel; delete u.nameColor; } });
      await tick(kv.atomic()).commit();
      return json({ user: pubSelf(res.user) });
    }
    if (method === 'POST' && p === '/api/profile') {
      if (await limited('prof:' + me.id, 30, 10 * 60000)) return json({ error: 'Slow down a little.' }, 429);
      const pr = await readJson(req);
      const res = await updateUser(me.id, (u) => {
        if (pr.name !== undefined) {
          const nn = cleanName(pr.name);
          if (!validName(nn)) return NAME_ERR;
          u.name = nn;
        }
        if (pr.roleLabel !== undefined || pr.nameColor !== undefined) {
          if (!u.role) return 'You need a role to change this.';
          if (pr.roleLabel !== undefined) {
            const lab = cleanName(pr.roleLabel);
            if (lab === '') delete u.roleLabel;
            else if (validLabel(lab)) u.roleLabel = lab;
            else return 'Role text can be up to 24 characters.';
          }
          if (pr.nameColor !== undefined) {
            if (pr.nameColor === '' || pr.nameColor === null) delete u.nameColor;
            else if (/^#[0-9a-fA-F]{6}$/.test(String(pr.nameColor))) u.nameColor = String(pr.nameColor).toLowerCase();
            else return 'Pick a color.';
          }
        }
      });
      if (!res || res.error) return json({ error: (res && res.error) || 'Please try again.' }, res && res.error === 'You need a role to change this.' ? 403 : 400);
      await tick(kv.atomic()).commit();
      return json({ user: pubSelf(res.user) });
    }

    if (method === 'GET' && p === '/api/users') {
      const rows = await list(['user'], { limit: 2000 });
      return json({ users: rows.map((e) => pubUser(e.value)) });
    }

    // ----- one call that returns everything the page needs -----
    if (method === 'GET' && p === '/api/sync') {
      const conv = url.searchParams.get('conv');
      const out = { user: pubSelf(me), backups: !!ADMIN_KEY, inviteRequired: !!INVITE_CODE };
      const jobs = [channelMessages(), dmSummaries(me)];
      const ids = conv ? parseConv(conv) : null;
      if (ids && (ids.indexOf(me.id) >= 0 || me.role === 'owner')) jobs.push(convMessages(conv));
      const r = await Promise.all(jobs);
      out.messages = r[0]; out.dms = r[1];
      if (r[2]) { out.conv = conv; out.convMessages = r[2]; }
      return json(out);
    }

    // ----- channels -----
    if (method === 'GET' && p === '/api/messages') return json({ messages: await channelMessages() });
    if (method === 'POST' && p === '/api/messages') {
      if (limitedLocal('msg:' + me.id, 30, 60000)) return json({ error: 'Slow down a little.' }, 429);
      const mb = await readJson(req);
      const ch = chanOf(mb.ch);
      if (ch === 'links' && me.role !== 'owner') return json({ error: 'You do not have permission to send messages in this channel.' }, 403);
      const text = String(mb.text || '').replace(/\r\n/g, '\n').trim();
      if (!text) return json({ error: 'Write something first.' }, 400);
      if (text.length > 2000) return json({ error: 'Messages can be up to 2000 characters.' }, 400);
      const m = { id: newId(), uid: me.id, ch, text, ts: Date.now() };
      await tick(kv.atomic().set(['msg', ch, m.id], m)).commit();
      if (Math.random() < 0.01) pruneChannel(ch).catch(() => {});
      return json({ message: pubMsg(m, new Map([[me.id, me]])) }, 201);
    }

    // ----- direct messages -----
    if (method === 'GET' && p === '/api/dms') return json({ dms: await dmSummaries(me) });
    const dmRoute = p.match(/^\/api\/dms\/([0-9a-f~-]{73})$/);
    if (dmRoute) {
      const conv = dmRoute[1];
      const ids2 = parseConv(conv);
      if (!ids2) return json({ error: 'Bad conversation.' }, 400);
      const inConv = ids2.indexOf(me.id) >= 0;
      if (method === 'GET') {
        if (!inConv && me.role !== 'owner') return json({ error: 'You can only open your own conversations.' }, 403);
        return json({ messages: await convMessages(conv) });
      }
      if (method === 'POST') {
        if (!inConv) return json({ error: 'Only the two people in a conversation can write in it.' }, 403);
        if (limitedLocal('msg:' + me.id, 30, 60000)) return json({ error: 'Slow down a little.' }, 429);
        const other = ids2[0] === me.id ? ids2[1] : ids2[0];
        if (!(await getUser(other))) return json({ error: 'That person is no longer here.' }, 404);
        const db2 = await readJson(req);
        const dt = String(db2.text || '').replace(/\r\n/g, '\n').trim();
        if (!dt) return json({ error: 'Write something first.' }, 400);
        if (dt.length > 2000) return json({ error: 'Messages can be up to 2000 characters.' }, 400);
        const dm = { id: newId(), uid: me.id, conv, text: dt, ts: Date.now() };
        const summary = { conv, ts: dm.ts, uid: me.id, text: dt.slice(0, 80) };
        await tick(kv.atomic()
          .set(['dm', conv, dm.id], dm)
          .set(['convs', ids2[0], conv], summary)
          .set(['convs', ids2[1], conv], summary)
          .set(['allconvs', conv], summary)).commit();
        return json({ message: pubMsg(dm, new Map([[me.id, me]])) }, 201);
      }
    }

    const del = p.match(/^\/api\/messages\/([0-9]{13}-[0-9a-f]{6})$/);
    if (method === 'DELETE' && del) {
      const id = del[1];
      const dconv = url.searchParams.get('conv');
      const ch = chanOf(url.searchParams.get('ch'));
      const key = dconv ? (parseConv(dconv) ? ['dm', dconv, id] : null) : ['msg', ch, id];
      if (!key) return json({ error: 'Message not found.' }, 404);
      const cur = await kv.get(key);
      if (!cur.value) return json({ error: 'Message not found.' }, 404);
      const modOk = !dconv && ch === 'suggestions' && me.role === 'owner'; // owners can clear any suggestion
      if (cur.value.uid !== me.id && !modOk) return json({ error: 'You can only delete your own messages.' }, 403);
      await tick(kv.atomic().check(cur).delete(key)).commit();
      return json({ ok: true });
    }

    // ----- backups (owner + ADMIN_KEY) -----
    if (p === '/api/admin/export' && method === 'GET') {
      if (await limited('admin:' + ip, 20, 10 * 60000)) return json({ error: 'Too many tries. Wait a few minutes.' }, 429);
      if (!ADMIN_KEY) return json({ error: 'Backups are off. Set ADMIN_KEY on the server to turn them on.' }, 403);
      if (!(await adminOk(req, me))) return json({ error: 'You need the Owner role and the correct admin key.' }, 403);
      const users = (await list(['user'])).map((e) => e.value);
      const messages = (await list(['msg'])).map((e) => e.value);
      const dms = (await list(['dm'])).map((e) => e.value);
      return json({ version: 2, exportedAt: Date.now(), users, messages, dms }, 200, [], { 'Content-Disposition': 'attachment; filename="quickchat-backup.json"' });
    }
    if (p === '/api/admin/import' && method === 'POST') {
      if (await limited('admin:' + ip, 20, 10 * 60000)) return json({ error: 'Too many tries. Wait a few minutes.' }, 429);
      if (!ADMIN_KEY) return json({ error: 'Backups are off. Set ADMIN_KEY on the server to turn them on.' }, 403);
      if (!(await adminOk(req, me))) return json({ error: 'You need the Owner role and the correct admin key.' }, 403);
      let data;
      try { data = sanitizeImport(await readJson(req, 25 * 1024 * 1024)); }
      catch (e) { return json({ error: e.message === 'too large' ? 'That file is too big.' : (e.message === 'bad json' ? 'That file is not a valid backup.' : e.message) }, 400); }
      await wipe(['user', 'login', 'msg', 'dm', 'convs', 'allconvs', 'session', 'usess']);
      const ops = [];
      data.users.forEach((u) => { ops.push((a) => { a.set(['user', u.id], u); if (u.login) a.set(['login', u.login], u.id); }); });
      data.messages.forEach((m) => ops.push((a) => a.set(['msg', m.ch, m.id], m)));
      data.dms.forEach((m) => ops.push((a) => a.set(['dm', m.conv, m.id], m)));
      const last = new Map();
      data.dms.forEach((m) => { const c = last.get(m.conv); if (!c || m.ts >= c.ts) last.set(m.conv, { conv: m.conv, ts: m.ts, uid: m.uid, text: m.text.slice(0, 80) }); });
      last.forEach((s, conv) => { const ids = conv.split('~'); ops.push((a) => a.set(['convs', ids[0], conv], s).set(['convs', ids[1], conv], s).set(['allconvs', conv], s)); });
      await writeBatches(ops);
      await tick(kv.atomic()).commit();
      return json({ ok: true, users: data.users.length, messages: data.messages.length, dms: data.dms.length }, 200, [sessionCookie(req, '', 0)]);
    }

    if (method === 'GET' && p === '/api/stream') return eventStream(req);

    return json({ error: 'Not found' }, 404);
  } catch (e) {
    console.error('Request failed:', e && e.stack ? e.stack : e);
    return json({ error: 'Bad request' }, 400);
  }
}

if (OWNER_CODE === 'gg') console.warn('WARNING: OWNER_CODE is the default "gg". Anyone can become an Owner and read every direct message. Set OWNER_CODE to something secret.');
if (!ADMIN_KEY) console.warn('Backups are off. Set ADMIN_KEY to let an Owner download and restore backups.');

const port = env('PORT', '');
Deno.serve(port ? { port: Number(port) } : {}, handle);
