'use strict';
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function uid() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function nowISO() {
  return new Date().toISOString();
}

/** Tanggal lokal (bukan UTC) dalam format YYYY-MM-DD */
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Daftar alamat IP LAN komputer ini (untuk diakses dari HP/Android) */
function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Tulis file secara atomik (tulis ke .tmp lalu rename) supaya file tidak rusak bila listrik mati */
function writeJSONAtomic(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[!] Gagal membaca ${file}:`, e.message);
    return fallback;
  }
}

module.exports = { uid, nowISO, localDate, lanAddresses, ensureDir, writeJSONAtomic, readJSON };
