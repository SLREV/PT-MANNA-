'use strict';
/**
 * Konfigurasi & akun pengguna — disimpan di data/config.json
 */
const path = require('path');
const crypto = require('crypto');
const { writeJSONAtomic, readJSON } = require('./util');

const DEFAULT_ADMIN = { username: 'admin', password: 'admin123' };
const TOKEN_TTL = 30 * 24 * 60 * 60 * 1000; // 30 hari

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}

class Config {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'config.json');
    const c = readJSON(this.file, null) || {};
    this.c = {
      users: Array.isArray(c.users) ? c.users : [],
      sessions: c.sessions && typeof c.sessions === 'object' ? c.sessions : {},
      cloud: {
        url: '',
        key: '',
        autoSync: true,
        interval: 60,
        ...(c.cloud || {}),
      },
      company: { name: 'PT. MANNA', sub: 'Engineering Teknik Indonesia', city: 'Bekasi', ...(c.company || {}) },
    };
    if (!this.c.users.length) {
      this.c.users.push({ username: DEFAULT_ADMIN.username, role: 'admin', mustChange: true, ...hashPassword(DEFAULT_ADMIN.password) });
      console.log(`[i] Akun awal dibuat -> username: ${DEFAULT_ADMIN.username}  password: ${DEFAULT_ADMIN.password}  (segera ganti!)`);
    }
    this.pruneSessions();
    this.save();
  }

  save() {
    writeJSONAtomic(this.file, this.c);
  }

  get cloud() {
    return this.c.cloud;
  }

  setCloud(patch) {
    const c = this.c.cloud;
    if (patch.url !== undefined) c.url = String(patch.url || '').trim();
    if (patch.key !== undefined) c.key = String(patch.key || '').trim();
    if (patch.autoSync !== undefined) c.autoSync = !!patch.autoSync;
    if (patch.interval !== undefined) c.interval = Math.max(15, Math.min(3600, parseInt(patch.interval, 10) || 60));
    this.save();
    return c;
  }

  get company() {
    return this.c.company;
  }

  setCompany(patch) {
    for (const k of ['name', 'sub', 'city']) if (patch[k] !== undefined) this.c.company[k] = String(patch[k]).slice(0, 120);
    this.save();
    return this.c.company;
  }

  /* ---------- users ---------- */
  findUser(username) {
    return this.c.users.find((u) => u.username.toLowerCase() === String(username || '').toLowerCase());
  }

  publicUser(u) {
    return { username: u.username, role: u.role, mustChange: !!u.mustChange };
  }

  listUsers() {
    return this.c.users.map((u) => this.publicUser(u));
  }

  addUser(username, password, role) {
    username = String(username || '').trim();
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) throw Object.assign(new Error('Username 3-32 karakter (huruf, angka, . _ -)'), { status: 400 });
    if (String(password || '').length < 6) throw Object.assign(new Error('Password minimal 6 karakter'), { status: 400 });
    if (this.findUser(username)) throw Object.assign(new Error('Username sudah ada'), { status: 409 });
    const u = { username, role: role === 'admin' ? 'admin' : 'staff', ...hashPassword(password) };
    this.c.users.push(u);
    this.save();
    return this.publicUser(u);
  }

  deleteUser(username, actor) {
    const u = this.findUser(username);
    if (!u) throw Object.assign(new Error('User tidak ditemukan'), { status: 404 });
    if (u.username === actor) throw Object.assign(new Error('Tidak bisa menghapus akun sendiri'), { status: 400 });
    if (u.role === 'admin' && this.c.users.filter((x) => x.role === 'admin').length <= 1)
      throw Object.assign(new Error('Minimal harus ada 1 admin'), { status: 400 });
    this.c.users = this.c.users.filter((x) => x !== u);
    for (const [t, s] of Object.entries(this.c.sessions)) if (s.username === u.username) delete this.c.sessions[t];
    this.save();
  }

  changePassword(username, oldPw, newPw) {
    const u = this.findUser(username);
    if (!u || !verifyPassword(oldPw, u)) throw Object.assign(new Error('Password lama salah'), { status: 400 });
    if (String(newPw || '').length < 6) throw Object.assign(new Error('Password baru minimal 6 karakter'), { status: 400 });
    Object.assign(u, hashPassword(newPw));
    u.mustChange = false;
    this.save();
  }

  /* ---------- sessions ---------- */
  login(username, password) {
    const u = this.findUser(username);
    if (!u || !verifyPassword(password, u)) return null;
    const token = crypto.randomBytes(32).toString('hex');
    this.c.sessions[token] = { username: u.username, exp: Date.now() + TOKEN_TTL };
    this.save();
    return { token, user: this.publicUser(u) };
  }

  logout(token) {
    delete this.c.sessions[token];
    this.save();
  }

  userFromToken(token) {
    const s = token && this.c.sessions[token];
    if (!s) return null;
    if (s.exp < Date.now()) {
      delete this.c.sessions[token];
      this.save();
      return null;
    }
    const u = this.findUser(s.username);
    return u ? this.publicUser(u) : null;
  }

  pruneSessions() {
    const now = Date.now();
    for (const [t, s] of Object.entries(this.c.sessions)) if (!s || s.exp < now) delete this.c.sessions[t];
  }
}

module.exports = { Config };
