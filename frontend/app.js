/* ============================================================
   PT. MANNA — Frontend (PC & Android / PWA)
   ------------------------------------------------------------
   - Semua data disimpan di server PC (backend/server.js)
   - Cache lokal + antrean offline: tetap bisa input saat koneksi putus,
     otomatis terkirim ke server saat online kembali
   - Server menyinkronkan data ke cloud (Google Sheets)
   ============================================================ */
'use strict';

const LS = { token: 'ptmanna_token', user: 'ptmanna_user', cache: 'ptmanna_cache_v2', queue: 'ptmanna_queue_v2' };
const TYPES = ['po', 'suratjalan', 'invois', 'penawaran', 'keuangan'];
const TYPE_KEY = { po: 'po', sj: 'suratjalan', inv: 'invois', pen: 'penawaran', fin: 'keuangan' };
const LABEL = { po: 'Purchase Order', sj: 'Surat Jalan', inv: 'Invois', pen: 'Penawaran', fin: 'Transaksi' };
const POLL_MS = 8000;
const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const BULAN_PANJANG = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const KATEGORI = {
  masuk: ['Pembayaran Invois', 'DP / Uang Muka', 'Penjualan Lain', 'Lainnya'],
  keluar: ['Pembelian Material', 'Gaji Karyawan', 'Operasional', 'Transportasi', 'Sewa Alat', 'Listrik & Air', 'Lainnya'],
};

let token = localStorage.getItem(LS.token) || '';
let me = readLS(LS.user, null);
let company = { name: 'PT. MANNA', sub: 'Engineering Teknik Indonesia', city: 'Bekasi' };
let DB = emptyDB();
let dbVersion = 0;
let queue = readLS(LS.queue, []);
let online = null;
let cloudInfo = null;
let flushing = false;
let pollTimer = null;
let currentPage = 'dashboard';
const editing = { po: null, sj: null, inv: null, pen: null };

/* ============================================================
   Utilitas
   ============================================================ */
function readLS(k, fb) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? fb : v; } catch { return fb; } }
function writeLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('localStorage penuh', e); } }
function emptyDB() { const d = {}; TYPES.forEach((t) => (d[t] = [])); return d; }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 9); }
function $(id) { return document.getElementById(id); }
function fmt(n) { return 'Rp ' + Math.round(Number(n || 0)).toLocaleString('id-ID'); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function localDate(d = new Date()) { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function tglIndo(s) { if (!s) return '-'; const [y, m, d] = s.split('-'); return `${parseInt(d, 10)} ${BULAN_PANJANG[parseInt(m, 10) - 1] || ''} ${y}`; }
function short(n) { return n >= 1e9 ? (n / 1e9).toFixed(1) + 'M' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'jt' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'rb' : String(n); }
function ago(iso) {
  if (!iso) return 'belum pernah';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return s + ' detik lalu';
  if (s < 3600) return Math.round(s / 60) + ' menit lalu';
  if (s < 86400) return Math.round(s / 3600) + ' jam lalu';
  return new Date(iso).toLocaleString('id-ID');
}
function val(id, v) {
  const el = $(id);
  if (v !== undefined) { el.value = v; return; }
  return el.value.trim();
}
function icon(name) { return `<svg fill="none" stroke="currentColor"><use href="#i-${name}"/></svg>`; }
function sumItems(items) { return (items || []).reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.harga) || 0), 0); }

/** Terbilang (angka ke kata) untuk invois */
function terbilang(n) {
  n = Math.floor(Math.abs(Number(n) || 0));
  const s = ['', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan', 'sepuluh', 'sebelas'];
  const f = (x) => {
    if (x < 12) return s[x];
    if (x < 20) return f(x - 10) + ' belas';
    if (x < 100) return f(Math.floor(x / 10)) + ' puluh ' + f(x % 10);
    if (x < 200) return 'seratus ' + f(x - 100);
    if (x < 1000) return f(Math.floor(x / 100)) + ' ratus ' + f(x % 100);
    if (x < 2000) return 'seribu ' + f(x - 1000);
    if (x < 1e6) return f(Math.floor(x / 1000)) + ' ribu ' + f(x % 1000);
    if (x < 1e9) return f(Math.floor(x / 1e6)) + ' juta ' + f(x % 1e6);
    if (x < 1e12) return f(Math.floor(x / 1e9)) + ' miliar ' + f(x % 1e9);
    return f(Math.floor(x / 1e12)) + ' triliun ' + f(x % 1e12);
  };
  const r = n === 0 ? 'nol' : f(n);
  return (r.replace(/\s+/g, ' ').trim() + ' rupiah').replace(/^./, (c) => c.toUpperCase());
}

/* ============================================================
   API
   ============================================================ */
async function api(method, path, body) {
  let res;
  try {
    res = await fetch('api/' + path, {
      method,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const err = new Error('Tidak bisa terhubung ke server');
    err.offline = true;
    throw err;
  }
  let j;
  try { j = await res.json(); } catch { j = { ok: false, msg: 'Respon server tidak valid (HTTP ' + res.status + ')' }; }
  if (res.status === 401 && path !== 'login') { onUnauthorized(); }
  if (!res.ok || j.ok === false) {
    const err = new Error(j.msg || 'HTTP ' + res.status);
    err.status = res.status;
    throw err;
  }
  return j;
}

/* ============================================================
   Sinkronisasi data (cache + antrean offline)
   ============================================================ */
function persistCache() { writeLS(LS.cache, { version: dbVersion, user: me && me.username, data: DB }); }
function saveQueue() { writeLS(LS.queue, queue); }

function loadCache() {
  const c = readLS(LS.cache, null);
  if (c && c.data && (!me || c.user === me.username)) {
    DB = { ...emptyDB(), ...c.data };
    dbVersion = c.version || 0;
  }
}

function applyLocal(op) {
  const list = DB[op.type];
  if (!list) return;
  if (op.op === 'delete') {
    DB[op.type] = list.filter((r) => r.id !== op.id);
    return;
  }
  const idx = list.findIndex((r) => r.id === op.record.id);
  if (idx >= 0) list[idx] = { ...list[idx], ...op.record };
  else list.unshift(op.record);
}

/** Simpan perubahan: langsung tampil, lalu dikirim ke server (atau antre bila offline) */
function commit(op) {
  op.qid = uid();
  queue.push(op);
  saveQueue();
  applyLocal(op);
  persistCache();
  render();
  flushQueue();
}

async function flushQueue() {
  if (flushing || !queue.length || !token) return;
  flushing = true;
  try {
    while (queue.length) {
      const batch = queue.slice(0, 100);
      const r = await api('POST', 'bulk', { ops: batch });
      const done = new Set(batch.map((o) => o.qid));
      queue = queue.filter((o) => !done.has(o.qid));
      saveQueue();
      (r.results || []).filter((x) => !x.ok).forEach((x) => toast('Gagal menyimpan: ' + x.msg, 'err'));
      setOnline(true);
    }
    await pullData();
  } catch (e) {
    if (e.offline) setOnline(false);
    else if (e.status !== 401) toast(e.message, 'err');
  } finally {
    flushing = false;
    updateConn();
  }
}

async function pullData() {
  const r = await api('GET', 'data');
  DB = { ...emptyDB(), ...r.data };
  dbVersion = r.version;
  queue.forEach(applyLocal); // perubahan yang belum terkirim tetap terlihat
  persistCache();
  setOnline(true);
  render();
}

async function poll() {
  if (!token) return;
  try {
    if (queue.length) await flushQueue();
    const r = await api('GET', 'version');
    setOnline(true);
    cloudInfo = r.cloud;
    if (r.version !== dbVersion && !queue.length) await pullData();
    updateConn();
  } catch (e) {
    if (e.offline) setOnline(false);
  }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, POLL_MS);
}

function manualRefresh() {
  toast('Memuat ulang data...');
  poll().then(() => pullData()).catch(() => toast('Server tidak dapat dihubungi — mode offline', 'err'));
}

function setOnline(v) {
  if (online === v) return;
  const was = online;
  online = v;
  updateConn();
  if (was === false && v) toast('Terhubung kembali ke server ✓');
  if (was !== false && v === false) toast('Koneksi ke server terputus — data disimpan sementara di perangkat', 'err');
}

function updateConn() {
  const el = $('connStatus');
  if (!el) return;
  const pending = queue.length;
  el.className = 'pill-status' + (online === false ? ' off' : pending ? ' warn' : '');
  el.querySelector('.txt').textContent =
    online === false ? `Offline${pending ? ' · ' + pending + ' antre' : ''}` : pending ? `Mengirim ${pending}...` : 'Server Terhubung';
  const c = $('cloudStatus');
  if (cloudInfo && cloudInfo.enabled) {
    c.hidden = false;
    c.className = 'pill-status cloud' + (cloudInfo.lastError ? ' err' : '');
    c.title = cloudInfo.lastError ? 'Cloud error: ' + cloudInfo.lastError : 'Sinkron cloud terakhir: ' + ago(cloudInfo.lastSync);
    c.querySelector('.txt').textContent = cloudInfo.lastError ? 'Cloud error' : cloudInfo.pending ? `Cloud · ${cloudInfo.pending} antre` : 'Cloud ✓';
  } else c.hidden = true;
}

/* ============================================================
   Login / sesi
   ============================================================ */
function onUnauthorized() {
  if (!token) return;
  token = '';
  localStorage.removeItem(LS.token);
  showLogin('Sesi berakhir, silakan login kembali.');
}

function showLogin(msg) {
  clearInterval(pollTimer);
  $('app').hidden = true;
  $('loginScreen').hidden = false;
  $('loginErr').textContent = msg || '';
  $('loginServer').textContent = 'Server: ' + location.host;
  setTimeout(() => $('login_user').focus(), 50);
}

async function showApp() {
  $('loginScreen').hidden = true;
  $('app').hidden = false;
  document.body.classList.toggle('is-admin', !!me && me.role === 'admin');
  $('userName').textContent = me ? me.username : '-';
  $('userRole').textContent = me ? (me.role === 'admin' ? 'Administrator' : 'Staff') + ' · ' + (company.city || '') : '';
  $('userAvatar').textContent = me ? me.username.charAt(0).toUpperCase() : '?';
  $('pwBanner').hidden = !(me && me.mustChange);
  applyCompany();
  loadCache();
  initForms();
  render();
  startPolling();
  try { await pullData(); await flushQueue(); await poll(); } catch (e) { if (e.offline) setOnline(false); }
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginErr').textContent = '';
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const r = await api('POST', 'login', { username: val('login_user'), password: $('login_pass').value });
    token = r.token;
    me = r.user;
    localStorage.setItem(LS.token, token);
    writeLS(LS.user, me);
    $('login_pass').value = '';
    await showApp();
  } catch (err) {
    $('loginErr').textContent = err.offline ? 'Server tidak dapat dihubungi. Pastikan server PC menyala.' : err.message;
  } finally {
    btn.disabled = false;
  }
});

async function logout() {
  if (queue.length && !confirm(`Masih ada ${queue.length} data yang belum terkirim ke server. Tetap keluar? (data tersebut akan hilang)`)) return;
  try { await api('POST', 'logout'); } catch {}
  token = '';
  me = null;
  queue = [];
  DB = emptyDB();
  [LS.token, LS.user, LS.cache, LS.queue].forEach((k) => localStorage.removeItem(k));
  showLogin();
}

function applyCompany() {
  document.querySelectorAll('[data-company]').forEach((el) => (el.textContent = company[el.dataset.company] || ''));
  document.title = company.name + ' — Sistem Data & Dashboard';
}

/* ============================================================
   Item (rincian barang)
   ============================================================ */
function itemRowHTML(prefix, item) {
  item = item || {};
  const v = (x) => (x === undefined || x === null ? '' : esc(x));
  return `<div class="item-row">
    <input data-f="nama" placeholder="Nama barang / jasa" value="${v(item.nama)}">
    <input data-f="qty" type="number" min="0" step="any" inputmode="decimal" placeholder="Qty" value="${v(item.qty)}" oninput="calcItems('${prefix}')">
    <input data-f="satuan" placeholder="unit/pcs" value="${v(item.satuan)}">
    <input data-f="harga" type="number" min="0" step="any" inputmode="numeric" placeholder="Harga satuan (Rp)" value="${v(item.harga)}" oninput="calcItems('${prefix}')">
    <button class="btn-icon" type="button" onclick="this.parentNode.remove();calcItems('${prefix}')" title="Hapus baris">${icon('trash')}</button>
  </div>`;
}
function addItemRow(prefix) { $(prefix).insertAdjacentHTML('beforeend', itemRowHTML(prefix)); }
function readItems(prefix) {
  const items = [];
  document.querySelectorAll(`#${prefix} .item-row`).forEach((r) => {
    const nama = r.querySelector('[data-f=nama]').value.trim();
    const qty = parseFloat(r.querySelector('[data-f=qty]').value) || 0;
    const satuan = r.querySelector('[data-f=satuan]').value.trim();
    const harga = parseFloat(r.querySelector('[data-f=harga]').value) || 0;
    if (nama) items.push({ nama, qty, satuan, harga });
  });
  return items;
}
function calcItems(prefix) {
  const map = { po_items: 'po_total', sj_items: 'sj_total', pen_items: 'pen_total' };
  if (prefix === 'inv_items') return calcInv();
  const el = $(map[prefix]);
  if (el) el.textContent = fmt(sumItems(readItems(prefix)));
}
function fillItems(prefix, items) {
  const box = $(prefix);
  box.innerHTML = '';
  (items && items.length ? items : [{}]).forEach((i) => box.insertAdjacentHTML('beforeend', itemRowHTML(prefix, i)));
  calcItems(prefix);
}

/* ============================================================
   Navigasi
   ============================================================ */
const titles = {
  dashboard: ['Dashboard', 'Ringkasan seluruh aktivitas'],
  po: ['Input Data (PO)', 'Masukkan data Purchase Order'],
  suratjalan: ['Surat Jalan', 'Ambil data dari Data PO'],
  invois: ['Invois', 'Ambil data dari Surat Jalan'],
  penawaran: ['Penawaran', 'Buat penawaran baru sesuai keinginan'],
  keuangan: ['Laporan Keuangan', 'Uang masuk, uang keluar & saldo'],
  pengaturan: ['Pengaturan', 'Server, cloud, pengguna & backup'],
};
function go(page) {
  if (!titles[page]) page = 'dashboard';
  currentPage = page;
  document.querySelectorAll('.nav-item[data-page]').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  $('page-' + page).classList.add('active');
  $('pageTitle').textContent = titles[page][0];
  $('pageCrumb').textContent = titles[page][1];
  $('app').classList.remove('nav-open');
  window.scrollTo(0, 0);
  if (location.hash !== '#' + page) history.replaceState(null, '', '#' + page);
  if (page === 'pengaturan') loadSettings();
  render();
}
document.querySelectorAll('.nav-item[data-page]').forEach((b) => (b.onclick = () => go(b.dataset.page)));
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-go]');
  if (g) { e.preventDefault(); go(g.dataset.go); }
});
$('menuBtn').onclick = () => $('app').classList.toggle('nav-open');
$('scrim').onclick = () => $('app').classList.remove('nav-open');

/* ============================================================
   Toast
   ============================================================ */
function toast(msg, type) {
  const t = document.createElement('div');
  t.className = 't ' + (type || 'ok');
  t.innerHTML = icon(type === 'err' ? 'alert' : 'check') + '<span>' + esc(msg) + '</span>';
  $('toastBox').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = '.3s'; setTimeout(() => t.remove(), 300); }, 3500);
}

/* ============================================================
   Nomor otomatis & validasi
   ============================================================ */
function nextNo(prefix, list) {
  const y = new Date().getFullYear();
  const re = new RegExp('^' + prefix + '-' + y + '-(\\d+)$', 'i');
  let max = 0;
  list.forEach((r) => { const m = String(r.no || '').match(re); if (m) max = Math.max(max, parseInt(m[1], 10)); });
  return `${prefix}-${y}-${String(max + 1).padStart(3, '0')}`;
}
function isDuplicate(type, no, id) {
  const n = no.trim().toLowerCase();
  return DB[type].some((r) => r.id !== id && String(r.no || '').trim().toLowerCase() === n);
}
function baseRecord(kind) {
  const id = editing[kind];
  const old = id ? DB[TYPE_KEY[kind]].find((r) => r.id === id) : null;
  return old ? { id: old.id, createdAt: old.createdAt } : { id: uid(), createdAt: new Date().toISOString() };
}
function setEditing(kind, id) {
  editing[kind] = id;
  const btn = document.querySelector(`#page-${{ po: 'po', sj: 'suratjalan', inv: 'invois', pen: 'penawaran' }[kind]} .form-actions .btn-primary`);
  if (btn) {
    if (!btn.dataset.label) btn.dataset.label = btn.innerHTML;
    btn.innerHTML = id ? icon('save') + 'Simpan Perubahan' : btn.dataset.label;
  }
}

/* ============================================================
   Simpan data
   ============================================================ */
function savePO() {
  const no = val('po_no'), tanggal = val('po_tgl'), customer = val('po_cust');
  if (!no || !tanggal || !customer) return toast('Lengkapi Nomor PO, Tanggal, dan Customer', 'err');
  const items = readItems('po_items');
  if (!items.length) return toast('Tambahkan minimal satu barang', 'err');
  const base = baseRecord('po');
  if (isDuplicate('po', no, base.id)) return toast('Nomor PO ' + no + ' sudah ada', 'err');
  const rec = { ...base, no, tanggal, customer, telp: val('po_telp'), alamat: val('po_alamat'), catatan: val('po_catatan'), items, total: sumItems(items) };
  commit({ op: 'upsert', type: 'po', record: rec });
  toast('Data PO ' + no + (editing.po ? ' diperbarui ✓' : ' tersimpan ✓'));
  resetForm('po');
}
function fillSJ() {
  const po = DB.po.find((p) => p.no === val('sj_po'));
  if (!po) return;
  fillItems('sj_items', po.items);
  if (!val('sj_penerima')) val('sj_penerima', '');
}
function saveSJ() {
  const poNo = val('sj_po'), no = val('sj_no'), tanggal = val('sj_tgl');
  if (!poNo || !no || !tanggal) return toast('Lengkapi PO, Nomor SJ, dan Tanggal', 'err');
  const items = readItems('sj_items');
  if (!items.length) return toast('Rincian barang masih kosong', 'err');
  const base = baseRecord('sj');
  if (isDuplicate('suratjalan', no, base.id)) return toast('Nomor Surat Jalan ' + no + ' sudah ada', 'err');
  const po = DB.po.find((p) => p.no === poNo);
  const rec = {
    ...base, no, tanggal, po: poNo, customer: po ? po.customer : '', alamat: po ? po.alamat || '' : '', items,
    ekspedisi: val('sj_ekspedisi'), penerima: val('sj_penerima'), kendaraan: val('sj_kendaraan'), catatan: val('sj_catatan'), total: sumItems(items),
  };
  commit({ op: 'upsert', type: 'suratjalan', record: rec });
  toast('Surat Jalan ' + no + (editing.sj ? ' diperbarui ✓' : ' tersimpan ✓'));
  resetForm('sj');
}
function fillInv() {
  const sj = DB.suratjalan.find((s) => s.no === val('inv_sj'));
  if (!sj) return;
  fillItems('inv_items', sj.items);
}
function calcInv() {
  const sub = sumItems(readItems('inv_items'));
  const ppn = parseFloat(val('inv_ppn')) || 0;
  const ppnAmt = Math.round((sub * ppn) / 100);
  $('inv_subtotal').textContent = fmt(sub);
  $('inv_ppn_amt').textContent = fmt(ppnAmt);
  $('inv_total').textContent = fmt(sub + ppnAmt);
}
function saveInv() {
  const sjNo = val('inv_sj'), no = val('inv_no'), tanggal = val('inv_tgl');
  if (!sjNo || !no || !tanggal) return toast('Lengkapi Surat Jalan, Nomor Invois, dan Tanggal', 'err');
  const items = readItems('inv_items');
  if (!items.length) return toast('Rincian barang masih kosong', 'err');
  const base = baseRecord('inv');
  if (isDuplicate('invois', no, base.id)) return toast('Nomor Invois ' + no + ' sudah ada', 'err');
  const sj = DB.suratjalan.find((s) => s.no === sjNo);
  const po = sj ? DB.po.find((p) => p.no === sj.po) : null;
  const sub = sumItems(items);
  const ppn = parseFloat(val('inv_ppn')) || 0;
  const rec = {
    ...base, no, tanggal, sj: sjNo, po: sj ? sj.po : '', customer: sj ? sj.customer : '', alamat: po ? po.alamat || '' : '', items, ppn,
    status: val('inv_status'), tempo: val('inv_tempo'), catatan: val('inv_catatan'), subtotal: sub, total: sub + Math.round((sub * ppn) / 100),
  };
  commit({ op: 'upsert', type: 'invois', record: rec });
  toast('Invois ' + no + (editing.inv ? ' diperbarui ✓' : ' tersimpan ✓'));
  resetForm('inv');
}
function savePen() {
  const no = val('pen_no'), tanggal = val('pen_tgl'), customer = val('pen_cust');
  if (!no || !tanggal || !customer) return toast('Lengkapi Nomor, Tanggal, dan Customer', 'err');
  const items = readItems('pen_items');
  if (!items.length) return toast('Tambahkan minimal satu barang', 'err');
  const base = baseRecord('pen');
  if (isDuplicate('penawaran', no, base.id)) return toast('Nomor Penawaran ' + no + ' sudah ada', 'err');
  const rec = { ...base, no, tanggal, customer, status: val('pen_status'), catatan: val('pen_catatan'), items, total: sumItems(items) };
  commit({ op: 'upsert', type: 'penawaran', record: rec });
  toast('Penawaran ' + no + (editing.pen ? ' diperbarui ✓' : ' tersimpan ✓'));
  resetForm('pen');
}
function saveFin() {
  const tanggal = val('fin_tgl'), jumlah = parseFloat(val('fin_jumlah'));
  if (!tanggal || !jumlah || jumlah <= 0) return toast('Lengkapi tanggal & jumlah', 'err');
  const rec = { id: uid(), createdAt: new Date().toISOString(), tanggal, keterangan: val('fin_ket') || '-', jenis: val('fin_jenis'), kategori: val('fin_kategori'), jumlah };
  commit({ op: 'upsert', type: 'keuangan', record: rec });
  toast('Transaksi tercatat ✓');
  val('fin_ket', '');
  val('fin_jumlah', '');
}
function toggleFinKategori() {
  $('fin_kategori').innerHTML = KATEGORI[val('fin_jenis')].map((k) => `<option>${esc(k)}</option>`).join('');
}
function setStatus(type, id, status) {
  const rec = DB[type].find((r) => r.id === id);
  if (!rec || rec.status === status) return;
  commit({ op: 'upsert', type, record: { ...rec, status } });
  toast(`Status ${rec.no} → ${status}`);
}
function delRec(kind, id) {
  const type = TYPE_KEY[kind];
  const rec = DB[type].find((r) => r.id === id);
  if (!rec) return;
  // cegah menghapus dokumen yang masih dipakai dokumen lain
  if (kind === 'po' && DB.suratjalan.some((s) => s.po === rec.no) && !confirm(`PO ${rec.no} sudah dipakai di Surat Jalan. Tetap hapus?`)) return;
  if (kind === 'sj' && DB.invois.some((s) => s.sj === rec.no) && !confirm(`Surat Jalan ${rec.no} sudah dipakai di Invois. Tetap hapus?`)) return;
  if (!confirm(`Hapus ${LABEL[kind]} ${rec.no || rec.keterangan || ''}?`)) return;
  commit({ op: 'delete', type, id });
  if (editing[kind] === id) resetForm(kind);
  toast('Data dihapus');
}

/* ---------- edit ---------- */
function editRec(kind, id) {
  const r = DB[TYPE_KEY[kind]].find((x) => x.id === id);
  if (!r) return;
  closeModal();
  if (kind === 'po') {
    go('po');
    val('po_no', r.no); val('po_tgl', r.tanggal); val('po_cust', r.customer); val('po_telp', r.telp || ''); val('po_alamat', r.alamat || ''); val('po_catatan', r.catatan || '');
    fillItems('po_items', r.items);
  } else if (kind === 'sj') {
    go('suratjalan');
    refreshDropdowns();
    val('sj_po', r.po); val('sj_no', r.no); val('sj_tgl', r.tanggal); val('sj_ekspedisi', r.ekspedisi || ''); val('sj_penerima', r.penerima || ''); val('sj_kendaraan', r.kendaraan || ''); val('sj_catatan', r.catatan || '');
    fillItems('sj_items', r.items);
  } else if (kind === 'inv') {
    go('invois');
    refreshDropdowns();
    val('inv_sj', r.sj); val('inv_no', r.no); val('inv_tgl', r.tanggal); val('inv_tempo', r.tempo || ''); val('inv_ppn', r.ppn); val('inv_status', r.status); val('inv_catatan', r.catatan || '');
    fillItems('inv_items', r.items);
  } else if (kind === 'pen') {
    go('penawaran');
    val('pen_no', r.no); val('pen_tgl', r.tanggal); val('pen_cust', r.customer); val('pen_status', r.status); val('pen_catatan', r.catatan || '');
    fillItems('pen_items', r.items);
  }
  setEditing(kind, id);
  toast('Mode edit: ' + r.no);
}

/** Lanjut ke dokumen berikutnya (PO → SJ → Invois) */
function nextDoc(kind, id) {
  if (kind === 'po') {
    const r = DB.po.find((x) => x.id === id);
    resetForm('sj'); go('suratjalan'); refreshDropdowns(); val('sj_po', r.no); fillSJ();
  } else if (kind === 'sj') {
    const r = DB.suratjalan.find((x) => x.id === id);
    resetForm('inv'); go('invois'); refreshDropdowns(); val('inv_sj', r.no); fillInv();
  }
}

/* ============================================================
   Reset form
   ============================================================ */
function suggestNo(id, value) {
  const el = $(id);
  el.value = value;
  el.dataset.suggested = value;
}
/** Perbarui nomor otomatis bila data baru masuk (hanya jika user belum mengetik nomor sendiri) */
function refreshSuggestions() {
  [['po', 'po_no', 'PO', 'po'], ['sj', 'sj_no', 'SJ', 'suratjalan'], ['inv', 'inv_no', 'INV', 'invois'], ['pen', 'pen_no', 'PEN', 'penawaran']].forEach(([k, id, pre, t]) => {
    const el = $(id);
    if (editing[k] || (el.value && el.value !== el.dataset.suggested)) return;
    suggestNo(id, nextNo(pre, DB[t]));
  });
}
function resetForm(kind) {
  const today = localDate();
  setEditing(kind, null);
  if (kind === 'po') {
    ['po_telp', 'po_alamat', 'po_catatan', 'po_cust'].forEach((i) => val(i, ''));
    suggestNo('po_no', nextNo('PO', DB.po)); val('po_tgl', today); fillItems('po_items');
  }
  if (kind === 'sj') {
    ['sj_ekspedisi', 'sj_penerima', 'sj_kendaraan', 'sj_catatan', 'sj_po'].forEach((i) => val(i, ''));
    suggestNo('sj_no', nextNo('SJ', DB.suratjalan)); val('sj_tgl', today); fillItems('sj_items');
  }
  if (kind === 'inv') {
    ['inv_catatan', 'inv_sj'].forEach((i) => val(i, ''));
    const t = new Date(); t.setDate(t.getDate() + 14);
    suggestNo('inv_no', nextNo('INV', DB.invois)); val('inv_tgl', today); val('inv_tempo', localDate(t));
    val('inv_ppn', '11'); val('inv_status', 'Belum Bayar'); fillItems('inv_items');
  }
  if (kind === 'pen') {
    ['pen_cust', 'pen_catatan'].forEach((i) => val(i, ''));
    suggestNo('pen_no', nextNo('PEN', DB.penawaran)); val('pen_tgl', today); val('pen_status', 'Draft'); fillItems('pen_items');
  }
}
let formsReady = false;
function initForms() {
  if (formsReady) return;
  formsReady = true;
  refreshDropdowns();
  ['po', 'sj', 'inv', 'pen'].forEach(resetForm);
  toggleFinKategori();
  val('fin_tgl', localDate());
}

/* ============================================================
   Dropdown
   ============================================================ */
function refreshDropdowns() {
  const s = $('sj_po'), cur = s.value;
  s.innerHTML = '<option value="">— Pilih PO —</option>' + DB.po.map((p) => `<option value="${esc(p.no)}">${esc(p.no)} — ${esc(p.customer)}</option>`).join('');
  s.value = cur;
  const s2 = $('inv_sj'), cur2 = s2.value;
  s2.innerHTML = '<option value="">— Pilih Surat Jalan —</option>' + DB.suratjalan.map((x) => `<option value="${esc(x.no)}">${esc(x.no)} — ${esc(x.customer)}</option>`).join('');
  s2.value = cur2;
  const custs = [...new Set([...DB.po, ...DB.penawaran].map((x) => x.customer).filter(Boolean))].sort();
  $('custList').innerHTML = custs.map((c) => `<option value="${esc(c)}">`).join('');
}

/* ============================================================
   Tabel
   ============================================================ */
function statusBadge(s) {
  const m = { Dibayar: 'badge-green', 'Belum Bayar': 'badge-amber', Sebagian: 'badge-blue', Draft: 'badge-gray', Terkirim: 'badge-blue', Disetujui: 'badge-green', Ditolak: 'badge-rose' };
  return `<span class="badge ${m[s] || 'badge-gray'}">${esc(s)}</span>`;
}
function statusSelect(type, r, opts) {
  return `<select class="status-select" onchange="setStatus('${type}','${esc(r.id)}',this.value)">${opts.map((o) => `<option ${o === r.status ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
}
function actions(kind, id, extra = '') {
  return `<td style="white-space:nowrap">${extra}
    <button class="btn-icon" title="Detail / Cetak" onclick="viewDetail('${kind}','${esc(id)}')">${icon('eye')}</button>
    <button class="btn-icon" title="Edit" onclick="editRec('${kind}','${esc(id)}')">${icon('doc')}</button>
    <button class="btn-icon" title="Hapus" onclick="delRec('${kind}','${esc(id)}')">${icon('trash')}</button></td>`;
}
const byDateDesc = (a, b) => String(b.tanggal).localeCompare(String(a.tanggal)) || String(b.createdAt || '').localeCompare(String(a.createdAt || ''));

function renderTable(which) {
  if (which === 'po') {
    const q = val('poSearch').toLowerCase();
    const rows = DB.po.filter((p) => (p.no + ' ' + p.customer).toLowerCase().includes(q)).sort(byDateDesc);
    $('poCount').textContent = rows.length + ' data PO';
    $('poTable').innerHTML = `<thead><tr><th>No. PO</th><th>Tanggal</th><th>Customer</th><th>Jml Item</th><th>Total</th><th>Aksi</th></tr></thead>
      <tbody>${rows.length ? rows.map((p) => `<tr>
        <td><b>${esc(p.no)}</b></td><td>${esc(p.tanggal)}</td>
        <td><div class="cust"><b>${esc(p.customer)}</b><span>${esc(p.alamat || '')}</span></div></td>
        <td>${(p.items || []).length} item</td><td class="money in">${fmt(p.total)}</td>
        ${actions('po', p.id, `<button class="btn btn-soft btn-sm" title="Buat Surat Jalan" onclick="nextDoc('po','${esc(p.id)}')">→ SJ</button>`)}
      </tr>`).join('') : `<tr><td colspan="6"><div class="empty">Belum ada data PO</div></td></tr>`}</tbody>`;
  }
  if (which === 'sj') {
    const q = val('sjSearch').toLowerCase();
    const rows = DB.suratjalan.filter((x) => (x.no + ' ' + x.customer + ' ' + x.po).toLowerCase().includes(q)).sort(byDateDesc);
    $('sjCount').textContent = rows.length + ' data surat jalan';
    $('sjTable').innerHTML = `<thead><tr><th>No. SJ</th><th>Tanggal</th><th>Ref. PO</th><th>Customer</th><th>Ekspedisi</th><th>Total</th><th>Aksi</th></tr></thead>
      <tbody>${rows.length ? rows.map((x) => `<tr><td><b>${esc(x.no)}</b></td><td>${esc(x.tanggal)}</td><td><span class="badge badge-violet">${esc(x.po)}</span></td>
        <td>${esc(x.customer)}</td><td>${esc(x.ekspedisi || '-')}</td><td class="money in">${fmt(x.total)}</td>
        ${actions('sj', x.id, `<button class="btn btn-soft btn-sm" title="Buat Invois" onclick="nextDoc('sj','${esc(x.id)}')">→ INV</button>`)}</tr>`).join('')
      : `<tr><td colspan="7"><div class="empty">Belum ada surat jalan</div></td></tr>`}</tbody>`;
  }
  if (which === 'inv') {
    const q = val('invSearch').toLowerCase();
    const rows = DB.invois.filter((x) => (x.no + ' ' + x.customer + ' ' + x.po + ' ' + x.status).toLowerCase().includes(q)).sort(byDateDesc);
    $('invCount').textContent = rows.length + ' data invois';
    const today = localDate();
    $('invTable').innerHTML = `<thead><tr><th>No. Invois</th><th>Tanggal</th><th>Ref. SJ</th><th>Customer</th><th>Jatuh Tempo</th><th>Total</th><th>Status</th><th>Aksi</th></tr></thead>
      <tbody>${rows.length ? rows.map((x) => {
        const late = x.status !== 'Dibayar' && x.tempo && x.tempo < today;
        return `<tr><td><b>${esc(x.no)}</b></td><td>${esc(x.tanggal)}</td><td><span class="badge badge-violet">${esc(x.sj)}</span></td>
        <td>${esc(x.customer)}</td><td>${esc(x.tempo || '-')}${late ? ' <span class="badge badge-rose">Lewat</span>' : ''}</td>
        <td class="money in">${fmt(x.total)}</td><td>${statusSelect('invois', x, ['Belum Bayar', 'Sebagian', 'Dibayar'])}</td>
        ${actions('inv', x.id)}</tr>`;
      }).join('') : `<tr><td colspan="8"><div class="empty">Belum ada invois</div></td></tr>`}</tbody>`;
  }
  if (which === 'pen') {
    const q = val('penSearch').toLowerCase();
    const rows = DB.penawaran.filter((x) => (x.no + ' ' + x.customer + ' ' + x.status).toLowerCase().includes(q)).sort(byDateDesc);
    $('penCount').textContent = rows.length + ' data penawaran';
    $('penTable').innerHTML = `<thead><tr><th>No. Penawaran</th><th>Tanggal</th><th>Customer</th><th>Jml Item</th><th>Total</th><th>Status</th><th>Aksi</th></tr></thead>
      <tbody>${rows.length ? rows.map((x) => `<tr><td><b>${esc(x.no)}</b></td><td>${esc(x.tanggal)}</td><td>${esc(x.customer)}</td><td>${(x.items || []).length} item</td>
        <td class="money in">${fmt(x.total)}</td><td>${statusSelect('penawaran', x, ['Draft', 'Terkirim', 'Disetujui', 'Ditolak'])}</td>
        ${actions('pen', x.id)}</tr>`).join('') : `<tr><td colspan="7"><div class="empty">Belum ada penawaran</div></td></tr>`}</tbody>`;
  }
  if (which === 'fin') {
    const q = val('finSearch').toLowerCase();
    // saldo berjalan dihitung dari seluruh transaksi (urut tanggal), lalu difilter
    const all = DB.keuangan.slice().sort((a, b) => String(a.tanggal).localeCompare(String(b.tanggal)) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    let saldo = 0;
    const withSaldo = all.map((x) => { saldo += x.jenis === 'masuk' ? Number(x.jumlah) : -Number(x.jumlah); return { ...x, saldo }; });
    const rows = withSaldo.filter((x) => (x.keterangan + ' ' + (x.kategori || '') + ' ' + x.tanggal).toLowerCase().includes(q)).reverse();
    $('finCount').textContent = rows.length + ' transaksi';
    $('finTable').innerHTML = `<thead><tr><th>Tanggal</th><th>Keterangan</th><th>Kategori</th><th>Uang Masuk</th><th>Uang Keluar</th><th>Saldo</th><th>Aksi</th></tr></thead>
      <tbody>${rows.length ? rows.map((x) => `<tr><td>${esc(x.tanggal)}</td><td>${esc(x.keterangan)}</td>
        <td>${x.jenis === 'masuk' ? '<span class="badge badge-green">Masuk</span>' : '<span class="badge badge-rose">Keluar</span>'} <span class="muted" style="font-size:12px">${esc(x.kategori || '')}</span></td>
        <td class="money in">${x.jenis === 'masuk' ? fmt(x.jumlah) : '-'}</td><td class="money out">${x.jenis === 'keluar' ? fmt(x.jumlah) : '-'}</td>
        <td class="money ${x.saldo >= 0 ? 'in' : 'out'}">${fmt(x.saldo)}</td>
        <td><button class="btn-icon" title="Hapus" onclick="delRec('fin','${esc(x.id)}')">${icon('trash')}</button></td></tr>`).join('')
      : `<tr><td colspan="7"><div class="empty">Belum ada transaksi</div></td></tr>`}</tbody>`;
  }
}

/* ============================================================
   Detail & cetak
   ============================================================ */
let modalRec = null;
function viewDetail(kind, id) {
  const r = DB[TYPE_KEY[kind]].find((x) => x.id === id);
  if (!r) return;
  modalRec = { kind, id };
  $('modalTitle').textContent = r.no + ' — ' + LABEL[kind];
  const itemsHtml = (r.items || []).map((i) => `<tr><td>${esc(i.nama)}</td><td style="text-align:center">${esc(i.qty)}</td><td style="text-align:center">${esc(i.satuan)}</td>
    <td class="money in">${fmt(i.harga)}</td><td class="money in">${fmt(i.qty * i.harga)}</td></tr>`).join('');
  const kv = (l, v) => `<div><div style="font-size:12px;color:var(--muted)">${l}</div><b>${v}</b></div>`;
  const extra = kind === 'sj' ? `<p style="margin:8px 0"><b>Ekspedisi:</b> ${esc(r.ekspedisi || '-')} &nbsp; <b>Penerima:</b> ${esc(r.penerima || '-')} &nbsp; <b>Kendaraan:</b> ${esc(r.kendaraan || '-')}</p>`
    : kind === 'inv' ? `<p style="margin:8px 0"><b>Status:</b> ${statusBadge(r.status)} &nbsp; <b>PPN:</b> ${esc(r.ppn)}% &nbsp; <b>Jatuh Tempo:</b> ${esc(r.tempo || '-')}</p>`
    : kind === 'pen' ? `<p style="margin:8px 0"><b>Status:</b> ${statusBadge(r.status)}</p>` : '';
  $('modalBody').innerHTML = `
    <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:14px">
      ${kv('Customer', esc(r.customer))}${kv('Tanggal', esc(r.tanggal))}
      ${r.po && kind !== 'po' ? kv('Ref. PO', esc(r.po)) : ''}${r.sj ? kv('Ref. SJ', esc(r.sj)) : ''}
      <div><div style="font-size:12px;color:var(--muted)">Total</div><b style="color:#047857">${fmt(r.total)}</b></div>
    </div>
    ${extra}
    ${r.catatan ? `<p style="margin:8px 0"><b>Catatan:</b> ${esc(r.catatan)}</p>` : ''}
    <div class="tbl-wrap"><table><thead><tr><th>Barang / Jasa</th><th>Qty</th><th>Satuan</th><th>Harga</th><th>Subtotal</th></tr></thead><tbody>${itemsHtml}</tbody></table></div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap">
      <button class="btn btn-ghost" onclick="editRec('${kind}','${esc(id)}')">${icon('doc')}Edit</button>
      <button class="btn btn-primary" onclick="printDoc('${kind}','${esc(id)}')">${icon('print')}Cetak / PDF</button>
    </div>
    <p class="muted" style="font-size:11.5px;margin-top:12px">Dibuat ${r.createdAt ? new Date(r.createdAt).toLocaleString('id-ID') : '-'}${r.createdBy ? ' oleh ' + esc(r.createdBy) : ''}${r.updatedBy && r.updatedAt ? ' · diubah ' + new Date(r.updatedAt).toLocaleString('id-ID') + ' oleh ' + esc(r.updatedBy) : ''}</p>`;
  $('modalBack').classList.add('show');
}
function closeModal() { $('modalBack').classList.remove('show'); }
$('modalBack').onclick = (e) => { if (e.target.id === 'modalBack') closeModal(); };
$('modalPrint').onclick = () => modalRec && printDoc(modalRec.kind, modalRec.id);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); $('app').classList.remove('nav-open'); } });

function printDoc(kind, id) {
  const r = DB[TYPE_KEY[kind]].find((x) => x.id === id);
  if (!r) return;
  const title = { po: 'PURCHASE ORDER', sj: 'SURAT JALAN', inv: 'INVOICE', pen: 'SURAT PENAWARAN HARGA' }[kind];
  const withPrice = kind !== 'sj';
  const rows = (r.items || []).map((i, n) => `<tr><td class="c">${n + 1}</td><td>${esc(i.nama)}</td><td class="c">${esc(i.qty)}</td><td class="c">${esc(i.satuan)}</td>
    ${withPrice ? `<td class="r">${fmt(i.harga)}</td><td class="r">${fmt(i.qty * i.harga)}</td>` : ''}</tr>`).join('');
  const sub = sumItems(r.items);
  const ppnAmt = kind === 'inv' ? r.total - sub : 0;
  const totals = !withPrice ? '' : kind === 'inv'
    ? `<tr><td colspan="5" class="r">Subtotal</td><td class="r">${fmt(sub)}</td></tr>
       <tr><td colspan="5" class="r">PPN ${esc(r.ppn)}%</td><td class="r">${fmt(ppnAmt)}</td></tr>
       <tr class="tot"><td colspan="5" class="r">TOTAL TAGIHAN</td><td class="r">${fmt(r.total)}</td></tr>`
    : `<tr class="tot"><td colspan="5" class="r">TOTAL</td><td class="r">${fmt(r.total)}</td></tr>`;
  const meta = [
    ['Nomor', r.no], ['Tanggal', tglIndo(r.tanggal)],
    kind === 'sj' ? ['Ref. PO', r.po] : null,
    kind === 'inv' ? ['Ref. SJ / PO', `${r.sj || '-'} / ${r.po || '-'}`] : null,
    kind === 'inv' ? ['Jatuh Tempo', tglIndo(r.tempo)] : null,
    kind === 'sj' ? ['Ekspedisi', r.ekspedisi] : null,
    kind === 'sj' ? ['No. Kendaraan', r.kendaraan] : null,
  ].filter(Boolean).map(([k, v]) => `<tr><td>${k}</td><td>: ${esc(v || '-')}</td></tr>`).join('');
  const sign = kind === 'sj'
    ? `<div><p>Penerima,</p><div class="ttd"></div><p>( ${esc(r.penerima || '....................')} )</p></div><div><p>Pengirim,</p><div class="ttd"></div><p>( .................... )</p></div><div><p>Hormat kami,</p><div class="ttd"></div><p>${esc(company.name)}</p></div>`
    : `<div></div><div><p>${esc(company.city || '')}, ${tglIndo(r.tanggal)}</p><p>Hormat kami,</p><div class="ttd"></div><p><b>${esc(company.name)}</b></p></div>`;
  const html = `<div class="doc">
    <div class="kop"><div class="lg">M</div><div><h1>${esc(company.name)}</h1><p>${esc(company.sub || '')}${company.city ? ' · ' + esc(company.city) : ''}</p></div></div>
    <h2>${title}</h2>
    <div class="two"><table class="meta">${meta}</table>
      <div class="to"><div class="muted">Kepada Yth.</div><b>${esc(r.customer)}</b>${r.alamat ? `<div>${esc(r.alamat)}</div>` : ''}${r.telp ? `<div>Telp: ${esc(r.telp)}</div>` : ''}</div></div>
    <table class="items"><thead><tr><th>No</th><th>Nama Barang / Jasa</th><th>Qty</th><th>Satuan</th>${withPrice ? '<th>Harga Satuan</th><th>Jumlah</th>' : ''}</tr></thead>
      <tbody>${rows}</tbody><tfoot>${totals}</tfoot></table>
    ${kind === 'inv' ? `<p class="terbilang"><b>Terbilang:</b> <i>${terbilang(r.total)}</i></p>` : ''}
    ${r.catatan ? `<p><b>Catatan:</b> ${esc(r.catatan)}</p>` : ''}
    <div class="sign">${sign}</div>
  </div>`;
  let area = $('printArea');
  if (!area) { area = document.createElement('div'); area.id = 'printArea'; document.body.appendChild(area); }
  area.innerHTML = html;
  document.body.classList.add('printing');
  setTimeout(() => { window.print(); }, 50);
}
window.addEventListener('afterprint', () => document.body.classList.remove('printing'));

/* ============================================================
   Dashboard
   ============================================================ */
function kpiCard(k, col) {
  return `<div class="${col}"><div class="card kpi ${k.g}">
    <div class="icon"><svg fill="none" stroke="currentColor"><use href="#i-${k.ic}"/></svg></div>
    <div class="label">${k.l}</div><div class="val" ${k.small ? 'style="font-size:24px"' : ''}>${k.v}</div>
    ${k.d ? `<div class="delta">${k.d}</div>` : ''}</div></div>`;
}
function totals() {
  const masuk = DB.keuangan.filter((x) => x.jenis === 'masuk').reduce((s, x) => s + Number(x.jumlah), 0);
  const keluar = DB.keuangan.filter((x) => x.jenis === 'keluar').reduce((s, x) => s + Number(x.jumlah), 0);
  return { masuk, keluar, saldo: masuk - keluar };
}
function renderKpi() {
  const sum = (a) => a.reduce((s, x) => s + Number(x.total || 0), 0);
  const { masuk, keluar, saldo } = totals();
  const piutang = sum(DB.invois.filter((x) => x.status !== 'Dibayar'));
  $('kpiRow').innerHTML = [
    { l: 'Data PO', v: DB.po.length + ' PO', d: 'Nilai ' + fmt(sum(DB.po)), g: 'g-indigo', ic: 'doc' },
    { l: 'Invois', v: DB.invois.length + ' inv', d: 'Belum lunas ' + fmt(piutang), g: 'g-cyan', ic: 'receipt' },
    { l: 'Penawaran', v: DB.penawaran.length + ' pen', d: 'Nilai ' + fmt(sum(DB.penawaran)), g: 'g-amber', ic: 'money' },
    { l: 'Saldo Kas', v: fmt(saldo), d: 'Masuk ' + short(masuk) + ' · Keluar ' + short(keluar), g: 'g-emerald', ic: 'chart', small: true },
  ].map((k) => kpiCard(k, 'col-3')).join('');
}
function renderCashChart(elId) {
  const now = new Date();
  const data = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    data.push({ key: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'), label: BULAN[d.getMonth()], masuk: 0, keluar: 0 });
  }
  DB.keuangan.forEach((x) => {
    const b = data.find((d) => d.key === String(x.tanggal).slice(0, 7));
    if (b) b[x.jenis === 'masuk' ? 'masuk' : 'keluar'] += Number(x.jumlah) || 0;
  });
  const max = Math.max(1, ...data.map((d) => Math.max(d.masuk, d.keluar)));
  $(elId).innerHTML = data.map((d) => `
    <div class="bar-col" title="${d.label}: masuk ${fmt(d.masuk)} / keluar ${fmt(d.keluar)}">
      <div style="display:flex;gap:4px;align-items:flex-end;width:100%;justify-content:center;flex:1">
        <div class="bar" style="height:${Math.round((d.masuk / max) * 150) + 4}px"><span class="val">${d.masuk ? short(d.masuk) : ''}</span></div>
        <div class="bar alt" style="height:${Math.round((d.keluar / max) * 150) + 4}px"><span class="val" style="top:-34px">${d.keluar ? short(d.keluar) : ''}</span></div>
      </div>
      <div class="lbl">${d.label}</div>
    </div>`).join('');
}
function donutSVG(segments, size = 150) {
  const total = segments.reduce((s, x) => s + x.v, 0);
  const r = size / 2 - 12, c = 2 * Math.PI * r;
  let off = 0;
  const parts = total ? segments.map((s) => {
    const dash = (s.v / total) * c;
    const el = `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${s.c}" stroke-width="16" stroke-dasharray="${dash} ${c - dash}" stroke-dashoffset="${-off}" transform="rotate(-90 ${size / 2} ${size / 2})"/>`;
    off += dash;
    return el;
  }).join('') : `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="#e2e8f0" stroke-width="16"/>`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${parts}<text x="50%" y="49%" text-anchor="middle" font-size="22" font-weight="800" fill="#0f172a">${total}</text><text x="50%" y="61%" text-anchor="middle" font-size="10" fill="#94a3b8">dokumen</text></svg>`;
}
function legend(segs) {
  return `<div class="legend">${segs.map((s) => `<div class="li"><span class="sw" style="background:${s.c}"></span><span>${s.l}</span><b>${s.v}</b></div>`).join('')}</div>`;
}
function renderDashboard() {
  renderKpi();
  renderCashChart('cashChart');
  const cats = [
    { l: 'Purchase Order', v: DB.po.length, c: '#6366f1' },
    { l: 'Surat Jalan', v: DB.suratjalan.length, c: '#06b6d4' },
    { l: 'Invois', v: DB.invois.length, c: '#10b981' },
    { l: 'Penawaran', v: DB.penawaran.length, c: '#f59e0b' },
  ];
  $('donutChart').innerHTML = donutSVG(cats) + legend(cats);
  const st = ['Dibayar', 'Belum Bayar', 'Sebagian'], colors = ['#10b981', '#f59e0b', '#3b82f6'];
  const segs = st.map((s, i) => ({ l: s, v: DB.invois.filter((x) => x.status === s).length, c: colors[i] }));
  $('invStatus').innerHTML = donutSVG(segs).replace('>dokumen<', '>invois<') + legend(segs);
  const acts = [];
  const t = (x) => x.updatedAt || x.createdAt || '';
  DB.po.forEach((x) => acts.push({ t: t(x), html: `<span class="badge badge-blue">PO</span> <b>${esc(x.no)}</b> — ${esc(x.customer)}`, val: fmt(x.total) }));
  DB.suratjalan.forEach((x) => acts.push({ t: t(x), html: `<span class="badge badge-violet">SJ</span> <b>${esc(x.no)}</b> — ${esc(x.customer)}`, val: fmt(x.total) }));
  DB.invois.forEach((x) => acts.push({ t: t(x), html: `<span class="badge badge-amber">INV</span> <b>${esc(x.no)}</b> — ${esc(x.customer)}`, val: fmt(x.total) }));
  DB.penawaran.forEach((x) => acts.push({ t: t(x), html: `<span class="badge badge-green">PEN</span> <b>${esc(x.no)}</b> — ${esc(x.customer)}`, val: fmt(x.total) }));
  DB.keuangan.forEach((x) => acts.push({ t: t(x), html: `${x.jenis === 'masuk' ? '<span class="badge badge-green">Masuk</span>' : '<span class="badge badge-rose">Keluar</span>'} ${esc(x.keterangan)}`, val: (x.jenis === 'masuk' ? '+' : '-') + fmt(x.jumlah) }));
  acts.sort((a, b) => String(b.t).localeCompare(String(a.t)));
  $('recentTable').innerHTML = `<thead><tr><th>Kegiatan</th><th style="text-align:right">Nilai</th></tr></thead>
    <tbody>${acts.length ? acts.slice(0, 8).map((a) => `<tr><td>${a.html}</td><td class="money ${a.val.startsWith('-') ? 'out' : 'in'}" style="white-space:nowrap">${a.val}</td></tr>`).join('')
    : '<tr><td colspan="2"><div class="empty">Belum ada aktivitas. Mulai dari menu Input Data (PO).</div></td></tr>'}</tbody>`;
}
function renderFinKpi() {
  const { masuk, keluar, saldo } = totals();
  $('finKpiRow').innerHTML = [
    { l: 'Uang Masuk', v: fmt(masuk), g: 'g-emerald', ic: 'download', small: true },
    { l: 'Uang Keluar', v: fmt(keluar), g: 'g-rose', ic: 'upload', small: true },
    { l: 'Saldo Akhir', v: fmt(saldo), g: 'g-indigo', ic: 'money', small: true },
  ].map((k) => kpiCard(k, 'col-4')).join('');
  renderCashChart('finChart');
}

/* ============================================================
   Export CSV & backup
   ============================================================ */
function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function exportCSV(which) {
  const map = {
    po: { data: DB.po, name: 'Data_PO', cols: ['no', 'tanggal', 'customer', 'telp', 'alamat', 'catatan', 'items', 'total'] },
    sj: { data: DB.suratjalan, name: 'Surat_Jalan', cols: ['no', 'tanggal', 'po', 'customer', 'ekspedisi', 'penerima', 'kendaraan', 'catatan', 'items', 'total'] },
    inv: { data: DB.invois, name: 'Invois', cols: ['no', 'tanggal', 'sj', 'po', 'customer', 'ppn', 'status', 'tempo', 'catatan', 'items', 'subtotal', 'total'] },
    pen: { data: DB.penawaran, name: 'Penawaran', cols: ['no', 'tanggal', 'customer', 'status', 'catatan', 'items', 'total'] },
    fin: { data: DB.keuangan, name: 'Keuangan', cols: ['tanggal', 'keterangan', 'jenis', 'kategori', 'jumlah'] },
  }[which];
  if (!map) return;
  const rows = [map.cols.join(';')];
  map.data.forEach((r) => {
    rows.push(map.cols.map((c) => {
      let v = r[c];
      if (c === 'items') v = (r.items || []).map((i) => `${i.nama} x${i.qty} ${i.satuan} @${i.harga}`).join(' | ');
      v = String(v == null ? '' : v).replace(/"/g, '""');
      if (/^[=+\-@]/.test(v)) v = "'" + v;
      return '"' + v + '"';
    }).join(';'));
  });
  download(`${map.name}_${localDate()}.csv`, '\ufeffsep=;\n' + rows.join('\n'), 'text/csv;charset=utf-8');
  toast(map.name + ' di-export ke CSV ✓');
}
async function downloadBackup() {
  try {
    const r = await api('GET', 'backup');
    download(`backup_ptmanna_${localDate()}.json`, JSON.stringify(r, null, 2), 'application/json');
    toast('Backup diunduh ✓');
  } catch (e) {
    download(`backup_ptmanna_lokal_${localDate()}.json`, JSON.stringify({ collections: DB }, null, 2), 'application/json');
    toast('Server offline — backup dari cache perangkat diunduh', 'err');
  }
}
async function restoreBackup(input) {
  const f = input.files[0];
  input.value = '';
  if (!f) return;
  if (!confirm('Restore akan MENGGANTI seluruh data di server dengan isi file backup. Lanjutkan?')) return;
  try {
    const obj = JSON.parse(await f.text());
    await api('POST', 'restore', obj);
    await pullData();
    toast('Data berhasil di-restore ✓');
  } catch (e) {
    toast('Restore gagal: ' + e.message, 'err');
  }
}

/* ============================================================
   Pengaturan
   ============================================================ */
async function loadSettings() {
  $('pwUser').textContent = me ? me.username : '';
  try {
    const s = await api('GET', 'settings');
    company = s.company || company;
    applyCompany();
    const lan = (s.server.lan || []).map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener"><b>${esc(u)}</b></a>`).join('<br>') || '-';
    $('serverInfo').innerHTML = `
      <div class="r"><span>Status</span><b style="color:#047857">● Online</b></div>
      <div class="r"><span>Alamat saat ini</span><b>${esc(location.origin)}</b></div>
      <div class="r"><span>Alamat untuk HP (WiFi sama)</span><div style="text-align:right">${lan}</div></div>
      ${s.server.dataDir ? `<div class="r"><span>Folder data di PC</span><b>${esc(s.server.dataDir)}</b></div>` : ''}
      <div class="r"><span>Data di perangkat ini</span><b>${TYPES.reduce((n, t) => n + DB[t].length, 0)} data · ${queue.length} antre</b></div>`;
    renderCloudInfo(s.cloud);
    if (me && me.role === 'admin') {
      val('cfg_url', s.cloud.url || '');
      val('cfg_key', s.cloud.key || '');
      val('cfg_interval', s.cloud.interval || 60);
      $('cfg_auto').checked = !!s.cloud.autoSync;
      val('co_name', company.name || ''); val('co_sub', company.sub || ''); val('co_city', company.city || '');
      loadUsers();
    }
  } catch (e) {
    $('serverInfo').innerHTML = `<div class="r"><span>Status</span><b style="color:#b91c1c">● Offline — ${esc(e.message)}</b></div>
      <div class="r"><span>Data di perangkat ini</span><b>${TYPES.reduce((n, t) => n + DB[t].length, 0)} data · ${queue.length} antre</b></div>`;
  }
}
function renderCloudInfo(c) {
  cloudInfo = c;
  updateConn();
  const b = $('cloudBadge');
  b.className = 'badge ' + (!c.enabled ? 'badge-gray' : c.lastError ? 'badge-rose' : 'badge-green');
  b.textContent = !c.enabled ? 'Belum diatur' : c.lastError ? 'Error' : 'Aktif';
  $('cloudInfo').innerHTML = c.enabled
    ? `Sinkron terakhir: <b>${ago(c.lastSync)}</b> · Antrean ke cloud: <b>${c.pending}</b>${c.lastError ? `<br><span style="color:#b91c1c">⚠ ${esc(c.lastError)}</span>` : ''}`
    : 'Cloud belum diatur — data tetap aman tersimpan di PC server.';
}
async function saveCloud() {
  try {
    const r = await api('PUT', 'settings', { cloud: { url: val('cfg_url'), key: $('cfg_key').value, interval: val('cfg_interval'), autoSync: $('cfg_auto').checked } });
    renderCloudInfo(r.cloud);
    if (!r.cloud.enabled) return toast('Disimpan — cloud dinonaktifkan');
    toast('Menguji koneksi ke Google Sheets...');
    const t = await api('POST', 'cloud/test');
    toast(t.msg + ' ✓');
    cloudAction('sync');
  } catch (e) {
    toast(e.message, 'err');
  }
}
async function cloudAction(action) {
  const label = { sync: 'Sinkron', pull: 'Ambil dari cloud', push: 'Kirim ke cloud' }[action];
  toast(label + '...');
  try {
    const r = await api('POST', 'cloud/' + action);
    renderCloudInfo(r.cloud);
    toast(`${label} selesai ✓` + (r.pushed != null ? ` · ${r.pushed} terkirim` : '') + (r.pulled != null ? ` · ${r.pulled} diperbarui` : ''));
    await pullData();
  } catch (e) {
    toast(label + ' gagal: ' + e.message, 'err');
    loadSettings();
  }
}
async function saveCompany() {
  try {
    const r = await api('PUT', 'settings', { company: { name: val('co_name'), sub: val('co_sub'), city: val('co_city') } });
    company = r.company;
    applyCompany();
    toast('Profil perusahaan disimpan ✓');
  } catch (e) { toast(e.message, 'err'); }
}
async function changePassword() {
  const o = $('pw_old').value, n = $('pw_new').value, n2 = $('pw_new2').value;
  if (n !== n2) return toast('Ulangi password tidak sama', 'err');
  try {
    await api('POST', 'password', { oldPassword: o, newPassword: n });
    ['pw_old', 'pw_new', 'pw_new2'].forEach((i) => ($(i).value = ''));
    me.mustChange = false;
    writeLS(LS.user, me);
    $('pwBanner').hidden = true;
    toast('Password berhasil diganti ✓');
  } catch (e) { toast(e.message, 'err'); }
}
async function loadUsers() {
  try {
    const r = await api('GET', 'users');
    $('userList').innerHTML = r.users.map((u) => `<div class="u"><div class="avatar">${esc(u.username.charAt(0).toUpperCase())}</div>
      <div class="grow"><b>${esc(u.username)}</b>${u.username === me.username ? ' <span class="muted">(anda)</span>' : ''}<div class="muted" style="font-size:12px">${u.role === 'admin' ? 'Administrator' : 'Staff'}</div></div>
      ${u.username !== me.username ? `<button class="btn-icon" title="Hapus" onclick="delUser('${esc(u.username)}')">${icon('trash')}</button>` : ''}</div>`).join('');
  } catch (e) { $('userList').innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
}
async function addUser() {
  try {
    await api('POST', 'users', { username: val('nu_name'), password: $('nu_pass').value, role: val('nu_role') });
    toast('Pengguna ditambahkan ✓');
    val('nu_name', ''); $('nu_pass').value = '';
    loadUsers();
  } catch (e) { toast(e.message, 'err'); }
}
async function delUser(name) {
  if (!confirm('Hapus pengguna ' + name + '?')) return;
  try { await api('DELETE', 'users/' + encodeURIComponent(name)); toast('Pengguna dihapus'); loadUsers(); } catch (e) { toast(e.message, 'err'); }
}

/* ============================================================
   Render utama
   ============================================================ */
function render() {
  if ($('app').hidden) return;
  updateConn();
  refreshDropdowns();
  if (formsReady) refreshSuggestions();
  if (currentPage === 'dashboard') renderDashboard();
  if (currentPage === 'keuangan') renderFinKpi();
  ['po', 'sj', 'inv', 'pen', 'fin'].forEach(renderTable);
}

/* ============================================================
   PWA: install & service worker
   ============================================================ */
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvt = e;
  $('installBtn').hidden = false;
  $('installBtn2').hidden = false;
});
async function doInstall() {
  if (!installEvt) return toast('Gunakan menu browser → "Install app / Tambahkan ke layar utama"');
  installEvt.prompt();
  await installEvt.userChoice;
  installEvt = null;
  $('installBtn').hidden = true;
  $('installBtn2').hidden = true;
}
$('installBtn').onclick = doInstall;
$('installBtn2').onclick = doInstall;
window.addEventListener('appinstalled', () => toast('Aplikasi terpasang ✓'));
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW gagal', e)));
}
window.addEventListener('online', () => poll());
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

/* ============================================================
   Start
   ============================================================ */
(async function init() {
  const hashPage = (location.hash || '').slice(1);
  try {
    const h = await api('GET', 'health');
    if (h.company) company = h.company;
    applyCompany();
  } catch {}
  if (!token) return showLogin();
  try {
    const r = await api('GET', 'me');
    me = r.user;
    company = r.company || company;
    writeLS(LS.user, me);
  } catch (e) {
    if (!e.offline || !me) return showLogin(e.offline ? 'Server tidak dapat dihubungi.' : '');
    online = false; // offline: pakai data cache
  }
  await showApp();
  if (hashPage && titles[hashPage]) go(hashPage);
})();
