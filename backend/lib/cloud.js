'use strict';
/**
 * Sinkronisasi ke cloud: Google Sheets (lewat Google Apps Script Web App, lihat cloud/Code.gs)
 *
 *  push : kirim antrean perubahan lokal -> Google Sheets
 *  pull : ambil semua data dari Google Sheets -> gabungkan ke lokal (yang terbaru menang)
 *  sync : push lalu pull
 *
 * Bila internet mati, perubahan tetap aman di antrean (data/db.json) dan dikirim saat online lagi.
 */

const TIMEOUT = 60000;

class Cloud {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this.status = { lastSync: null, lastPush: null, lastPull: null, lastError: null, running: false };
    this.timer = null;
    this.schedule();
  }

  get enabled() {
    return !!this.config.cloud.url;
  }

  schedule() {
    clearInterval(this.timer);
    const { autoSync, interval } = this.config.cloud;
    if (!autoSync) return;
    this.timer = setInterval(() => {
      if (this.enabled) this.sync().catch(() => {});
    }, Math.max(15, interval) * 1000);
    this.timer.unref();
  }

  info() {
    return { ...this.status, enabled: this.enabled, pending: this.store.pendingCount, ...this.config.cloud, key: this.config.cloud.key ? '••••••' : '' };
  }

  async request(method, params, body) {
    const { url, key } = this.config.cloud;
    if (!url) throw Object.assign(new Error('URL Google Apps Script belum diisi'), { status: 400 });
    const u = new URL(url);
    if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (key) u.searchParams.set('key', key);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT);
    let res;
    try {
      res = await fetch(u, {
        method,
        redirect: 'follow',
        signal: ctrl.signal,
        headers: body ? { 'Content-Type': 'text/plain;charset=utf-8' } : undefined,
        body: body ? JSON.stringify({ ...body, key }) : undefined,
      });
    } catch (e) {
      throw Object.assign(new Error(e.name === 'AbortError' ? 'Waktu habis menghubungi Google Sheets' : 'Tidak bisa terhubung ke internet / Google Sheets'), { status: 502 });
    } finally {
      clearTimeout(t);
    }
    const text = await res.text();
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      throw Object.assign(new Error('Respon Google bukan JSON — pastikan Web App di-deploy dengan akses "Anyone" dan URL berakhiran /exec'), { status: 502 });
    }
    if (!j.ok) throw Object.assign(new Error(j.msg || 'Google Sheets menolak permintaan'), { status: 502 });
    return j;
  }

  async test() {
    const j = await this.request('GET', { action: 'ping' });
    return { ok: true, msg: j.msg || 'Terhubung' };
  }

  async push() {
    let sent = 0;
    // kirim bertahap per 200 perubahan
    for (let guard = 0; guard < 100; guard++) {
      const ops = this.store.pendingOps(200);
      if (!ops.length) break;
      await this.request('POST', null, { action: 'batch', ops: ops.map((o) => ({ type: o.type, record: o.record })) });
      this.store.ackOps(ops);
      sent += ops.length;
      if (ops.length < 200) break;
    }
    this.status.lastPush = new Date().toISOString();
    return sent;
  }

  async pull() {
    const j = await this.request('GET', { action: 'data' });
    const changed = this.store.mergeFromCloud(j.data || {});
    this.status.lastPull = new Date().toISOString();
    return changed;
  }

  async sync() {
    if (this.status.running) return { busy: true };
    this.status.running = true;
    try {
      const pushed = await this.push();
      const pulled = await this.pull();
      this.status.lastSync = new Date().toISOString();
      this.status.lastError = null;
      if (pushed || pulled) console.log(`[cloud] sinkron: ${pushed} terkirim, ${pulled} diperbarui dari cloud`);
      return { pushed, pulled };
    } catch (e) {
      this.status.lastError = e.message;
      throw e;
    } finally {
      this.status.running = false;
    }
  }

  /** Dipanggil setelah ada perubahan data: kirim cepat (debounce 3 detik) */
  nudge() {
    if (!this.enabled || !this.config.cloud.autoSync) return;
    clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(() => {
      if (this.status.running) return;
      this.status.running = true;
      this.push()
        .then(() => (this.status.lastError = null))
        .catch((e) => (this.status.lastError = e.message))
        .finally(() => (this.status.running = false));
    }, 3000);
  }
}

module.exports = { Cloud };
