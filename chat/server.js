'use strict';
// Quick Chat server. No dependencies: plain Node.js (18+).
// People, sessions, messages and DMs live in one JSON file in DATA_DIR (with a previous copy and daily snapshots).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('util');
const scrypt = util.promisify(crypto.scrypt);

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const INVITE_CODE = process.env.INVITE_CODE || '';
const OWNER_CODE = process.env.OWNER_CODE || 'gg';
const JL_CODE = process.env.JL_CODE || 'gh';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const MAX_MESSAGES = 5000;
const MAX_DMS = 20000;
const SESSION_MS = 365 * 24 * 3600 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch (e) { console.warn('No writable disk here: ' + e.message); }
const DB_FILE = path.join(DATA_DIR, 'db.json');

// ---------- storage ----------
function emptyDb() { return { users: [], sessions: {}, messages: [], dms: [], nextId: 1 }; }
function loadFile(f) { return Object.assign(emptyDb(), JSON.parse(fs.readFileSync(f, 'utf8'))); }
var db = emptyDb();
(function () {
  var files = [DB_FILE, DB_FILE + '.prev'];
  try { files = files.concat(fs.readdirSync(BACKUP_DIR).filter(function (f) { return /^db-\d{8}\.json$/.test(f); }).sort().reverse().map(function (f) { return path.join(BACKUP_DIR, f); })); } catch (e) {}
  for (var i = 0; i < files.length; i++) {
    try { db = loadFile(files[i]); if (i > 0) console.warn('Loaded data from ' + files[i] + ' because the main file could not be read.'); return; }
    catch (e) { if (e.code !== 'ENOENT') console.warn('Could not read ' + files[i] + ': ' + e.message); }
  }
})();
if (!Array.isArray(db.dms)) db.dms = [];

function writeAtomic(file, str, cb) {
  var tmp = file + '.tmp';
  fs.open(tmp, 'w', 0o600, function (err, fd) {
    if (err) return cb(err);
    fs.writeFile(fd, str, function (err2) {
      if (err2) { fs.close(fd, function () {}); return cb(err2); }
      fs.fsync(fd, function () { fs.close(fd, function () { fs.rename(tmp, file, cb); }); });
    });
  });
}
var lastSnapshot = '';
function snapshot(str) {
  var day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  if (day === lastSnapshot) return;
  lastSnapshot = day;
  fs.writeFile(path.join(BACKUP_DIR, 'db-' + day + '.json'), str, { mode: 0o600 }, function () {
    fs.readdir(BACKUP_DIR, function (err, list) {
      if (err) return;
      list.filter(function (f) { return /^db-\d{8}\.json$/.test(f); }).sort().slice(0, -7).forEach(function (f) { fs.unlink(path.join(BACKUP_DIR, f), function () {}); });
    });
  });
}

// ---------- Deno KV (permanent storage on Deno Deploy) ----------
// Deno Deploy wipes the local disk and shuts the app down when idle, so the JSON file cannot be trusted there.
// When Deno KV exists we keep the same in-memory db, but load it from KV at start and save it to KV after every change.
var HAS_KV = typeof Deno !== 'undefined' && typeof Deno.openKv === 'function';
var kv = null;
async function kvInit() {
  if (!HAS_KV) return;
  kv = await Deno.openKv();
  var meta = (await kv.get(['qc', 'meta'])).value;
  if (!meta) { console.log('KV is empty; starting from the local file (if any).'); return; }
  var parts = [];
  for (var i = 0; i < meta.n; i++) {
    var r = await kv.get(['qc', 'data', meta.v, i]);
    if (r.value == null) throw new Error('KV chunk ' + i + ' is missing');
    parts.push(r.value);
  }
  db = Object.assign(emptyDb(), JSON.parse(parts.join('')));
  if (!Array.isArray(db.dms)) db.dms = [];
  console.log('Loaded ' + db.users.length + ' users and ' + db.messages.length + ' messages from Deno KV.');
}
async function kvSave(str) {
  var CH = 16000, n = Math.ceil(str.length / CH) || 1, v = Date.now();
  var old = (await kv.get(['qc', 'meta'])).value;
  for (var i = 0; i < n; i++) await kv.set(['qc', 'data', v, i], str.slice(i * CH, (i + 1) * CH));
  await kv.set(['qc', 'meta'], { v: v, n: n });
  if (old) for (var j = 0; j < old.n; j++) await kv.delete(['qc', 'data', old.v, j]);
}
var saveTimer = null, saving = false, dirty = false;
function save() { dirty = true; if (saveTimer || saving) return; saveTimer = setTimeout(doSave, kv ? 50 : 250); }
function doSave() {
  saveTimer = null;
  if (saving) return;
  saving = true; dirty = false;
  var str = JSON.stringify(db);
  if (kv) {
    kvSave(str).catch(function (e) { console.error('KV save failed: ' + e.message); }).then(function () { saving = false; if (dirty) save(); });
    return;
  }
  fs.copyFile(DB_FILE, DB_FILE + '.prev', function () {
    writeAtomic(DB_FILE, str, function (err) {
      if (err) console.error('Save failed: ' + err.message); else snapshot(str);
      saving = false;
      if (dirty) save();
    });
  });
}
function flushSync() { if (kv) return; try { fs.writeFileSync(DB_FILE, JSON.stringify(db), { mode: 0o600 }); } catch (e) {} }
process.on('SIGTERM', function () { flushSync(); process.exit(0); });
process.on('SIGINT', function () { flushSync(); process.exit(0); });

// ---------- helpers ----------
function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function safeEqual(a, b) { return crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest()); }
async function hashPassword(pw) {
  var salt = crypto.randomBytes(16);
  var h = await scrypt(pw, salt, 64);
  return salt.toString('hex') + ':' + h.toString('hex');
}
var DUMMY_HASH = '00000000000000000000000000000000:' + '00'.repeat(64);
async function checkPassword(pw, stored) {
  var parts = String(stored || DUMMY_HASH).split(':');
  if (parts.length !== 2) parts = DUMMY_HASH.split(':');
  var h = await scrypt(pw, Buffer.from(parts[0], 'hex'), 64);
  var expected = Buffer.from(parts[1], 'hex');
  return h.length === expected.length && crypto.timingSafeEqual(h, expected) && stored !== undefined && stored !== null;
}
function cleanName(s) { return String(s || '').trim().replace(/\s+/g, ' '); }
function validName(s) { return s.length >= 2 && s.length <= 30 && /^[\p{L}\p{N} ._'-]+$/u.test(s); }
function validLogin(s) { return /^[a-z0-9._-]{2,30}$/.test(s); }
function validPassword(s) { return typeof s === 'string' && s.length >= 1 && s.length <= 200; }
function validLabel(s) { return s.length >= 1 && s.length <= 24 && !/[\u0000-\u001f\u007f<>]/.test(s); }
var NAME_ERR = "Names are 2 to 30 characters: letters, numbers, spaces and . _ ' -";

function userMap() { var m = new Map(); db.users.forEach(function (u) { m.set(u.id, u); }); return m; }
function findByLogin(l) { return db.users.find(function (u) { return u.login === l; }); }
function pubUser(u) { return { id: u.id, name: u.name, role: u.role || null, roleLabel: u.roleLabel || null, nameColor: u.nameColor || null }; }
function pubSelf(u) { var p = pubUser(u); p.login = u.login || null; return p; }
function pubMsg(m, um) {
  var u = um.get(m.uid);
  var o = u ? pubUser(u) : { id: m.uid, name: 'Former member', role: null, roleLabel: null, nameColor: null };
  return { id: m.id, uid: m.uid, ch: m.ch || 'general', conv: m.conv, name: o.name, role: o.role, roleLabel: o.roleLabel, nameColor: o.nameColor, text: m.text, ts: m.ts };
}
function convId(a, b) { return [a, b].sort().join('~'); }
function parseConv(c) {
  var p = String(c || '').split('~');
  if (p.length !== 2 || p[0] === p[1] || !/^[0-9a-f-]{36}$/.test(p[0]) || !/^[0-9a-f-]{36}$/.test(p[1])) return null;
  return p[0] < p[1] ? p : null;
}

function parseCookies(req) {
  var out = {};
  String(req.headers.cookie || '').split(';').forEach(function (p) {
    var i = p.indexOf('=');
    if (i > 0) { try { out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch (e) {} }
  });
  return out;
}
function sessionKey(req) { var t = parseCookies(req).qc_session; return t ? sha(t) : null; }
function currentUser(req) {
  var k = sessionKey(req);
  var s = k && db.sessions[k];
  if (!s || s.exp < Date.now()) return null;
  return db.users.find(function (u) { return u.id === s.uid; }) || null;
}
function isHttps(req) { return req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted; }
function setSession(req, res, uid) {
  var token = crypto.randomBytes(32).toString('hex');
  db.sessions[sha(token)] = { uid: uid, exp: Date.now() + SESSION_MS };
  res.setHeader('Set-Cookie', 'qc_session=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(SESSION_MS / 1000) + (isHttps(req) ? '; Secure' : ''));
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
  db.dms.forEach(function (m) { keep.add(m.uid); String(m.conv).split('~').forEach(function (x) { keep.add(x); }); });
  var before = db.users.length;
  // accounts with a login are never pruned; guests with no session and no messages are
  db.users = db.users.filter(function (u) { return u.login || keep.has(u.id); });
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
// The last X-Forwarded-For entry is the one added by the nearest proxy, so a client cannot fake it.
function clientIp(req) {
  var xff = String(req.headers['x-forwarded-for'] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : (req.socket.remoteAddress || 'unknown');
}

function sendJson(res, code, obj, extraHeaders) {
  var body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extraHeaders || {}));
  res.end(body);
}
function readJson(req, limit) {
  limit = limit || 20000;
  return new Promise(function (resolve, reject) {
    var size = 0, chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
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
var clients = new Map(); // res -> user id
function sseWrite(res, type, data) { try { res.write('data: ' + JSON.stringify(Object.assign({ type: type }, data)) + '\n\n'); } catch (e) {} }
function broadcast(type, data) { clients.forEach(function (uid, res) { sseWrite(res, type, data); }); }
function broadcastDm(conv, type, data) {
  var ids = conv.split('~'), um = userMap();
  clients.forEach(function (uid, res) {
    var u = um.get(uid);
    if (ids.indexOf(uid) >= 0 || (u && u.role === 'owner')) sseWrite(res, type, data);
  });
}
setInterval(function () { clients.forEach(function (uid, res) { try { res.write(': ping\n\n'); } catch (e) {} }); }, 25000).unref();

// ---------- static files ----------
var STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8']
};

function adminOk(req, me) {
  return !!ADMIN_KEY && !!me && me.role === 'owner' && safeEqual(req.headers['x-admin-key'] || '', ADMIN_KEY);
}
function sanitizeImport(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.users) || !Array.isArray(d.messages)) throw new Error('This is not a Quick Chat backup.');
  var str = function (v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; };
  var users = d.users.slice(0, 20000).map(function (u) {
    if (!u || typeof u.id !== 'string' || !/^[0-9a-f-]{36}$/.test(u.id)) return null;
    var o = { id: u.id, name: str(u.name, 30) || 'Member', created: Number(u.created) || Date.now() };
    if (typeof u.login === 'string' && validLogin(u.login)) o.login = u.login;
    if (typeof u.pass === 'string' && /^[0-9a-f]{32}:[0-9a-f]{128}$/.test(u.pass)) o.pass = u.pass;
    if (u.role === 'owner' || u.role === 'jl') o.role = u.role;
    if (typeof u.roleLabel === 'string' && validLabel(u.roleLabel)) o.roleLabel = u.roleLabel;
    if (typeof u.nameColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(u.nameColor)) o.nameColor = u.nameColor;
    return o;
  }).filter(Boolean);
  var maxId = 0;
  var messages = d.messages.slice(-MAX_MESSAGES).map(function (m) {
    if (!m || typeof m.uid !== 'string') return null;
    var id = parseInt(m.id, 10); if (!(id > 0)) return null; maxId = Math.max(maxId, id);
    return { id: id, uid: m.uid, ch: m.ch === 'links' ? 'links' : 'general', text: str(m.text, 2000), ts: Number(m.ts) || 0 };
  }).filter(Boolean);
  var dms = (Array.isArray(d.dms) ? d.dms : []).slice(-MAX_DMS).map(function (m) {
    if (!m || typeof m.uid !== 'string' || !parseConv(m.conv)) return null;
    var id = parseInt(m.id, 10); if (!(id > 0)) return null; maxId = Math.max(maxId, id);
    return { id: id, uid: m.uid, conv: m.conv, text: str(m.text, 2000), ts: Number(m.ts) || 0 };
  }).filter(Boolean);
  return { users: users, messages: messages, dms: dms, nextId: Math.max(maxId + 1, parseInt(d.nextId, 10) || 1) };
}

// ---------- routes ----------
var server = http.createServer(async function (req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');

  var url = new URL(req.url, 'http://x');
  var p = url.pathname;

  if (req.method === 'GET' && STATIC[p]) {
    fs.readFile(path.join(PUBLIC_DIR, STATIC[p][0]), function (err, buf) {
      if (err) { res.writeHead(500); res.end('Missing file'); return; }
      res.writeHead(200, { 'Content-Type': STATIC[p][1], 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
    return;
  }
  if (req.method === 'GET' && p === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  if (!p.startsWith('/api/')) { res.writeHead(404); res.end('Not found'); return; }

  if (req.method !== 'GET') {
    var origin = req.headers.origin;
    var okOrigin = false;
    if (origin) { try { okOrigin = new URL(origin).host === req.headers.host; } catch (e) {} }
    else okOrigin = !req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin' || req.headers['sec-fetch-site'] === 'none';
    if (!okOrigin) return sendJson(res, 403, { error: 'Blocked request' });
  }

  try {
    var me = currentUser(req);

    if (req.method === 'GET' && p === '/api/me') {
      return sendJson(res, 200, { user: me ? pubSelf(me) : null, inviteRequired: !!INVITE_CODE, backups: !!ADMIN_KEY });
    }

    // ----- joining -----
    if (req.method === 'POST' && (p === '/api/join' || p === '/api/register' || p === '/api/login')) {
      if (limited('auth:' + clientIp(req), 20, 10 * 60000)) return sendJson(res, 429, { error: 'Too many attempts. Wait a few minutes and try again.' });
      var b = await readJson(req);

      if (p === '/api/join') {
        var name = cleanName(b.name);
        if (INVITE_CODE && !safeEqual(String(b.invite || ''), INVITE_CODE)) return sendJson(res, 403, { error: 'That room code is not right.' });
        if (!validName(name)) return sendJson(res, 400, { error: NAME_ERR });
        var g = { id: crypto.randomUUID(), name: name, created: Date.now() };
        db.users.push(g); setSession(req, res, g.id);
        return sendJson(res, 201, { user: pubSelf(g) });
      }

      var login = String(b.username || '').trim().toLowerCase();
      var pw = b.password;
      if (p === '/api/register') {
        if (INVITE_CODE && !safeEqual(String(b.invite || ''), INVITE_CODE)) return sendJson(res, 403, { error: 'That room code is not right.' });
        if (!validLogin(login)) return sendJson(res, 400, { error: 'Usernames are 2 to 30 characters: letters, numbers and . _ -' });
        if (!validPassword(pw)) return sendJson(res, 400, { error: 'Enter a password (1 to 200 characters).' });
        if (findByLogin(login)) return sendJson(res, 409, { error: 'That username is taken. Pick another.' });
        var nu = { id: crypto.randomUUID(), name: login, login: login, pass: await hashPassword(pw), created: Date.now() };
        if (findByLogin(login)) return sendJson(res, 409, { error: 'That username is taken. Pick another.' });
        db.users.push(nu); setSession(req, res, nu.id);
        return sendJson(res, 201, { user: pubSelf(nu) });
      }

      // login
      if (limited('login:' + login, 10, 10 * 60000)) return sendJson(res, 429, { error: 'Too many tries for that username. Wait a few minutes.' });
      var lu = findByLogin(login);
      var good = validPassword(pw) ? await checkPassword(pw, lu && lu.pass) : false;
      if (!lu || !good) return sendJson(res, 401, { error: 'Wrong username or password.' });
      setSession(req, res, lu.id);
      return sendJson(res, 200, { user: pubSelf(lu) });
    }

    if (req.method === 'POST' && p === '/api/logout') {
      var k = sessionKey(req);
      if (k) { delete db.sessions[k]; save(); }
      res.setHeader('Set-Cookie', 'qc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
      return sendJson(res, 200, { ok: true });
    }

    if (!me) return sendJson(res, 401, { error: 'Join the chat first.' });

    // ----- account -----
    if (req.method === 'POST' && p === '/api/account') {
      if (limited('acct:' + clientIp(req), 20, 10 * 60000)) return sendJson(res, 429, { error: 'Too many attempts. Wait a few minutes.' });
      if (me.login) return sendJson(res, 400, { error: 'You already have a login.' });
      var ab = await readJson(req);
      var al = String(ab.username || '').trim().toLowerCase();
      if (!validLogin(al)) return sendJson(res, 400, { error: 'Usernames are 2 to 30 characters: letters, numbers and . _ -' });
      if (!validPassword(ab.password)) return sendJson(res, 400, { error: 'Enter a password (1 to 200 characters).' });
      if (findByLogin(al)) return sendJson(res, 409, { error: 'That username is taken. Pick another.' });
      me.pass = await hashPassword(ab.password);
      if (findByLogin(al)) return sendJson(res, 409, { error: 'That username is taken. Pick another.' });
      me.login = al; save();
      return sendJson(res, 200, { user: pubSelf(me) });
    }
    if (req.method === 'POST' && p === '/api/password') {
      if (limited('pw:' + me.id, 10, 10 * 60000)) return sendJson(res, 429, { error: 'Too many attempts. Wait a few minutes.' });
      if (!me.login) return sendJson(res, 400, { error: 'Create a login first.' });
      var pb = await readJson(req);
      if (!validPassword(pb.password)) return sendJson(res, 400, { error: 'Enter a password (1 to 200 characters).' });
      me.pass = await hashPassword(pb.password);
      var mine = sessionKey(req);
      Object.keys(db.sessions).forEach(function (key) { if (db.sessions[key].uid === me.id && key !== mine) delete db.sessions[key]; });
      save();
      return sendJson(res, 200, { ok: true });
    }

    // ----- roles and profile -----
    if (req.method === 'POST' && p === '/api/role') {
      if (limited('role:' + me.id, 10, 10 * 60000) || limited('roleip:' + clientIp(req), 30, 10 * 60000)) return sendJson(res, 429, { error: 'Too many tries. Wait a few minutes.' });
      var rb = await readJson(req);
      var code = String(rb.code || '').trim().toLowerCase();
      var isOwner = safeEqual(code, OWNER_CODE.toLowerCase());
      var isJl = safeEqual(code, JL_CODE.toLowerCase());
      if (!isOwner && !isJl) return sendJson(res, 403, { error: "That code isn't valid." });
      var newRole = isOwner ? 'owner' : 'jl';
      if (me.role !== newRole) { me.role = newRole; delete me.roleLabel; delete me.nameColor; }
      save(); broadcast('refresh', {});
      return sendJson(res, 200, { user: pubSelf(me) });
    }
    if (req.method === 'POST' && p === '/api/profile') {
      if (limited('prof:' + me.id, 30, 10 * 60000)) return sendJson(res, 429, { error: 'Slow down a little.' });
      var pr = await readJson(req);
      if (pr.name !== undefined) {
        var nn = cleanName(pr.name);
        if (!validName(nn)) return sendJson(res, 400, { error: NAME_ERR });
        me.name = nn;
      }
      if (pr.roleLabel !== undefined || pr.nameColor !== undefined) {
        if (!me.role) return sendJson(res, 403, { error: 'You need a role to change this.' });
        if (pr.roleLabel !== undefined) {
          var lab = cleanName(pr.roleLabel);
          if (lab === '') delete me.roleLabel;
          else if (validLabel(lab)) me.roleLabel = lab;
          else return sendJson(res, 400, { error: 'Role text can be up to 24 characters.' });
        }
        if (pr.nameColor !== undefined) {
          if (pr.nameColor === '' || pr.nameColor === null) delete me.nameColor;
          else if (/^#[0-9a-fA-F]{6}$/.test(String(pr.nameColor))) me.nameColor = String(pr.nameColor).toLowerCase();
          else return sendJson(res, 400, { error: 'Pick a color.' });
        }
      }
      save(); broadcast('refresh', {});
      return sendJson(res, 200, { user: pubSelf(me) });
    }

    if (req.method === 'GET' && p === '/api/users') {
      return sendJson(res, 200, { users: db.users.slice(0, 2000).map(pubUser) });
    }

    // ----- channels -----
    if (req.method === 'GET' && p === '/api/messages') {
      var um = userMap();
      var gen = db.messages.filter(function (x) { return (x.ch || 'general') === 'general'; }).slice(-200);
      var lnk = db.messages.filter(function (x) { return x.ch === 'links'; }).slice(-200);
      return sendJson(res, 200, { messages: gen.concat(lnk).sort(function (a, c) { return a.id - c.id; }).map(function (m) { return pubMsg(m, um); }) });
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
      var pm = pubMsg(m, userMap());
      broadcast('message', { message: pm });
      return sendJson(res, 201, { message: pm });
    }

    // ----- direct messages -----
    if (req.method === 'GET' && p === '/api/dms') {
      var um2 = userMap(), convs = new Map();
      db.dms.forEach(function (x) { var c = convs.get(x.conv); if (!c || x.ts >= c.last.ts) convs.set(x.conv, { conv: x.conv, last: x }); });
      var out = [];
      convs.forEach(function (c) {
        var ids = c.conv.split('~');
        var inIt = ids.indexOf(me.id) >= 0;
        if (!inIt && me.role !== 'owner') return;
        var gu = function (id) { var u = um2.get(id); return u ? pubUser(u) : { id: id, name: 'Former member', role: null, roleLabel: null, nameColor: null }; };
        out.push({ conv: c.conv, mine: inIt, a: gu(ids[0]), b: gu(ids[1]), last: { ts: c.last.ts, uid: c.last.uid, text: c.last.text.slice(0, 80) } });
      });
      out.sort(function (x, y) { return y.last.ts - x.last.ts; });
      return sendJson(res, 200, { dms: out });
    }
    var dmRoute = p.match(/^\/api\/dms\/([0-9a-f~-]{73})$/);
    if (dmRoute) {
      var ids2 = parseConv(dmRoute[1]);
      if (!ids2) return sendJson(res, 400, { error: 'Bad conversation.' });
      var inConv = ids2.indexOf(me.id) >= 0;
      if (req.method === 'GET') {
        if (!inConv && me.role !== 'owner') return sendJson(res, 403, { error: 'You can only open your own conversations.' });
        var um3 = userMap();
        return sendJson(res, 200, { messages: db.dms.filter(function (x) { return x.conv === dmRoute[1]; }).slice(-200).map(function (x) { return pubMsg(x, um3); }) });
      }
      if (req.method === 'POST') {
        if (!inConv) return sendJson(res, 403, { error: 'Only the two people in a conversation can write in it.' });
        if (limited('msg:' + me.id, 30, 60000)) return sendJson(res, 429, { error: 'Slow down a little.' });
        var other = ids2[0] === me.id ? ids2[1] : ids2[0];
        if (!db.users.some(function (u) { return u.id === other; })) return sendJson(res, 404, { error: 'That person is no longer here.' });
        var db2 = await readJson(req);
        var dt = String(db2.text || '').replace(/\r\n/g, '\n').trim();
        if (!dt) return sendJson(res, 400, { error: 'Write something first.' });
        if (dt.length > 2000) return sendJson(res, 400, { error: 'Messages can be up to 2000 characters.' });
        var dm = { id: db.nextId++, uid: me.id, conv: dmRoute[1], text: dt, ts: Date.now() };
        db.dms.push(dm);
        if (db.dms.length > MAX_DMS) db.dms.splice(0, db.dms.length - MAX_DMS);
        save();
        var pd = pubMsg(dm, userMap());
        broadcastDm(dm.conv, 'dm', { message: pd });
        return sendJson(res, 201, { message: pd });
      }
    }

    var del = p.match(/^\/api\/messages\/(\d+)$/);
    if (req.method === 'DELETE' && del) {
      var id = Number(del[1]);
      var idx = db.messages.findIndex(function (x) { return x.id === id; });
      if (idx >= 0) {
        if (db.messages[idx].uid !== me.id) return sendJson(res, 403, { error: 'You can only delete your own messages.' });
        db.messages.splice(idx, 1); save(); broadcast('delete', { id: id });
        return sendJson(res, 200, { ok: true });
      }
      var di = db.dms.findIndex(function (x) { return x.id === id; });
      if (di >= 0) {
        if (db.dms[di].uid !== me.id) return sendJson(res, 403, { error: 'You can only delete your own messages.' });
        var cv = db.dms[di].conv;
        db.dms.splice(di, 1); save(); broadcastDm(cv, 'dmdelete', { id: id, conv: cv });
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 404, { error: 'Message not found.' });
    }

    // ----- backups (owner + ADMIN_KEY) -----
    if (p === '/api/admin/export' && req.method === 'GET') {
      if (limited('admin:' + clientIp(req), 20, 10 * 60000)) return sendJson(res, 429, { error: 'Too many tries. Wait a few minutes.' });
      if (!ADMIN_KEY) return sendJson(res, 403, { error: 'Backups are off. Set ADMIN_KEY on the server to turn them on.' });
      if (!adminOk(req, me)) return sendJson(res, 403, { error: 'You need the Owner role and the correct admin key.' });
      var snap = { version: 1, exportedAt: Date.now(), users: db.users, messages: db.messages, dms: db.dms, nextId: db.nextId };
      return sendJson(res, 200, snap, { 'Content-Disposition': 'attachment; filename="quickchat-backup.json"' });
    }
    if (p === '/api/admin/import' && req.method === 'POST') {
      if (limited('admin:' + clientIp(req), 20, 10 * 60000)) return sendJson(res, 429, { error: 'Too many tries. Wait a few minutes.' });
      if (!ADMIN_KEY) return sendJson(res, 403, { error: 'Backups are off. Set ADMIN_KEY on the server to turn them on.' });
      if (!adminOk(req, me)) return sendJson(res, 403, { error: 'You need the Owner role and the correct admin key.' });
      var data;
      try { data = sanitizeImport(await readJson(req, 25 * 1024 * 1024)); }
      catch (e) { return sendJson(res, 400, { error: e.message === 'too large' ? 'That file is too big.' : (e.message === 'bad json' ? 'That file is not a valid backup.' : e.message) }); }
      db.users = data.users; db.messages = data.messages; db.dms = data.dms; db.nextId = data.nextId; db.sessions = {};
      save();
      clients.forEach(function (uid, r) { try { r.end(); } catch (e) {} }); clients.clear();
      res.setHeader('Set-Cookie', 'qc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
      return sendJson(res, 200, { ok: true, users: data.users.length, messages: data.messages.length, dms: data.dms.length });
    }

    if (req.method === 'GET' && p === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n');
      clients.set(res, me.id);
      req.on('close', function () { clients.delete(res); });
      return;
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    if (!res.headersSent) sendJson(res, 400, { error: 'Bad request' });
  }
});
server.headersTimeout = 15000;
server.requestTimeout = 60000;

kvInit().catch(function (e) { console.error('Could not open Deno KV: ' + e.message); if (HAS_KV) process.exit(1); }).then(function () {
server.listen(PORT, function () {
  console.log('Quick Chat is running on port ' + PORT + (INVITE_CODE ? ' (room code required)' : ''));
  if (OWNER_CODE === 'gg') console.warn('WARNING: OWNER_CODE is the default "gg". Anyone can become an Owner and read every direct message. Set OWNER_CODE to something secret.');
  if (JL_CODE === 'gh') console.warn('Note: JL_CODE is the default "gh".');
  if (!ADMIN_KEY) console.warn('Backups are off. Set ADMIN_KEY to let an Owner download and restore backups.');
});
});
