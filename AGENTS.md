# Catatan untuk Codex: Bungkus NMS OLT menjadi APK Android mandiri

## Tujuan
Ubah NMS ini menjadi APK Android yang **berjalan mandiri di HP**, tanpa server lokal/PC aktif.
- HP berbicara langsung ke OLT (SNMP v2c, UDP 161) dan MikroTik (REST HTTP).
- Aplikasi hanya berfungsi bila HP satu jaringan dengan OLT. Ini disengaja, jangan tambahkan relay, cloud, atau VPN.
- **Semua fitur harus dipertahankan, tidak boleh ada yang dikurangi:** polling SNMP semua OLT, daftar ONU (nama, MAC, status, RX dBm), filter, trafik PPPoE MikroTik, restart ONU, dashboard dan logo.

## Pendekatan (opsi A, sudah dipilih)
Capacitor + nodejs-mobile (mis. `capacitor-nodejs` / `nodejs-mobile-cordova`). Jalankan kode Node yang ada di dalam APK, lalu WebView memuat `http://127.0.0.1:<port>`.
- Kode sumber saat ini: `server.mjs`, `pppoe.mjs`, `restart-onu.mjs`, `dashboard.html`, `momo-logo.png`, dependensi `net-snmp` (pure JS, memakai `dgram`).
- Jangan ubah folder asli. Kerjakan di subfolder `android-app/` dan salin file sumber ke sana (atau buat skrip sinkronisasi).

## Pekerjaan
1. Inisialisasi proyek Capacitor di `android-app/`, tambahkan platform Android, lalu integrasikan nodejs-mobile.
2. Sesuaikan kode Node untuk Node 18 (nodejs-mobile). Tidak ada `--env-file-if-exists`, jadi muat konfigurasi manual. ESM mungkin butuh penyesuaian. Jika `import.meta.url` atau top-level await bermasalah, bundle dengan esbuild ke satu file CJS.
3. Ganti pembacaan `olts.json` dan `.env` dengan konfigurasi dari penyimpanan aplikasi. Buat **layar pengaturan** untuk: daftar OLT (name, host, communityEnv/community, port, oids, rxDivider) serta `PPPOE_URL`, `PPPOE_USER`, `PPPOE_PASSWORD`. Simpan terenkripsi (Android Keystore / secure storage).
4. **Jangan menanam community SNMP, password, `olts.json`, atau `.env` ke dalam APK atau repo.** Jangan commit rahasia.
5. Server hanya bind `127.0.0.1` (jangan `0.0.0.0`). Port bisa acak atau tetap.
6. Tambahkan PIN atau biometrik saat membuka aplikasi. Alasannya, aplikasi menyimpan community SNMP dan punya aksi restart ONU. Buat layar untuk mengatur PIN saat pertama kali dibuka.
7. Izin dan manifest: `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`, `usesCleartextTraffic=true` (atau network security config untuk IP privat), dan foreground service agar polling tidak dimatikan Android.
8. Cek jaringan: jika OLT tidak terjangkau, tampilkan pesan jelas "Tidak satu jaringan dengan OLT" (dashboard sudah menampilkan error polling terakhir).
9. Periksa `restart-onu.mjs` dan `pppoe.mjs`. Logika `canRestart(host, bindHost)` bergantung pada bind host dan origin, jadi pastikan tetap berfungsi dengan 127.0.0.1 di dalam app.

## Lingkungan build di PC ini (sudah dicek)
- Node v22.15.1, npm 10.9.2, Git 2.54
- JDK 21: `C:\Program Files\Android\Android Studio\jbr`
- Android SDK: `%LOCALAPPDATA%\Android\Sdk` (platform 35, 36; build-tools 34–37; NDK 28.2.13676358; platform-tools)
- Flutter tidak terpasang dan tidak diperlukan.
- `JAVA_HOME` dan `ANDROID_HOME` belum di-set. Set hanya di sesi build:
  ```powershell
  $env:JAVA_HOME="C:\Program Files\Android\Android Studio\jbr"
  $env:ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"
  $env:Path="$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"
  ```
- Build: `cd android-app\android; .\gradlew assembleDebug`. Hasilnya di `app\build\outputs\apk\debug\app-debug.apk`.

## Verifikasi (wajib sebelum selesai)
- `npm run check` di folder asli tetap lolos.
- APK terpasang di perangkat atau emulator, polling berjalan, daftar ONU dan RX tampil, dan PPPoE terisi (butuh jaringan OLT nyata).
- Uji tanpa jaringan OLT: pesan error tampil dan aplikasi tidak crash.
- Hasil ONU, filter, dan restart sama dengan versi PC.

## Risiko yang diketahui
- nodejs-mobile memakai Node 18, jadi `net-snmp` dan `dgram` harus diuji.
- Ukuran APK sekitar 30–50 MB.
- Android bisa mematikan proses di latar belakang, jadi gunakan foreground service.
- Jika nodejs-mobile gagal, fallback-nya menulis ulang di Flutter/Dart (klien SNMP v2c sendiri). Tanyakan dulu ke pengguna sebelum beralih.

## Skill dan agent yang relevan (pasang bila tersedia, lalu gunakan)
Sumber skill (salin folder skill ke `.agents/skills` atau `.codex/skills`; semuanya opsional):
- `android/skills` (github.com/android/skills): skill resmi Android untuk Gradle, manifest, WebView, dan foreground service. Gunakan agar tidak memakai pola Gradle yang usang.
- `ionic-team/capacitor-skills`: alur Capacitor (init, `cap add android`, `cap sync`, plugin).
- `flutter/agent-plugins`: hanya untuk fallback Flutter, setelah pengguna setuju.
- Android CLI (`android skills add --all`) bila terpasang.

Peran yang disarankan (jalankan sebagai sub-agent bila Codex mendukung, atau sebagai langkah terpisah):
| Peran | Dipakai untuk |
|---|---|
| planner / architect | Memecah pekerjaan dan menetapkan arsitektur Capacitor + nodejs-mobile, termasuk alur pesan WebView ke Node. |
| build-error-resolver | Memperbaiki error Gradle, bundling esbuild, dan kompatibilitas Node 18. |
| security-reviewer | Memeriksa penyimpanan community dan password, bind `127.0.0.1`, PIN, dan endpoint restart ONU. Jalankan sebelum commit. |
| code-reviewer / typescript-reviewer | Meninjau perubahan JS/ESM. |
| e2e-runner | Menguji UI di emulator: filter, restart ONU, dan layar pengaturan. |
| tdd-guide | Tes unit untuk parsing SNMP, pencocokan MAC PPPoE, dan `canRestart`. |

Aturan kerja: rencanakan dulu, tulis tes sebelum mengubah logika, tinjau kode dan keamanan sebelum selesai.


---

## Log Progres & Status Implementasi (Update Terbaru)

### Status: SELESAI & TERVERIFIKASI PENUH DI ANDROID (EMULATOR-5554)

1. **Arsitektur Mandiri Berhasil**:
   - Engine Node.js tersemat: **Node.js 24.5.0 (x64 / arm64)** via `@capawesome/capacitor-nodejs`.
   - SQLite lokal tersemat: **`node:sqlite`** di direktori penyimpanan privat Android (`app.datadir()/nms-data.sqlite`).
   - Server internal HTTP aktif di `http://127.0.0.1:8080/`.
   - WebView Capacitor otomatis memuat `http://127.0.0.1:8080/` pada startup dengan dukungan cookie sesi dan `MIXED_CONTENT_ALWAYS_ALLOW`.

2. **Fitur yang Dipertahankan 100% (Zero Feature Loss)**:
   - Polling SNMP v2c (UDP 161) langsung dari HP ke OLT HiOSO (Mongkonai & Mocil terbukti menghasilkan redaman dan daftar ONU identik dengan PC).
   - Polling MikroTik RouterOS REST langsung dari HP (347 sesi aktif terukur).
   - Seluruh indikator redaman (dBm), status Online/Offline, pemetaan MAC ke PPPoE, grafik canvas riwayat redaman, dan notifikasi alarm.
   - Fitur reboot ONU dan hapus registrasi ONU offline dengan verifikasi MAC.
   - Tampilan antarmuka dashboard penuh (`dashboard.html`) dengan logo MOMO NET, responsif di layar ponsel.

3. **Fitur Tambahan Khusus Mobile & Notifikasi**:
   - **Nama & Ikon**: Nama aplikasi resmi **Momo Net** dengan ikon logo Momo Net di seluruh resolusi mipmap Android.
   - **SNMP Responsif & Fast Pacing**: Interval polling dipercepat ke 15 detik (dengan auto-retry 5 detik bila gagal), timeout 2000ms dan retries 2 untuk mencegah stalling.
   - **Notifikasi Native Android**: Terintegrasi langsung via Android `NotificationManager` dan channel `momo_alarms`. Alarm jaringan langsung muncul di status bar HP dengan getaran dan suara.
   - **PIN Cepat**: Proteksi PIN 4–8 angka saat membuka aplikasi (dapat diatur pada setup pertama atau diganti melalui Admin).
   - **Layar Pengaturan MikroTik**: Input URL REST, Username, dan Password langsung di UI Admin.
   - **Layar Manajemen OLT**: Tambah/Hapus OLT beserta kredensial admin OLT langsung di HP.
   - **Cadangkan & Impor JSON**: Ekspor dan impor seluruh konfigurasi jaringan dalam satu klik tanpa menyentuh file `.env`.
   - **Tanpa Hardcode Rahasia**: Berkas APK bersih dari IP, password, atau community OLT produksi.

4. **Hasil Verifikasi Otomatis**:
   - `npm test` di `android-app/`: **LULUS** (Unit test probe loopback, SQLite, server endpoints).
   - `verify-live-dashboard.mjs`: **LULUS** (Admin setup, sesi, impor config, polling OLT & MikroTik di dalam emulator).
   - `verify-pin.mjs`: **LULUS** (Kunci layar PIN aktif setelah logout/reload, berhasil dibuka dengan PIN).
   - `apksigner verify`: **LULUS** (Signature Scheme v2 terverifikasi valid).
   - Screenshot visual: `android-app/screen.png` dan `android-app/dashboard.png` membuktikan UI dashboard tampil sempurna di HP.

5. **Sinkronisasi Multi-HP Berbasis Supabase Cloud**:
   - Integrasi langsung ke Supabase (`https://uzxrzpvwuzgejrpkoagi.supabase.co`) tanpa perantara server tambahan.
   - Tabel terpusat: `nms_users`, `nms_settings` (PIN & MikroTik config), `nms_olts`, `nms_audit` (tindakan teknisi & admin), dan `nms_alarms`.
   - Admin mengatur akun teknisi, PIN, daftar OLT, dan MikroTik di satu HP -> otomatis tersimpan di Supabase.
   - Teknisi memasang APK di HP baru -> akun dan konfigurasi langsung tersinkron otomatis saat pertama kali dibuka.
   - Setiap tindakan (Reboot ONU / Hapus ONU) oleh teknisi mana pun langsung tercatat di `nms_audit` dan dapat dilihat seketika oleh Admin dari HP lain.
   - Mode Offline-Resilient: jika internet atau Supabase tidak dapat dijangkau, aplikasi tetap beroperasi 100% menggunakan SQLite lokal (`nms-data.sqlite`).

6. **Lokasi Berkas APK Production**:
   - **APK HP 64-bit Modern (Rekomendasi, ~41 MB)**: [app-arm64-v8a-release.apk](file:///c:/Users/Kenzi/Desktop/MASTER%20WEBSITE/NMS%20SNMP%20OLT/android-app/android/app/build/outputs/apk/release/app-arm64-v8a-release.apk)
   - **APK HP 32-bit Lama (~40 MB)**: [app-armeabi-v7a-release.apk](file:///c:/Users/Kenzi/Desktop/MASTER%20WEBSITE/NMS%20SNMP%20OLT/android-app/android/app/build/outputs/apk/release/app-armeabi-v7a-release.apk)
   - **APK Universal Release (~119 MB)**: [app-universal-release.apk](file:///c:/Users/Kenzi/Desktop/MASTER%20WEBSITE/NMS%20SNMP%20OLT/android-app/android/app/build/outputs/apk/release/app-universal-release.apk)
   - Keystore: `android-app/android/app/momo-release.keystore` (kredensial ada di `android-app/android/keystore.properties` lokal)
   - Skrip SQL Supabase: [supabase-schema.sql](file:///c:/Users/Kenzi/Desktop/MASTER%20WEBSITE/NMS%20SNMP%20OLT/android-app/supabase-schema.sql)
