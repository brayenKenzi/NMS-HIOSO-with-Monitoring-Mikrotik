# MOMO NET NMS — Android Standalone App

Aplikasi Android mandiri untuk **MOMO NET Monitoring System (NMS)** yang berjalan 100% di HP tanpa membutuhkan server perantara, PC aktif, cloud, atau VPN.

- **SNMP OLT**: Berkomunikasi langsung via UDP 161 (SNMP v2c subtree walk) ke OLT HiOSO EPON.
- **MikroTik RouterOS**: Membaca sesi aktif dan volume/kecepatan trafik PPPoE langsung via REST API (HTTP/HTTPS).
- **SQLite Engine**: Menggunakan database `node:sqlite` lokal di dalam memori penyimpanan aplikasi (`app.datadir()`).
- **Dashboard Penuh**: Menjalankan Web UI lengkap MOMO NET (redaman dBm, filter, trafik, grafik riwayat, alarm, restart modem, hapus registrasi offline).
- **Keamanan**: Dilengkapi proteksi PIN Cepat (4–8 digit) dan autentikasi peran (Admin & Teknisi). Server HTTP lokal hanya terikat pada `127.0.0.1`.
- **Manajemen Mandiri**: Konfigurasi OLT dan MikroTik dapat ditambah, diubah, dicadangkan, dan diimpor langsung melalui layar Admin di dalam aplikasi tanpa perlu mengedit berkas `.env` atau `olts.json`.

---

## Arsitektur Aplikasi

1. **Host Native**: Capacitor 8 (Android SDK 35/36).
2. **Background Engine**: `@capawesome/capacitor-nodejs` menjalankan **Node.js 24.5.0** di dalam proses aplikasi Android.
3. **Internal Server**: Server HTTP berjalan di `http://127.0.0.1:8080/`. Seluruh aset statis (`dashboard.html`, `operations.js`, `nms-worker.js`, `momo-logo.png`) telah dibundel ke dalam runtime tanpa ketergantungan berkas eksternal.
4. **WebView Capacitor**: Membuka `http://127.0.0.1:8080/` secara first-party dengan dukungan cookie `momo_session` dan `WebSettings.MIXED_CONTENT_ALWAYS_ALLOW`.

---

## Struktur Berkas di `android-app/`

- `src/server/`
  - `server.cjs` — Inisialisasi HTTP server, siklus polling SNMP 90 detik, polling MikroTik 2 detik, dan sampling riwayat.
  - `store.cjs` — Penyimpanan data SQLite (`nms-data.sqlite`), sesi, audit, alarm, riwayat redaman, hash password (scrypt), PIN keamanan, dan pengaturan MikroTik.
  - `routes.cjs` — API router: autentikasi, manajemen OLT, pengaturan MikroTik, PIN, cadangkan/impor konfigurasi, alarm, dan riwayat.
  - `pppoe.cjs` — Poller sesi PPPoE dan penghitung laju byte MikroTik RouterOS REST.
  - `restart-onu.cjs` — Verifikasi MAC dan eksekusi reboot/hapus ONU langsung ke web admin OLT HiOSO.
  - `static-assets.cjs` — Berkas yang digenerate otomatis berisi HTML dashboard, JS operasional, dan logo MOMO NET dalam base64.
- `src/app.js` — Skrip WebView Capacitor untuk bootstrap engine Node.js dan redirect otomatis ke dashboard.
- `src/runtime.cjs` — Titik masuk Node.js yang dijalankan oleh Capacitor Bridge.
- `tools/`
  - `build-assets.cjs` — Membundel berkas web statis ke `static-assets.cjs`.
  - `verify-live-dashboard.mjs` — Pengujian integrasi otomatis langsung di dalam emulator (admin setup, session, import OLT/MikroTik, polling SNMP).
  - `verify-pin.mjs` — Pengujian fungsi kunci PIN cepat dan buka kunci aplikasi.
  - `emulator-probe.mjs` — Skrip uji diagnostik kelayakan jaringan loopback dan probe SNMP/REST OLT mentah.

---

## Cara Build APK

Pastikan JDK 21 dan Android SDK sudah tersedia di PC:

```powershell
# 1. Atur Environment Variabel Sesi
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"

# 2. Masuk ke folder android-app
Set-Location "android-app"

# 3. Jalankan Pengujian Unit
npm test

# 4. Sinkronisasi Aset ke Android
npm run android:sync

# 5. Kompilasi APK Debug
Set-Location "android"
.\gradlew.bat assembleDebug --console=plain
```

Hasil berkas APK berada di:
`android-app/android/app/build/outputs/apk/debug/app-debug.apk`

---

## Pemasangan & Penggunaan Pertama Kali di HP

1. Salin dan pasang `app-debug.apk` ke HP Android.
2. Pastikan HP terhubung ke jaringan Wi-Fi yang satu subnet dengan OLT dan MikroTik.
3. Buka aplikasi **MOMO NET NMS**.
4. Pada pembukaan pertama kali, layar **Buat Akun Admin** akan muncul:
   - Masukkan **Username** dan **Password** Admin.
   - (Opsional) Masukkan **PIN Cepat** (misalnya `123456`) untuk memudahkan buka aplikasi di kemudian hari tanpa perlu mengetik ulang password panjang.
5. Setelah masuk, tekan tombol **Admin** di pojok kanan atas:
   - Pilih **Manajemen OLT** untuk menambahkan OLT (Nama, IP OLT, Community SNMP, Port, dan akun admin OLT untuk fitur restart).
   - Pilih **Pengaturan MikroTik** untuk menghubungkan RouterOS REST (`http://10.x.x.x:808`, Username, Password).
   - Atau pilih **Cadangkan & Impor** untuk langsung menempel konfigurasi JSON sekaligus.
6. Aplikasi akan langsung melakukan polling SNMP dan menampilkan seluruh ONU beserta daya redaman dBm dan trafik PPPoE.
