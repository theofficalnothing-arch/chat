// A small stand-in for the parts of Deno that server.js uses, so the server can be tested under Node.
// It is only for testing. Real hosting uses real Deno.
import http from 'node:http';
import fs from 'node:fs';

class KvU64 { constructor(v) { this.value = v; } }
const cmp = (a, b) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; }
  return a.length - b.length;
};
export function makeKv(file) {
  const store = new Map(); // json(key) -> { key, value, vs, exp }
  let vs = 0;
  const watchers = new Set();
  if (file && fs.existsSync(file)) {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    vs = d.vs;
    for (const r of d.rows) { if (r.big) r.value = new KvU64(BigInt(r.big)); store.set(JSON.stringify(r.key), r); }
  }
  const save = () => {
    if (!file) return;
    const rows = [...store.values()].map((r) => (r.value instanceof KvU64 ? { ...r, value: null, big: String(r.value.value) } : r));
    fs.writeFileSync(file, JSON.stringify({ vs, rows }));
  };
  const live = (k) => { const r = store.get(JSON.stringify(k)); if (!r) return null; if (r.exp && r.exp < Date.now()) { store.delete(JSON.stringify(k)); return null; } return r; };
  const entry = (k) => { const r = live(k); return { key: k, value: r ? (r.value instanceof KvU64 ? r.value : structuredClone(r.value)) : null, versionstamp: r ? String(r.vs) : null }; };
  const notify = (changed) => { for (const w of watchers) if (w.keys.some((k) => changed.some((c) => JSON.stringify(c) === JSON.stringify(k)))) w.fire(); };
  const kv = {
    async get(k) { return entry(k); },
    async getMany(ks) { return ks.map(entry); },
    async set(k, v, o) { store.set(JSON.stringify(k), { key: k, value: structuredClone(v), vs: ++vs, exp: o && o.expireIn ? Date.now() + o.expireIn : 0 }); save(); notify([k]); return { ok: true }; },
    async delete(k) { store.delete(JSON.stringify(k)); save(); notify([k]); },
    async *list(sel, opts) {
      opts = opts || {};
      const p = sel.prefix;
      let rows = [...store.values()].filter((r) => r.key.length >= p.length && cmp(r.key.slice(0, p.length), p) === 0 && r.key.length > p.length - 0 && !(r.exp && r.exp < Date.now()));
      rows.sort((a, b) => cmp(a.key, b.key));
      if (opts.reverse) rows.reverse();
      if (opts.limit) rows = rows.slice(0, opts.limit);
      for (const r of rows) yield entry(r.key);
    },
    atomic() {
      const checks = [], ops = [];
      const a = {
        check(...cs) { checks.push(...cs); return a; },
        set(k, v, o) { ops.push(['set', k, v, o]); return a; },
        delete(k) { ops.push(['del', k]); return a; },
        sum(k, n) { ops.push(['sum', k, n]); return a; },
        async commit() {
          for (const c of checks) { const cur = entry(c.key); if (cur.versionstamp !== (c.versionstamp === undefined ? null : c.versionstamp)) return { ok: false }; }
          if (ops.length > 1000) throw new Error('too many ops');
          vs++;
          const changed = [];
          for (const o of ops) {
            changed.push(o[1]);
            if (o[0] === 'set') store.set(JSON.stringify(o[1]), { key: o[1], value: structuredClone(o[2]), vs, exp: o[3] && o[3].expireIn ? Date.now() + o[3].expireIn : 0 });
            else if (o[0] === 'del') store.delete(JSON.stringify(o[1]));
            else { const cur = live(o[1]); const base = cur ? cur.value.value : 0n; store.set(JSON.stringify(o[1]), { key: o[1], value: new KvU64(base + o[2]), vs, exp: 0 }); }
          }
          save(); notify(changed);
          return { ok: true, versionstamp: String(vs) };
        }
      };
      return a;
    },
    watch(keys) {
      let w;
      return new ReadableStream({
        start(c) { w = { keys, fire: () => { try { c.enqueue(keys.map(entry)); } catch (_e) { /* closed */ } } }; watchers.add(w); w.fire(); },
        cancel() { watchers.delete(w); }
      });
    },
    close() {}
  };
  return kv;
}

export function installDeno() {
  globalThis.Deno = {
    env: { get: (n) => process.env[n] },
    openKv: async (p) => makeKv(p),
    serve(opts, handler) {
      const srv = http.createServer(async (nreq, nres) => {
        const ac = new AbortController();
        nres.on('close', () => ac.abort());
        const chunks = [];
        for await (const c of nreq) chunks.push(c);
        const body = Buffer.concat(chunks);
        const h = new Headers();
        for (const [k, v] of Object.entries(nreq.headers)) h.set(k, Array.isArray(v) ? v.join(', ') : v);
        const req = new Request('http://' + nreq.headers.host + nreq.url, { method: nreq.method, headers: h, body: ['GET', 'HEAD'].includes(nreq.method) ? undefined : body, signal: ac.signal });
        const res = await handler(req, { remoteAddr: { hostname: nreq.socket.remoteAddress } });
        const out = {};
        res.headers.forEach((v, k) => { out[k] = v; });
        const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
        if (sc.length) out['set-cookie'] = sc;
        nres.writeHead(res.status, out);
        if (!res.body) return nres.end();
        const r = res.body.getReader();
        try { for (;;) { const x = await r.read(); if (x.done) break; nres.write(x.value); } } catch (_e) { /* closed */ }
        nres.end();
      });
      srv.listen(opts.port || 8000);
      return srv;
    }
  };
}
