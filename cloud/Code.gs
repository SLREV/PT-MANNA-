/**
 * PT. MANNA — Google Apps Script (Cloud Google Sheets)
 * ------------------------------------------------------------
 * Cara pasang:
 *  1. Buat Google Spreadsheet baru (mis. "Data PT MANNA")
 *  2. Menu Extensions → Apps Script → hapus isi editor, tempel seluruh file ini → Simpan
 *  3. (Disarankan) Isi SECRET_KEY di bawah dengan kata sandi bebas, mis. "manna-2026-rahasia"
 *  4. Deploy → New deployment → Select type: Web app
 *       Execute as      : Me
 *       Who has access  : Anyone
 *     Klik Deploy, izinkan akses, lalu salin "Web app URL" (berakhiran /exec)
 *  5. Di aplikasi PT MANNA → Pengaturan → Cloud: tempel URL + kunci rahasia yang sama → Simpan
 *
 * Setiap kali mengubah kode ini: Deploy → Manage deployments → Edit → Version: New version → Deploy
 */

var SECRET_KEY = ''; // <-- isi sama persis dengan "Kunci Rahasia" di aplikasi (boleh kosong, tapi kurang aman)

var SHEETS = {
  po:         { name: 'Data PO',     cols: ['no', 'tanggal', 'customer', 'telp', 'alamat', 'catatan', 'items', 'total'] },
  suratjalan: { name: 'Surat Jalan', cols: ['no', 'tanggal', 'po', 'customer', 'ekspedisi', 'penerima', 'kendaraan', 'catatan', 'items', 'total'] },
  invois:     { name: 'Invois',      cols: ['no', 'tanggal', 'sj', 'po', 'customer', 'ppn', 'status', 'tempo', 'catatan', 'items', 'subtotal', 'total'] },
  penawaran:  { name: 'Penawaran',   cols: ['no', 'tanggal', 'customer', 'status', 'catatan', 'items', 'total'] },
  keuangan:   { name: 'Keuangan',    cols: ['tanggal', 'keterangan', 'jenis', 'kategori', 'jumlah'] }
};
// Kolom sistem (jangan diubah): id di kolom A, data lengkap (JSON) di kolom terakhir
var SYS_BEFORE = ['id'];
var SYS_AFTER = ['deleted', 'createdAt', 'updatedAt', 'updatedBy', '_json'];

function headersFor(type) {
  return SYS_BEFORE.concat(SHEETS[type].cols, SYS_AFTER);
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function authorized(key) {
  return !SECRET_KEY || key === SECRET_KEY;
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (!authorized(p.key)) return out({ ok: false, msg: 'Kunci rahasia salah' });
  try {
    if (p.action === 'ping') return out({ ok: true, msg: 'Terhubung ke ' + SpreadsheetApp.getActiveSpreadsheet().getName() });
    if (p.action === 'data') return out({ ok: true, data: readAll() });
    return out({ ok: true, msg: 'PT MANNA Cloud API aktif' });
  } catch (err) {
    return out({ ok: false, msg: String(err) });
  }
}

function doPost(e) {
  var body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return out({ ok: false, msg: 'JSON tidak valid' });
  }
  var key = body.key || (e.parameter && e.parameter.key);
  if (!authorized(key)) return out({ ok: false, msg: 'Kunci rahasia salah' });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (body.action === 'ping') return out({ ok: true, msg: 'Terhubung' });
    if (body.action === 'batch') return out({ ok: true, saved: applyBatch(body.ops || []) });
    // kompatibel dengan versi lama: { action:'add', type, record }
    if (body.action === 'add' && body.type && body.record) return out({ ok: true, saved: applyBatch([{ type: body.type, record: body.record }]) });
    return out({ ok: false, msg: 'Aksi tidak dikenal' });
  } catch (err) {
    return out({ ok: false, msg: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function sheetFor(type) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var def = SHEETS[type];
  var sh = ss.getSheetByName(def.name);
  var headers = headersFor(type);
  if (!sh) sh = ss.insertSheet(def.name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#eef2ff');
    sh.setFrozenRows(1);
  }
  return sh;
}

function cellValue(rec, col) {
  var v = rec[col];
  if (col === 'items') {
    return (rec.items || []).map(function (i) {
      return i.nama + ' x' + i.qty + ' ' + (i.satuan || '') + ' @' + i.harga;
    }).join(' | ');
  }
  if (col === 'deleted') return rec.deleted ? 'YA' : '';
  if (col === '_json') return JSON.stringify(rec);
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  // Hindari Sheets mengubah teks jadi rumus
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}

function applyBatch(ops) {
  var byType = {};
  ops.forEach(function (op) {
    if (!op || !SHEETS[op.type] || !op.record || !op.record.id) return;
    (byType[op.type] = byType[op.type] || []).push(op.record);
  });
  var saved = 0;
  Object.keys(byType).forEach(function (type) {
    var sh = sheetFor(type);
    var headers = headersFor(type);
    var last = sh.getLastRow();
    var ids = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];
    var appendRows = [];
    byType[type].forEach(function (rec) {
      var row = headers.map(function (h) { return cellValue(rec, h); });
      var idx = ids.indexOf(String(rec.id));
      if (idx >= 0) {
        sh.getRange(idx + 2, 1, 1, headers.length).setValues([row]);
      } else {
        appendRows.push(row);
        ids.push(String(rec.id));
      }
      saved++;
    });
    if (appendRows.length) sh.getRange(sh.getLastRow() + 1, 1, appendRows.length, headers.length).setValues(appendRows);
  });
  return saved;
}

function readAll() {
  var data = {};
  Object.keys(SHEETS).forEach(function (type) {
    data[type] = [];
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS[type].name);
    if (!sh || sh.getLastRow() < 2) return;
    var headers = headersFor(type);
    var values = sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).getValues();
    values.forEach(function (row) {
      var json = row[headers.length - 1];
      if (!json) return;
      try {
        data[type].push(JSON.parse(json));
      } catch (err) { /* baris rusak dilewati */ }
    });
  });
  return data;
}
