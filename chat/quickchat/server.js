'use strict';
// Quick Chat server. No dependencies: plain Node.js (18+).
// No passwords: each browser gets an anonymous identity when it joins. Names are labels, not unique.
// People, sessions and messages live in one JSON file in DATA_DIR.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const INVITE_CODE = process.env.INVITE_CODE || '';
const OWNER_CODE = process.env.OWNER_CODE || 'gg';
const JL_CODE = process.env.JL_CODE || 'gh';
const MAX_MESSAGES = 5000;
const SESSION_MS = 365 * 24 * 3600 * 1000;
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');

fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');

let db = { users: [], sessions: {}, messages: [], nextId: 1 };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) { /* first run */ }

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(function () {
    saveTimer = null;
    var tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(db), function (err) {
      if (!err) fs.rename(tmp, DB_FILE, function () {});
    });
  }, 200);
}
function flushSync() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) {}
}
process.on('SIGTERM', function () { flushSync(); process.exit(0); });
process.on('SIGINT', function () { flushSync(); process.exit(0); });

// ---------- helpers ----------
function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function cleanName(s) { return String(s || '').trim().replace(/\s+/g, ' '); }
function validName(s) { return s.length >= 2 && s.length <= 30 && /^[\p{L}\p{N} ._'-]+$/u.test(s); }
function nameOf(uid) {
  var u = db.users.find(function (x) { return x.id === uid; });
  return u ? u.name : 'Former member';
}
function roleOf(uid) {
  var u = db.users.find(function (x) { return x.id === uid; });
  return (u && u.role) || null;
}
function pubUser(u) { return { id: u.id, name: u.name, role: u.role || null }; }
function pub(m) { return { id: m.id, uid: m.uid, ch: m.ch || 'general', name: nameOf(m.uid), role: roleOf(m.uid), text: m.text, ts: m.ts }; }
function safeEqual(a, b) { return crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest()); }

function parseCookies(req) {
  var out = {};
  String(req.headers.cookie || '').split(';').forEach(function (p) {
    var i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function currentUser(req) {
  var token = parseCookies(req).qc_session;
  if (!token) return null;
  var s = db.sessions[sha(token)];
  if (!s || s.exp < Date.now()) return null;
  return db.users.find(function (u) { return u.id === s.uid; }) || null;
}
function currentSession(req) {
  var token = parseCookies(req).qc_session;
  var s = token && db.sessions[sha(token)];
  return s && s.exp >= Date.now() ? s : null;
}
function setSession(req, res, uid) {
  var token = crypto.randomBytes(32).toString('hex');
  db.sessions[sha(token)] = { uid: uid, exp: Date.now() + SESSION_MS };
  var secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
  res.setHeader('Set-Cookie', 'qc_session=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(SESSION_MS / 1000) + (secure ? '; Secure' : ''));
  save();
}
function pruneSessions() {
  var now = Date.now();
  Object.keys(db.sessions).forEach(function (k) { if (db.sessions[k].exp < now) delete db.sessions[k]; });
}
setInterval(function () {
  pruneSessions();
  var keep = new Set();
  Object.keys(db.sessions).forEach(function (k) { keep.add(db.sessions[k].uid); });
  db.messages.forEach(function (m) { keep.add(m.uid); });
  var before = db.users.length;
  db.users = db.users.filter(function (u) { return keep.has(u.id); });
  if (db.users.length !== before) save();
}, 3600 * 1000).unref();

var buckets = new Map();
function limited(key, max, windowMs) {
  var now = Date.now();
  var b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++;
  return b.n > max;
}
setInterval(function () { var now = Date.now(); buckets.forEach(function (b, k) { if (b.reset < now) buckets.delete(k); }); }, 60000).unref();
function clientIp(req) { return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown'; }

function sendJson(res, code, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readJson(req) {
  return new Promise(function (resolve, reject) {
    var size = 0, chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > 20000) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

// ---------- live updates (server-sent events) ----------
var clients = new Set();
function broadcast(type, data) {
  var payload = 'data: ' + JSON.stringify(Object.assign({ type: type }, data)) + '\n\n';
  clients.forEach(function (res) { try { res.write(payload); } catch (e) {} });
}
setInterval(function () { clients.forEach(function (res) { try { res.write(': ping\n\n'); } catch (e) {} }); }, 25000).unref();

// ---------- routes ----------
var server = http.createServer(async function (req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");

  var url = new URL(req.url, 'http://x');
  var p = url.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    fs.readFile(INDEX_FILE, function (err, buf) {
      if (err) { res.writeHead(500); res.end('Missing public/index.html'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
    return;
  }
  if (req.method === 'GET' && p === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  if (!p.startsWith('/api/')) { res.writeHead(404); res.end('Not found'); return; }

  if (req.method !== 'GET') {
    var origin = req.headers.origin;
    if (origin) {
      var okOrigin = false;
      try { okOrigin = new URL(origin).host === req.headers.host; } catch (e) {}
      if (!okOrigin) return sendJson(res, 403, { error: 'Blocked request' });
    }
  }

  try {
    var me = currentUser(req);

    if (req.method === 'GET' && p === '/api/me') {
      return sendJson(res, 200, { user: me ? pubUser(me) : null, inviteRequired: !!INVITE_CODE });
    }

    if (req.method === 'POST' && p === '/api/join') {
      if (limited('join:' + clientIp(req), 20, 10 * 60000)) return sendJson(res, 429, { error: 'Too many attempts. Wait a few minutes and try again.' });
      var b = await readJson(req);
      var name = cleanName(b.name);
      if (INVITE_CODE && String(b.invite || '') !== INVITE_CODE) return sendJson(res, 403, { error: 'That room code is not right.' });
      if (!validName(name)) return sendJson(res, 400, { error: 'Names are 2 to 30 characters: letters, numbers, spaces and . _ \' -' });
      var user = { id: crypto.randomUUID(), name: name, created: Date.now() };
      db.users.push(user);
      setSession(req, res, user.id);
      return sendJson(res, 201, { user: pubUser(user) });
    }

    if (req.method === 'POST' && p === '/api/logout') {
      var tk = parseCookies(req).qc_session;
      if (tk) { delete db.sessions[sha(tk)]; save(); }
      res.setHeader('Set-Cookie', 'qc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
      return sendJson(res, 200, { ok: true });
    }

    if (!me) return sendJson(res, 401, { error: 'Join the chat first.' });

    if (req.method === 'POST' && p === '/api/role') {
      if (limited('role:' + me.id, 10, 10 * 60000) || limited('roleip:' + clientIp(req), 30, 10 * 60000)) return sendJson(res, 429, { error: 'Too many tries. Wait a few minutes.' });
      var rb2 = await readJson(req);
      var code = String(rb2.code || '').trim().toLowerCase();
      var isOwner = safeEqual(code, OWNER_CODE.toLowerCase());
      var isJl = safeEqual(code, JL_CODE.toLowerCase());
      if (!isOwner && !isJl) return sendJson(res, 403, { error: "That code isn't valid." });
      me.role = isOwner ? 'owner' : 'jl';
      save();
      broadcast('refresh', {});
      return sendJson(res, 200, { user: pubUser(me) });
    }

    if (req.method === 'POST' && p === '/api/rename') {
      var rb = await readJson(req);
      var nn = cleanName(rb.name);
      if (!validName(nn)) return sendJson(res, 400, { error: 'Names are 2 to 30 characters: letters, numbers, spaces and . _ \' -' });
      me.name = nn; save();
      broadcast('refresh', {});
      return sendJson(res, 200, { user: pubUser(me) });
    }

    if (req.method === 'GET' && p === '/api/messages') {
      var gen = db.messages.filter(function (x) { return (x.ch || 'general') === 'general'; }).slice(-200);
      var lnk = db.messages.filter(function (x) { return x.ch === 'links'; }).slice(-200);
      return sendJson(res, 200, { messages: gen.concat(lnk).sort(function (a, b) { return a.id - b.id; }).map(pub) });
    }

    if (req.method === 'POST' && p === '/api/messages') {
      if (limited('msg:' + me.id, 30, 60000)) return sendJson(res, 429, { error: 'Slow down a little.' });
      var mb = await readJson(req);
      var ch = mb.ch === 'links' ? 'links' : 'general';
      if (ch === 'links' && me.role !== 'owner') return sendJson(res, 403, { error: 'You do not have permission to send messages in this channel.' });
      var text = String(mb.text || '').replace(/\r\n/g, '\n').trim();
      if (!text) return sendJson(res, 400, { error: 'Write something first.' });
      if (text.length > 2000) return sendJson(res, 400, { error: 'Messages can be up to 2000 characters.' });
      var m = { id: db.nextId++, uid: me.id, ch: ch, text: text, ts: Date.now() };
      db.messages.push(m);
      if (db.messages.length > MAX_MESSAGES) db.messages.splice(0, db.messages.length - MAX_MESSAGES);
      save();
      broadcast('message', { message: pub(m) });
      return sendJson(res, 201, { message: pub(m) });
    }

    var del = p.match(/^\/api\/messages\/(\d+)$/);
    if (req.method === 'DELETE' && del) {
      var id = Number(del[1]);
      var idx = db.messages.findIndex(function (x) { return x.id === id; });
      if (idx < 0) return sendJson(res, 404, { error: 'Message not found.' });
      if (db.messages[idx].uid !== me.id) return sendJson(res, 403, { error: 'You can only delete your own messages.' });
      db.messages.splice(idx, 1); save();
      broadcast('delete', { id: id });
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n');
      clients.add(res);
      req.on('close', function () { clients.delete(res); });
      return;
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    if (!res.headersSent) sendJson(res, 400, { error: 'Bad request' });
  }
});

server.listen(PORT, function () {
  console.log('Quick Chat is running on port ' + PORT + (INVITE_CODE ? ' (invite code required)' : ''));
});
