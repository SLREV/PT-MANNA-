# PT. MANNA — Sistem Data & Dashboard

Aplikasi pencatatan **Data PO → Surat Jalan → Invois**, **Penawaran**, dan **Laporan Keuangan**. Bisa dipakai di **PC dan Android**, dan bisa diakses **online**.

```
 ┌──────────── HP Android / PC lain ────────────┐
 │  Aplikasi (PWA, bisa di-install)             │
 │  cache + antrean offline di perangkat        │
 └───────────────┬──────────────────────────────┘
                 │  WiFi kantor  /  internet (https tunnel)
 ┌───────────────▼──────────────────────────────┐
 │  PC KANTOR — backend/server.js (Node.js)     │
 │  • Penyimpanan lokal: data/db.json           │
 │  • Backup otomatis harian: data/backups/     │
 │  • Login & pengguna                          │
 └───────────────┬──────────────────────────────┘
                 │  sinkron otomatis (antre bila internet mati)
 ┌───────────────▼──────────────────────────────┐
 │  CLOUD — Google Sheets (cloud/Code.gs)       │
 └──────────────────────────────────────────────┘
```

## 1. Menjalankan di PC (Windows)

1. Install **Node.js LTS** dari <https://nodejs.org> (sekali saja).
2. Download / clone repo ini, lalu klik dua kali **`start-windows.bat`**.
3. Browser terbuka otomatis di `http://localhost:3000`.
4. Login pertama: **username `admin`**, **password `admin123`**. **Segera ganti** di menu Pengaturan.

> Jendela hitam (server) jangan ditutup selama aplikasi dipakai.
> Linux/macOS: `./start.sh` atau `node backend/server.js`.

Opsi (environment variable): `PORT=3000`, `HOST=0.0.0.0`, `DATA_DIR=D:\DataManna`.

Server tidak butuh `npm install` karena tidak memakai paket tambahan. Cukup Node.js 18 ke atas.

## 2. Install sebagai aplikasi

| Perangkat | Cara |
|---|---|
| **PC** (Chrome / Edge) | Buka `http://localhost:3000`, lalu klik ikon **Install** di address bar atau tombol **Install Aplikasi** di menu. |
| **Android** (Chrome) | Buka alamat server dari HP, lalu menu **⋮** → **Install app** / **Tambahkan ke layar utama**. |

- **HP satu WiFi dengan PC:** buka `http://IP-PC:3000`. Alamatnya tampil di jendela server dan di menu Pengaturan.
  Jika tidak bisa dibuka, izinkan Node.js di **Windows Firewall** (Private network).
- Fitur *install* penuh dan mode offline di Android membutuhkan alamat **https**. Gunakan akses online di bawah.

## 3. Akses online (dari mana saja)

1. Install Cloudflare Tunnel (gratis, sekali saja): `winget install --id Cloudflare.cloudflared`
2. Jalankan server (`start-windows.bat`), lalu jalankan **`start-online.bat`**.
3. Salin alamat `https://xxxx.trycloudflare.com` yang muncul, buka di HP, lalu **Install app**.

Alamat *trycloudflare* berganti setiap kali dijalankan. Untuk alamat tetap (misal `app.ptmanna.co.id`), buat *Named Tunnel* di dashboard Cloudflare Zero Trust.
Semua akses tetap wajib login.

> Opsional — **APK Android**: setelah punya alamat https tetap, masukkan alamat itu di <https://www.pwabuilder.com> untuk membuat file APK/AAB (Trusted Web Activity).

## 4. Cloud: Google Sheets

1. Buat Google Spreadsheet baru.
2. Buka **Extensions → Apps Script**, tempel isi [`cloud/Code.gs`](cloud/Code.gs), lalu isi `SECRET_KEY` (disarankan).
3. Pilih **Deploy → New deployment → Web app**. Atur *Execute as: Me* dan *Who has access: Anyone*.
4. Di aplikasi, buka **Pengaturan → Cloud**. Tempel URL `/exec` dan kunci rahasia, lalu klik **Simpan & Uji Koneksi**.

Setelah itu:

- Setiap perubahan dikirim ke Sheets dalam ±3 detik. Sinkron penuh (kirim + ambil) berjalan setiap 60 detik.
- Bila internet mati, perubahan menunggu di antrean dan terkirim otomatis saat online lagi.
- Sheet yang dibuat: *Data PO, Surat Jalan, Invois, Penawaran, Keuangan*.
- Konflik diselesaikan dengan aturan: perubahan terbaru (`updatedAt`) yang dipakai.
- Data yang dihapus ditandai `deleted = YA` di sheet, tidak dihapus barisnya.

## 5. Penyimpanan & backup

| Lokasi | Isi |
|---|---|
| `data/db.json` | Seluruh data (ditulis secara atomik supaya aman bila listrik mati) |
| `data/backups/db-YYYY-MM-DD.json` | Backup otomatis harian, disimpan 30 hari |
| `data/config.json` | Pengguna (password di-hash scrypt), sesi login, pengaturan cloud |
| Google Sheets | Salinan cloud |

Menu **Pengaturan → Backup** menyediakan Download Backup (JSON), Restore, dan Export CSV (bisa dibuka di Excel).
Folder `data/` tidak ikut ke Git (`.gitignore`).

## 6. Fitur

- Dashboard: KPI, arus kas 6 bulan (label bulan sesuai tanggal sebenarnya), komposisi dokumen, status invois
- Alur PO → Surat Jalan → Invois: tombol **→ SJ** dan **→ INV**, barang terisi otomatis
- Nomor dokumen otomatis (`PO-2026-001`, dst.) dan penolakan nomor ganda
- Edit, hapus, dan ubah status langsung dari tabel. Penanda invois lewat jatuh tempo.
- **Cetak / PDF**: PO, Surat Jalan (dengan kolom tanda tangan), Invois (PPN + terbilang), Penawaran
- Multi-pengguna (admin / staff), batas percobaan login
- Tampilan responsif untuk HP (menu geser), bisa di-install (PWA), tetap bisa input saat offline

## Struktur

```
backend/        server Node.js (tanpa dependency)
  server.js     HTTP server + REST API + file statis
  lib/store.js  penyimpanan lokal (JSON) + antrean sinkron
  lib/cloud.js  sinkron Google Sheets
  lib/config.js pengguna, sesi, pengaturan
frontend/       aplikasi (index.html, app.js, style.css, sw.js, manifest, ikon)
cloud/Code.gs   script Google Apps Script
start-windows.bat / start-online.bat / start.sh
```

### REST API (ringkas)

Semua endpoint selain `health` dan `login` membutuhkan header `Authorization: Bearer <token>`.

| Method | Endpoint | Keterangan |
|---|---|---|
| GET | `/api/health` | status server |
| POST | `/api/login` | `{username,password}` → `{token,user}` |
| GET | `/api/data` | semua data aktif + `version` |
| GET | `/api/version` | cek perubahan + status cloud |
| POST / PUT / DELETE | `/api/records/:type[/:id]` | type: `po, suratjalan, invois, penawaran, keuangan` |
| POST | `/api/bulk` | kirim antrean offline `{ops:[...]}` |
| GET / POST | `/api/backup`, `/api/restore` | backup & restore |
| GET / PUT | `/api/settings` | pengaturan cloud & profil perusahaan (admin) |
| POST | `/api/cloud/test`, `sync`, `push`, `pull` | sinkron Google Sheets |
| GET / POST / DELETE | `/api/users` | kelola pengguna (admin) |
