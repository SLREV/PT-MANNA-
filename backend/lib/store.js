'use strict';
/**
 * Penyimpanan lokal di PC (file JSON).
 *  - data/db.json          : seluruh data aplikasi
 *  - data/backups/*.json   : backup otomatis harian (disimpan 30 hari)
 *
 * Setiap record punya: id, createdAt, updatedAt, deleted (soft-delete)
 * Soft-delete dipakai supaya penghapusan ikut tersinkron ke cloud.
 */
const fs = require('fs');
const path = require('path');
const { uid, nowISO, localDate, ensureDir, writeJSONAtomic, readJSON } = require('./util');

const TYPES = ['po', 'suratjalan', 'invois', 'penawaran', 'keuangan'];
/** Tipe yang wajib punya nomor dokumen unik */
const NUMBERED = ['po', 'suratjalan', 'invois', 'penawaran'];
const BACKUP_KEEP = 30;

class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'db.json');
    this.backupDir = path.join(dataDir, 'backups');
    ensureDir(this.dir);
    ensureDir(this.backupDir);
    this.load();
    this.backup();
    // cek backup tiap jam (hanya membuat 1 file per hari)
    setInterval(() => this.backup(), 60 * 60 * 1000).unref();
  }

  load() {
    const db = readJSON(this.file, null) || {};
    this.db = {
      version: Number(db.version) || 0,
      collections: {},
      outbox: Array.isArray(db.outbox) ? db.outbox : [],
    };
    for (const t of TYPES) {
      this.db.collections[t] = Array.isArray(db.collections && db.collections[t]) ? db.collections[t] : [];
    }
    if (!fs.existsSync(this.file)) this.save();
  }

  save() {
    writeJSONAtomic(this.file, this.db);
  }

  backup() {
    try {
      if (!fs.existsSync(this.file)) return;
      const target = path.join(this.backupDir, `db-${localDate()}.json`);
      fs.copyFileSync(this.file, target);
      const files = fs.readdirSync(this.backupDir).filter((f) => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
      while (files.length > BACKUP_KEEP) fs.unlinkSync(path.join(this.backupDir, files.shift()));
    } catch (e) {
      console.error('[!] Backup gagal:', e.message);
    }
  }

  get version() {
    return this.db.version;
  }

  assertType(type) {
    if (!TYPES.includes(type)) {
      const err = new Error('Tipe data tidak dikenal: ' + type);
      err.status = 400;
      throw err;
    }
  }

  /** Data aktif (tanpa yang terhapus) */
  snapshot() {
    const data = {};
    for (const t of TYPES) data[t] = this.db.collections[t].filter((r) => !r.deleted);
    return { version: this.db.version, data };
  }

  find(type, id) {
    return this.db.collections[type].find((r) => r.id === id);
  }

  checkDuplicate(type, rec) {
    if (!NUMBERED.includes(type) || !rec.no) return;
    const no = String(rec.no).trim().toLowerCase();
    const dup = this.db.collections[type].find(
      (r) => !r.deleted && r.id !== rec.id && String(r.no || '').trim().toLowerCase() === no
    );
    if (dup) {
      const err = new Error(`Nomor ${rec.no} sudah dipakai`);
      err.status = 409;
      throw err;
    }
  }

  /** Tambah / ubah record dari aplikasi (akan dikirim ke cloud) */
  upsert(type, input, user) {
    this.assertType(type);
    if (!input || typeof input !== 'object') {
      const err = new Error('Data tidak valid');
      err.status = 400;
      throw err;
    }
    const rec = { ...input };
    delete rec.deleted;
    if (!rec.id) rec.id = uid();
    this.checkDuplicate(type, rec);
    const list = this.db.collections[type];
    const idx = list.findIndex((r) => r.id === rec.id);
    const now = nowISO();
    let saved;
    if (idx >= 0) {
      saved = { ...list[idx], ...rec, updatedAt: now, updatedBy: user || list[idx].updatedBy };
      list[idx] = saved;
    } else {
      saved = { ...rec, createdAt: rec.createdAt || now, updatedAt: now, createdBy: user, updatedBy: user };
      list.unshift(saved);
    }
    this.touch(type, saved.id);
    return saved;
  }

  remove(type, id, user) {
    this.assertType(type);
    const rec = this.find(type, id);
    if (!rec) return false;
    rec.deleted = true;
    rec.updatedAt = nowISO();
    rec.updatedBy = user;
    this.touch(type, id);
    return true;
  }

  touch(type, id) {
    this.db.version++;
    if (!this.db.outbox.some((o) => o.type === type && o.id === id)) this.db.outbox.push({ type, id });
    this.save();
  }

  /** Ambil antrean perubahan yang belum terkirim ke cloud (beserta isi record terbaru) */
  pendingOps(limit = 200) {
    return this.db.outbox
      .slice(0, limit)
      .map((o) => ({ type: o.type, id: o.id, record: this.find(o.type, o.id) }))
      .filter((o) => o.record);
  }

  /** Tandai perubahan sudah terkirim (hanya jika record tidak berubah lagi sejak dikirim) */
  ackOps(ops) {
    const sent = new Map(ops.map((o) => [o.type + ':' + o.id, o.record.updatedAt]));
    this.db.outbox = this.db.outbox.filter((o) => {
      const key = o.type + ':' + o.id;
      if (!sent.has(key)) return true;
      const cur = this.find(o.type, o.id);
      return cur && cur.updatedAt !== sent.get(key);
    });
    this.save();
  }

  get pendingCount() {
    return this.db.outbox.length;
  }

  /**
   * Gabungkan data dari cloud. Aturan: record dengan updatedAt paling baru yang dipakai.
   * Record dari cloud tidak masuk antrean kirim.
   */
  mergeFromCloud(data) {
    let changed = 0;
    for (const t of TYPES) {
      const rows = Array.isArray(data && data[t]) ? data[t] : [];
      const list = this.db.collections[t];
      for (const r of rows) {
        if (!r || !r.id) continue;
        const idx = list.findIndex((x) => x.id === r.id);
        if (idx < 0) {
          list.push(r);
          changed++;
        } else if (String(r.updatedAt || '') > String(list[idx].updatedAt || '')) {
          list[idx] = r;
          changed++;
        }
      }
    }
    if (changed) {
      this.db.version++;
      this.save();
    }
    return changed;
  }

  /** Ganti seluruh data (restore dari file backup) */
  restore(obj) {
    const cols = (obj && (obj.collections || obj.data)) || obj;
    if (!cols || typeof cols !== 'object') {
      const err = new Error('File backup tidak valid');
      err.status = 400;
      throw err;
    }
    this.backup();
    for (const t of TYPES) {
      const rows = Array.isArray(cols[t]) ? cols[t] : [];
      this.db.collections[t] = rows.map((r) => ({ ...r, id: r.id || uid(), updatedAt: nowISO() }));
      for (const r of this.db.collections[t]) {
        if (!this.db.outbox.some((o) => o.type === t && o.id === r.id)) this.db.outbox.push({ type: t, id: r.id });
      }
    }
    this.db.version++;
    this.save();
  }

  exportAll() {
    return { app: 'PT MANNA', exportedAt: nowISO(), version: this.db.version, collections: this.db.collections };
  }
}

module.exports = { Store, TYPES };
