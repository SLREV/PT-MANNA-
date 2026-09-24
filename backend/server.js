#!/usr/bin/env node
'use strict';
/**
 * PT. MANNA — Backend Server
 * ------------------------------------------------------------
 * - Tanpa dependency (cukup Node.js 18+), jalan di Windows / Linux / macOS
 * - Menyajikan aplikasi (frontend/) untuk PC & Android (PWA)
 * - REST API + login
 * - Penyimpanan lokal di PC (data/db.json + backup harian)
 * - Sinkronisasi cloud ke Google Sheets (cloud/Code.gs)
 *
 * Jalankan:  node backend/server.js      (atau start-windows.bat)
 * Opsi env:  PORT=3000  HOST=0.0.0.0  DATA_DIR=./data
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Store, TYPES } = require('./lib/store');
const { Config } = require('./lib/config');
const { Cloud } = require('./lib/cloud');
const { lanAddresses } = require('./lib/util');
const pkg = require('./package.json');

const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const FRONTEND_DIR = path.join(ROOT, 'frontend');
const MAX_BODY = 20 * 1024 * 1024;

const store = new Store(DATA_DIR);
const config = new Config(DATA_DIR);
const cloud = new Cloud(store, config);

/* ============================================================
   Helpers
   ============================================================ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function fail(status, msg) {
  return Object.assign(new Error(msg), { status });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(fail(413, 'Data terlalu besar'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(fail(400, 'Format JSON tidak valid'));
      }
    });
    req.on('error', reject);
  });
}

function clientIP(req) {
  return (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
}

/* Batasi percobaan login yang gagal (anti tebak password) */
const loginFails = new Map();
function checkLoginRate(ip) {
  const f = loginFails.get(ip);
  if (f && f.count >= 10 && Date.now() - f.first < 15 * 60 * 1000) throw fail(429, 'Terlalu banyak percobaan login. Coba lagi 15 menit lagi.');
}
function recordLoginFail(ip) {
  const f = loginFails.get(ip);
  if (!f || Date.now() - f.first > 15 * 60 * 1000) loginFails.set(ip, { count: 1, first: Date.now() });
  else f.count++;
}

/* ============================================================
   Static files (frontend)
   ============================================================ */
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(FRONTEND_DIR, rel));
  if (file !== FRONTEND_DIR && !file.startsWith(FRONTEND_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // SPA fallback
      if (!path.extname(rel)) return serveStatic(req, res, '/index.html');
      return send(res, 404, 'Not found');
    }
    const ext = path.extname(file).toLowerCase();
    const noCache = ['.html', '.webmanifest'].includes(ext) || rel === '/sw.js';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
  });
}

/* ============================================================
   API routes
   ============================================================ */
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
  routes.push({ method, re, keys, handler, auth: opts.auth !== false, admin: !!opts.admin });
}

route('GET', '/api/health', () => ({
  ok: true,
  app: 'PT MANNA',
  version: pkg.version,
  company: config.company,
  time: new Date().toISOString(),
}), { auth: false });

route('POST', '/api/login', async ({ body, req }) => {
  const ip = clientIP(req);
  checkLoginRate(ip);
  const r = config.login(body.username, body.password);
  if (!r) {
    recordLoginFail(ip);
    throw fail(401, 'Username atau password salah');
  }
  loginFails.delete(ip);
  return { ok: true, ...r };
}, { auth: false });

route('POST', '/api/logout', ({ token }) => {
  config.logout(token);
  return { ok: true };
});

route('GET', '/api/me', ({ user }) => ({ ok: true, user, company: config.company }));

route('POST', '/api/password', ({ user, body }) => {
  config.changePassword(user.username, body.oldPassword, body.newPassword);
  return { ok: true };
});

/* ---------- data ---------- */
route('GET', '/api/data', () => ({ ok: true, ...store.snapshot() }));

route('GET', '/api/version', () => ({
  ok: true,
  version: store.version,
  cloud: { enabled: cloud.enabled, pending: store.pendingCount, lastSync: cloud.status.lastSync, lastError: cloud.status.lastError },
}));

route('POST', '/api/records/:type', ({ params, body, user }) => {
  const rec = store.upsert(params.type, body, user.username);
  cloud.nudge();
  return { ok: true, record: rec, version: store.version };
});

route('PUT', '/api/records/:type/:id', ({ params, body, user }) => {
  if (!store.find(params.type, params.id)) throw fail(404, 'Data tidak ditemukan');
  const rec = store.upsert(params.type, { ...body, id: params.id }, user.username);
  cloud.nudge();
  return { ok: true, record: rec, version: store.version };
});

route('DELETE', '/api/records/:type/:id', ({ params, user }) => {
  store.assertType(params.type);
  if (!store.remove(params.type, params.id, user.username)) throw fail(404, 'Data tidak ditemukan');
  cloud.nudge();
  return { ok: true, version: store.version };
});

/** Terima banyak perubahan sekaligus (antrean offline dari HP / PC) */
route('POST', '/api/bulk', ({ body, user }) => {
  const ops = Array.isArray(body.ops) ? body.ops : [];
  const results = ops.map((op) => {
    try {
      if (op.op === 'delete') {
        store.remove(op.type, op.id, user.username);
        return { ok: true, qid: op.qid };
      }
      const rec = store.upsert(op.type, op.record, user.username);
      return { ok: true, qid: op.qid, record: rec };
    } catch (e) {
      return { ok: false, qid: op.qid, msg: e.message, status: e.status || 500 };
    }
  });
  if (ops.length) cloud.nudge();
  return { ok: true, results, version: store.version };
});

/* ---------- backup ---------- */
route('GET', '/api/backup', () => store.exportAll());

route('POST', '/api/restore', ({ body }) => {
  store.restore(body);
  cloud.nudge();
  return { ok: true, version: store.version };
}, { admin: true });

/* ---------- pengaturan ---------- */
route('GET', '/api/settings', ({ user }) => ({
  ok: true,
  company: config.company,
  cloud: cloud.info(),
  server: {
    port: PORT,
    dataDir: user.role === 'admin' ? DATA_DIR : undefined,
    lan: lanAddresses().map((ip) => `http://${ip}:${PORT}`),
  },
}));

route('PUT', '/api/settings', ({ body }) => {
  if (body.cloud) {
    const patch = { ...body.cloud };
    if (patch.key === '••••••') delete patch.key; // tidak diubah
    config.setCloud(patch);
    cloud.schedule();
  }
  if (body.company) config.setCompany(body.company);
  return { ok: true, company: config.company, cloud: cloud.info() };
}, { admin: true });

route('POST', '/api/cloud/test', async () => cloud.test());
route('POST', '/api/cloud/sync', async () => ({ ok: true, ...(await cloud.sync()), cloud: cloud.info(), version: store.version }));
route('POST', '/api/cloud/push', async () => ({ ok: true, pushed: await cloud.push(), cloud: cloud.info() }));
route('POST', '/api/cloud/pull', async () => ({ ok: true, pulled: await cloud.pull(), cloud: cloud.info(), version: store.version }));

/* ---------- users ---------- */
route('GET', '/api/users', () => ({ ok: true, users: config.listUsers() }), { admin: true });
route('POST', '/api/users', ({ body }) => ({ ok: true, user: config.addUser(body.username, body.password, body.role) }), { admin: true });
route('DELETE', '/api/users/:name', ({ params, user }) => {
  config.deleteUser(decodeURIComponent(params.name), user.username);
  return { ok: true };
}, { admin: true });

/* ============================================================
   Server
   ============================================================ */
async function handleApi(req, res, url) {
  const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
  if (!r) throw fail(404, 'Endpoint tidak ditemukan');
  const m = url.pathname.match(r.re);
  const params = {};
  r.keys.forEach((k, i) => (params[k] = m[i + 1]));
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
  const user = config.userFromToken(token);
  if (r.auth && !user) throw fail(401, 'Silakan login terlebih dahulu');
  if (r.admin && user.role !== 'admin') throw fail(403, 'Hanya admin yang boleh melakukan ini');
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
  const out = await r.handler({ req, res, url, params, body, user, token });
  if (!res.headersSent) send(res, 200, out);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // CORS — supaya aplikasi juga bisa dipasang dari domain lain / aplikasi Android (WebView)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (e) {
      const status = e.status || 500;
      if (!e.status) console.error('[API]', req.method, url.pathname, e);
      else if (status >= 500) console.warn('[API]', req.method, url.pathname, '-', e.message);
      if (!res.headersSent) send(res, status, { ok: false, msg: e.message || 'Terjadi kesalahan server' });
    }
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  serveStatic(req, res, url.pathname);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n[X] Port ${PORT} sudah dipakai. Mungkin server PT MANNA sudah berjalan, atau jalankan dengan port lain:  set PORT=3001`);
  } else console.error(e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const line = '='.repeat(62);
  console.log(`\n${line}\n  PT. MANNA — Server berjalan (v${pkg.version})\n${line}`);
  console.log(`  Buka di PC ini   : http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  Buka di HP (WiFi): http://${ip}:${PORT}`);
  console.log(`  Data tersimpan di: ${DATA_DIR}`);
  console.log(`  Cloud (Sheets)   : ${cloud.enabled ? 'AKTIF' : 'belum diatur (menu Pengaturan)'}`);
  console.log(`${line}\n  Jangan tutup jendela ini selama aplikasi dipakai.\n`);
  if (cloud.enabled) cloud.sync().catch((e) => console.log('[cloud] belum bisa sinkron:', e.message));
});

function shutdown() {
  console.log('\nMenyimpan data & mematikan server...');
  try {
    store.save();
  } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
