# Monitor Optik OLT HiOSO

## Buka NMS di Windows

Klik dua kali **Buka NMS.cmd**. Peluncur akan membuka browser setelah server siap. Jika server sudah aktif, peluncur langsung membuka dashboard yang sedang berjalan. Jika peluncur memulai server baru, biarkan jendela tersebut terbuka selama NMS digunakan.

Dashboard menampilkan daftar OLT, ringkasan ONU, status polling, serta filter nama, status dan ketersediaan RX. Buka http://127.0.0.1:8080 dari PC yang menjalankan NMS.

## Instalasi manual

### Akun, riwayat, dan alarm

Pada kunjungan pertama dari PC NMS, buat admin dari layar **Buat akun admin**. Admin membuat akun teknisi dengan username dan password melalui menu **Admin**. Menu ini juga menampilkan log restart. Semua akun yang masuk dapat melihat alarm, membuka riwayat pelanggan, dan merestart ONU yang terverifikasi dari dashboard lokal.

Di **Admin → Manajemen OLT**, isi nama, alamat IPv4, community SNMP baca, dan port UDP (biasanya 161). OLT baru langsung dipolling dengan profil OID HiOSO bawaan. Daftar tersimpan di `olts.json` lokal. Menghapus OLT menghentikan pemantauan dan menutup alarm aktifnya. Riwayat dan log tetap disimpan sesuai kebijakan retensi. Restart langsung tersedia untuk profil firmware yang sudah diverifikasi.

Admin dapat memilih **Hapus ONU** untuk satu ONU offline di OLT yang mendukung tindakan langsung. Ketik ulang MAC untuk mengonfirmasi. NMS memeriksa status Down dan MAC di OLT sebelum mengirim perintah, lalu membaca ulang daftar ONU untuk memverifikasi hasilnya. Penghapusan registrasi tercatat di **Admin → Log Tindakan ONU**.

Pilih **Detail Pelanggan** untuk melihat OLT, grup PON SNMP, status, sesi PPPoE, grafik, dan lini masa. Lini masa tindakan teknisi hanya ditampilkan ke admin. Menu **ONU Lama Offline** khusus admin memiliki ambang 7, 14, dan 30 hari. Durasi menghitung pengamatan offline berkelanjutan sejak pelacakan dimulai, dan dimulai ulang setelah jeda pengamatan lebih dari lima menit. Pilihan **Semua yang terpantau offline** menampilkan hasil sebelum ambang tersebut tercapai.

Database lokal `nms-data.sqlite` menyimpan akun, log, alarm, dan sampel historis. NMS menyimpan satu sampel per menit dan menyisakan delapan hari data untuk tampilan 24 jam atau 7 hari. Riwayat mulai terkumpul ketika server berjalan. Log hanya menandai ONU kembali online bila NMS mengamati status turun lalu pulih.

Alarm dipicu ketika pelanggan berubah dari online ke offline, minimal tiga ONU dalam satu grup SNMP turun pada polling yang sama, atau polling OLT gagal dua kali berturut-turut. Klik **Alarm → Aktifkan notifikasi** untuk menerima notifikasi browser selama dashboard terbuka. Notifikasi memerlukan izin per browser dan konteks aman seperti localhost.

### Trafik PPPoE dari MikroTik

Isi `PPPOE_URL`, `PPPOE_USER`, dan `PPPOE_PASSWORD` di file `.env` lokal. Gunakan origin RouterOS REST, misalnya `http://10.0.1.2:808`, dengan akun yang memiliki akses baca REST. Untuk jaringan yang menyediakan HTTPS, gunakan URL HTTPS dengan sertifikat tepercaya. Restart NMS setelah mengubah konfigurasi.

NMS mengambil sesi PPPoE dan penghitung byte setiap dua detik. Kecocokan memakai lima oktet pertama MAC yang unik di seluruh inventaris OLT dan di daftar sesi aktif. TX dari router berarti unduh pelanggan, dan RX berarti unggah. GB adalah volume sesi aktif dalam satuan desimal. Laju trafik dihitung dari dua sampel berurutan dan kembali kosong sementara setelah sesi berganti atau penghitung turun.

Jalankan pada PC atau server yang dapat menjangkau jaringan manajemen OLT melalui UDP 161. Memerlukan Node.js 22 atau lebih baru.

1. Jalankan `npm ci`.
2. Jika belum ada, salin `olts.example.json` menjadi `olts.json`. Tambahkan satu objek per OLT.
3. Buat file `.env` dan isi `OLT_MONGKONAI_READ` dengan nilai **Read Community** di OLT. Gunakan nama environment berbeda untuk setiap community yang berbeda.
4. Jalankan `npm run check` untuk melihat jumlah indeks ONU dan pembacaan RX yang dapat ditampilkan.
5. Jalankan `npm start` dan buka http://127.0.0.1:8080.

Untuk akses teknisi, tempatkan dashboard di balik reverse proxy dengan autentikasi pada jaringan privat atau VPN. Server mendengarkan di 127.0.0.1 secara default. Atur `NMS_PORT` bila port 8080 dipakai layanan lain. Kedua file konfigurasi lokal diabaikan oleh Git.

Polling read-only memakai SNMP v2c setiap 90 detik. Daftar menggabungkan kolom berdasarkan indeks lengkap. Dashboard menampilkan daya RX dalam dBm, diurutkan dari sinyal terlemah. Indeks SNMP ditampilkan utuh karena pemetaan ke port fisik dapat bergantung pada firmware. RX kosong bila pembacaan tidak tersedia, di luar rentang -60 sampai +15 dBm, atau ONU berstatus offline. Status selain 1 dan 2 ditampilkan sebagai kosong. Jika polling gagal, dashboard tetap menampilkan data terakhir dengan waktu dan pesan kegagalan.

Untuk firmware berbeda, gunakan properti `oids` dengan kunci `name`, `status` dan `rx` berisi OID kolom tanpa titik awal. Atur `rxDivider` sesuai skala nilai mentah. Pemetaan bawaan untuk unit contoh memakai kolom HiOSO EPON di bawah `1.3.6.1.4.1.25355.3.2.6`.
