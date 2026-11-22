const nmsOperations = (() => {
  const byId = id => document.getElementById(id);
  const dialog = byId('ops-dialog');
  const panel = byId('ops-body');
  const alarmMenu = byId('alarm-menu');
  let currentAlarmId = null;
  let notificationRegistration;
  let isAdmin = false;

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  async function api(path, values) {
    const response = await fetch(path, values === undefined ? undefined : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message);
    return result;
  }

  const time = value => new Date(value).toLocaleString('id-ID', { timeZone: 'Asia/Makassar' }) + ' WITA';

  function open(title) {
    byId('ops-title').textContent = title;
    panel.replaceChildren(element('p', 'Memuat data…'));
    if (!dialog.open) dialog.showModal();
    return panel;
  }

  function items(records, describe, empty) {
    if (!records.length) return element('p', empty);
    const list = element('ul', null, 'ops-items');
    for (const record of records) list.append(element('li', describe(record)));
    return list;
  }

  async function enableNotifications(button, status) {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
      status.textContent = 'Browser ini tidak mendukung notifikasi NMS.';
      return;
    }
    try {
      if (await Notification.requestPermission() !== 'granted') {
        status.textContent = 'Izin notifikasi belum diberikan.';
        return;
      }
      notificationRegistration = await navigator.serviceWorker.register('/nms-worker.js');
      button.disabled = true;
      status.textContent = 'Notifikasi aktif saat dashboard ini terbuka.';
    } catch {
      status.textContent = 'Notifikasi tidak dapat diaktifkan di browser ini.';
    }
  }

  async function refreshAlarms() {
    try {
      const records = await api('/api/alarms');
      const active = records.filter(alarm => alarm.until === null);
      alarmMenu.textContent = active.length ? 'Alarm (' + active.length + ')' : 'Alarm';
      const maximum = Math.max(0, ...records.map(alarm => alarm.id));
      if (currentAlarmId !== null) {
        for (const alarm of active.filter(item => item.id > currentAlarmId)) {
          if (window.AndroidNotifier && typeof window.AndroidNotifier.postNotification === 'function') {
            try { window.AndroidNotifier.postNotification(alarm.title, alarm.detail); } catch {}
          }
          if (notificationRegistration) {
            await notificationRegistration.showNotification(alarm.title, {
              body: alarm.detail, tag: 'momo-alarm-' + alarm.id, icon: '/momo-logo.png',
            }).catch(() => {});
          }
        }
      }
      currentAlarmId = Math.max(currentAlarmId ?? 0, maximum);
      return records;
    } catch {
      return null;
    }
  }

  alarmMenu.addEventListener('click', async () => {
    const target = open('Alarm jaringan');
    const records = await refreshAlarms();
    if (!dialog.open || byId('ops-title').textContent !== 'Alarm jaringan') return;
    const button = element('button', 'Aktifkan notifikasi', 'restart-button');
    button.type = 'button';
    button.disabled = Boolean(notificationRegistration);
    const status = element('p', notificationRegistration ? 'Notifikasi aktif saat dashboard ini terbuka.' : '');
    status.setAttribute('role', 'status');
    button.addEventListener('click', () => void enableNotifications(button, status));
    target.replaceChildren(button, status, records ? items(records, alarm =>
      (alarm.until ? 'Pulih' : 'Aktif') + ' · ' + alarm.title + ' · ' + alarm.detail + ' · ' + time(alarm.at),
    'Belum ada alarm.') : element('p', 'Alarm tidak bisa dimuat.'));
  });

  byId('admin-menu').addEventListener('click', async () => {
    const target = open('Admin');
    const form = element('form');
    for (const [name, label, type] of [['username', 'Username teknisi', 'text'], ['password', 'Password teknisi', 'password']]) {
      const field = element('label', label);
      const input = element('input');
      Object.assign(input, { name, type, required: true, maxLength: type === 'password' ? 128 : 32,
        minLength: type === 'password' ? 8 : 3, autocomplete: type === 'password' ? 'new-password' : 'off' });
      field.append(input);
      form.append(field);
    }
    const save = element('button', 'Buat akun teknisi', 'restart-button');
    const message = element('p');
    message.setAttribute('role', 'status');
    form.append(save, message);
    const accounts = element('div');
    const audit = element('div');
    const reload = async () => {
      const [users, records] = await Promise.all([api('/api/technicians'), api('/api/audit')]);
      const userList = element('ul', null, 'ops-items');
      for (const u of users) {
        const li = element('li');
        li.append(element('strong', u.username), element('span', ' · ' + (u.role === 'admin' ? 'Admin' : 'Teknisi')));
        if (u.role !== 'admin') {
          const btns = element('div', null, 'client-actions');
          const chgPw = element('button', 'Ganti Password', 'restart-button');
          chgPw.type = 'button';
          chgPw.onclick = async () => {
            const pw = window.prompt('Password baru untuk ' + u.username + ' (min. 8 karakter):');
            if (!pw) return;
            if (pw.length < 8 || pw.length > 128) {
              message.textContent = 'Password baru harus 8–128 karakter.';
              return;
            }
            chgPw.disabled = true;
            try {
              const res = await api('/api/technicians/password', { username: u.username, password: pw });
              message.textContent = res.message;
            } catch (err) {
              message.textContent = err.message;
            } finally {
              chgPw.disabled = false;
            }
          };
          const delBtn = element('button', 'Hapus', 'restart-button delete-onu');
          delBtn.type = 'button';
          delBtn.onclick = async () => {
            if (!window.confirm('Hapus akun teknisi ' + u.username + '?')) return;
            delBtn.disabled = true;
            try {
              const res = await api('/api/technicians/delete', { username: u.username });
              message.textContent = res.message;
              await reload();
            } catch (err) {
              message.textContent = err.message;
              delBtn.disabled = false;
            }
          };
          btns.append(chgPw, delBtn);
          li.append(btns);
        }
        userList.append(li);
      }
      accounts.replaceChildren(users.length ? userList : element('p', 'Belum ada akun.'));
      const outcome = { sent:'Perintah diterima', rejected:'Ditolak', uncertain:'Hasil belum pasti', request:'Permintaan tercatat' };
      const recovery = { waiting:'Pemulihan belum teramati', down:'Teramati offline', online:'Kembali online' };
      audit.replaceChildren(items(records, e => [
        time(e.at), e.operation === 'delete' ? 'Hapus ONU' : 'Restart Modem',
        e.client_name ? 'Klien: ' + e.client_name : e.inventory_name ? 'Klien: ' + e.inventory_name + ' (nama saat ini)' : 'Nama klien belum diketahui',
        'Oleh ' + e.username, e.host, e.mac,
        e.operation === 'delete' && e.outcome === 'sent' ? 'Terhapus di OLT' : outcome[e.outcome],
        e.operation !== 'delete' && ['sent', 'uncertain'].includes(e.outcome) ? recovery[e.recovery] : '',
      ].filter(Boolean).join(' · '), 'Belum ada tindakan ONU.'));
    };
    form.addEventListener('submit', async event => {
      event.preventDefault();
      save.disabled = true;
      try {
        const result = await api('/api/technicians', Object.fromEntries(new FormData(form)));
        form.reset();
        message.textContent = result.message;
        await reload();
      } catch (error) {
        message.textContent = error.message;
      } finally {
        save.disabled = false;
      }
    });
    const navGroup = element('div', null, 'client-actions');
    const manage = element('button', 'Manajemen OLT', 'restart-button');
    manage.type = 'button';
    manage.addEventListener('click', () => void showOltManagement());

    const manageRouter = element('button', 'Pengaturan MikroTik', 'restart-button');
    manageRouter.type = 'button';
    manageRouter.addEventListener('click', () => void showRouterManagement());

    const manageBackup = element('button', 'Cadangkan & Impor', 'restart-button');
    manageBackup.type = 'button';
    manageBackup.addEventListener('click', () => void showBackupManagement());

    const managePin = element('button', 'Atur PIN', 'restart-button');
    managePin.type = 'button';
    managePin.addEventListener('click', () => void showPinManagement());

    navGroup.append(manage, manageRouter, manageBackup, managePin);
    target.replaceChildren(navGroup, form, element('h3', 'Daftar akun'), accounts, element('h3', 'Log Tindakan ONU'), audit);
    try { await reload(); } catch (error) { message.textContent = error.message; }
  });

  async function showRouterManagement() {
    const target = open('Pengaturan Multi-MikroTik (Multi-Site)');
    const back = element('button', 'Kembali ke Admin', 'restart-button');
    back.type = 'button';
    back.addEventListener('click', () => byId('admin-menu').click());

    const form = element('form');
    const nameField = element('label', 'Nama Site / Router');
    const nameInput = element('input');
    nameInput.name = 'name';
    nameInput.placeholder = 'Contoh: MikroTik Site HSGQ';
    nameInput.maxLength = 60;
    nameInput.required = true;
    nameField.append(nameInput);

    const protoField = element('label', 'Mode Koneksi / Protokol');
    const protoSelect = element('select');
    protoSelect.name = 'protocol';
    protoSelect.add(new Option('REST HTTP (RouterOS v7)', 'http'));
    protoSelect.add(new Option('MikroTik API Port 8728 (ROS v6 & v7)', 'api'));
    protoField.append(protoSelect);

    const urlField = element('label', 'Alamat MikroTik (URL atau IP)');
    const urlInput = element('input');
    urlInput.name = 'url';
    urlInput.placeholder = 'http://10.0.1.2:808';
    urlInput.required = true;
    urlField.append(urlInput);

    const hint = element('p', 'Tip ROS 6 (RB750Gr3 dll.): aktifkan service "api" (port 8728) di WinBox → IP → Services.');
    hint.style.fontSize = '12px';
    hint.style.color = 'var(--muted)';

    protoSelect.addEventListener('change', () => {
      urlInput.placeholder = protoSelect.value === 'api' ? 'api://10.25.0.1:8728 (atau cukup 10.25.0.1)' : 'http://10.0.1.2:808';
    });

    const userField = element('label', 'Username REST');
    const userInput = element('input');
    userInput.name = 'username';
    userInput.placeholder = 'admin';
    userInput.required = true;
    userField.append(userInput);

    const passField = element('label', 'Password REST');
    const passInput = element('input');
    passInput.name = 'password';
    passInput.type = 'password';
    passInput.required = true;
    passField.append(passInput);

    const oltCheckWrap = element('div');
    oltCheckWrap.style.margin = '8px 0';
    const save = element('button', 'Tambah MikroTik', 'restart-button');
    const message = element('p');
    message.setAttribute('role', 'status');
    const statusBox = element('div');

    form.append(nameField, protoField, urlField, hint, userField, passField, oltCheckWrap, save);

    async function loadOltChoices() {
      try {
        const olts = await api('/api/admin/olts');
        const wrap = element('div');
        wrap.append(element('p', 'OLT Terkait di Site ini (kosongkan semua = cocokkan dengan semua OLT):'));
        for (const o of olts) {
          const lbl = element('label');
          lbl.style.display = 'flex';
          lbl.style.alignItems = 'center';
          lbl.style.gap = '8px';
          const cb = element('input');
          cb.type = 'checkbox';
          cb.name = 'oltHost';
          cb.value = o.host;
          cb.style.width = 'auto';
          cb.style.minHeight = 'auto';
          lbl.append(cb, element('span', o.name + ' (' + o.host + ')'));
          wrap.append(lbl);
        }
        oltCheckWrap.replaceChildren(wrap);
      } catch {}
    }

    async function loadRouters() {
      try {
        const list = await api('/api/admin/routers');
        if (!Array.isArray(list) || !list.length) {
          statusBox.replaceChildren(element('p', 'Belum ada MikroTik terdaftar.'));
          return;
        }
        const ul = element('ul', null, 'ops-items');
        for (const r of list) {
          const li = element('li');
          const stateText = r.error ? 'Error: ' + r.error
            : r.available ? 'Aktif · ' + r.activeSessions + ' sesi PPPoE'
            : 'Menunggu polling (' + (r.activeSessions ?? 0) + ' sesi)';
          const boundText = Array.isArray(r.oltHosts) && r.oltHosts.length
            ? 'OLT: ' + r.oltHosts.join(', ')
            : 'OLT: Semua';
          li.append(
            element('strong', r.name),
            element('p', r.url + ' · ' + stateText),
            element('p', boundText)
          );
          const del = element('button', 'Hapus MikroTik', 'restart-button delete-onu');
          del.type = 'button';
          del.onclick = async () => {
            if (!window.confirm('Hapus ' + r.name + ' (' + r.url + ')?')) return;
            del.disabled = true;
            try {
              const res = await api('/api/admin/routers', { action: 'remove', id: r.id });
              message.textContent = res.message;
              await loadRouters();
            } catch (err) {
              message.textContent = err.message;
              del.disabled = false;
            }
          };
          li.append(del);
          ul.append(li);
        }
        statusBox.replaceChildren(ul);
      } catch (err) {
        message.textContent = err.message;
      }
    }

    form.addEventListener('submit', async event => {
      event.preventDefault();
      save.disabled = true;
      message.textContent = 'Menyimpan MikroTik...';
      try {
        const fd = new FormData(form);
        const oltHosts = fd.getAll('oltHost');
        let rawUrl = String(fd.get('url') || '').trim();
        const proto = String(fd.get('protocol') || 'http');
        if (!/^[a-z]+:\/\//i.test(rawUrl)) {
          if (proto === 'api') {
            rawUrl = 'api://' + rawUrl + (rawUrl.includes(':') ? '' : ':8728');
          } else {
            rawUrl = 'http://' + rawUrl;
          }
        }
        const payload = {
          action: 'add',
          name: fd.get('name'),
          url: rawUrl,
          username: fd.get('username'),
          password: fd.get('password'),
          oltHosts,
        };
        const res = await api('/api/admin/routers', payload);
        message.textContent = res.message;
        form.reset();
        await loadRouters();
      } catch (err) {
        message.textContent = err.message;
      } finally {
        save.disabled = false;
      }
    });

    target.replaceChildren(back, form, message, element('h3', 'Daftar MikroTik Terdaftar'), statusBox);
    await Promise.all([loadOltChoices(), loadRouters()]);
  }

  async function showBackupManagement() {
    const target = open('Cadangkan & Impor Konfigurasi');
    const back = element('button', 'Kembali ke Admin', 'restart-button');
    back.type = 'button';
    back.addEventListener('click', () => byId('admin-menu').click());

    const exportBtn = element('button', 'Muat / Salin Konfigurasi JSON', 'restart-button');
    const exportArea = element('textarea');
    exportArea.style.width = '100%';
    exportArea.style.height = '120px';
    exportArea.style.fontFamily = 'monospace';
    exportArea.style.fontSize = '12px';
    exportArea.placeholder = 'Klik tombol di atas untuk memuat data konfigurasi';

    exportBtn.addEventListener('click', async () => {
      try {
        const data = await api('/api/admin/config/export');
        exportArea.value = JSON.stringify(data, null, 2);
        await navigator.clipboard?.writeText(exportArea.value);
        msg.textContent = 'Konfigurasi dimuat dan disalin ke clipboard!';
      } catch (err) {
        msg.textContent = err.message;
      }
    });

    const importForm = element('form');
    const importArea = element('textarea');
    importArea.style.width = '100%';
    importArea.style.height = '120px';
    importArea.style.fontFamily = 'monospace';
    importArea.style.fontSize = '12px';
    importArea.placeholder = 'Tempel JSON konfigurasi di sini untuk memulihkan...';
    importArea.required = true;

    const importBtn = element('button', 'Terapkan Impor JSON', 'restart-button');
    const msg = element('p');
    msg.setAttribute('role', 'status');

    importForm.append(importArea, importBtn);
    importForm.addEventListener('submit', async event => {
      event.preventDefault();
      if (!window.confirm('Terapkan konfigurasi ini? Data OLT & router akan diperbarui.')) return;
      importBtn.disabled = true;
      msg.textContent = 'Mengimpor...';
      try {
        const parsed = JSON.parse(importArea.value.trim());
        const res = await api('/api/admin/config/import', parsed);
        msg.textContent = res.message;
        importArea.value = '';
      } catch (err) {
        msg.textContent = 'Gagal impor: ' + err.message;
      } finally {
        importBtn.disabled = false;
      }
    });

    target.replaceChildren(back, element('h3', 'Ekspor Cadangan'), exportBtn, exportArea, element('h3', 'Impor Cadangan'), importForm, msg);
  }

  async function showPinManagement() {
    const target = open('Atur / Ganti PIN Keamanan');
    const back = element('button', 'Kembali ke Admin', 'restart-button');
    back.type = 'button';
    back.addEventListener('click', () => byId('admin-menu').click());

    const form = element('form');
    const label = element('label', 'PIN Baru (4–8 digit angka)');
    const input = element('input');
    input.type = 'password';
    input.inputMode = 'numeric';
    input.pattern = '[0-9]*';
    input.maxLength = 8;
    input.required = true;
    input.placeholder = 'Contoh: 123456';
    label.append(input);

    const save = element('button', 'Simpan PIN', 'restart-button');
    const msg = element('p');
    msg.setAttribute('role', 'status');

    form.append(label, save);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      save.disabled = true;
      try {
        const res = await api('/api/pin/setup', { pin: input.value.trim() });
        msg.textContent = res.message;
        input.value = '';
      } catch (err) {
        msg.textContent = err.message;
      } finally {
        save.disabled = false;
      }
    });

    target.replaceChildren(back, form, msg);
  }

  async function showOltManagement() {
    const title = 'Manajemen OLT';
    const target = open(title);
    const form = element('form');
    const vendorField = element('label', 'Tipe OLT');
    const vendorSelect = element('select');
    vendorSelect.name = 'vendor';
    vendorSelect.add(new Option('HiOSO (EPON)', 'hioso'));
    vendorSelect.add(new Option('HSGQ-E04R (EPON)', 'hsgq'));
    vendorField.append(vendorSelect);
    form.append(vendorField);
    for (const [name, label, type, maxLength, required] of [
      ['name', 'Nama OLT', 'text', 80, true],
      ['host', 'Alamat IPv4', 'text', 15, true],
      ['community', 'Community SNMP baca', 'password', 128, true],
      ['port', 'Port UDP', 'number', null, true],
      ['adminUser', 'User Admin Web OLT (opsional, untuk restart)', 'text', 32, false],
      ['adminPassword', 'Password Admin Web OLT (opsional)', 'password', 64, false],
    ]) {
      const field = element('label', label);
      const input = element('input');
      Object.assign(input, { name, type, required: Boolean(required) });
      if (maxLength) input.maxLength = maxLength;
      if (name === 'host') input.placeholder = '192.168.0.100';
      if (name === 'community') input.autocomplete = 'new-password';
      if (name === 'port') Object.assign(input, { value: '161', min: '1', max: '65535', step: '1' });
      field.append(input);
      form.append(field);
    }
    const save = element('button', 'Tambah OLT', 'restart-button');
    const message = element('p');
    message.setAttribute('role', 'status');
    const list = element('div');
    const refresh = element('button', 'Perbarui status', 'restart-button');
    refresh.type = 'button';
    const back = element('button', 'Kembali ke Admin', 'restart-button');
    back.type = 'button';
    back.addEventListener('click', () => byId('admin-menu').click());
    form.append(save);
    target.replaceChildren(back, form, message, element('h3', 'OLT terdaftar'), refresh, list);

    async function reload() {
      try {
        const devices = await api('/api/admin/olts');
        const entries = element('ul', null, 'ops-items');
        for (const device of devices) {
          const item = element('li');
          const vendorTag = device.vendor === 'hsgq' ? 'HSGQ' : 'HiOSO';
          const state = device.polling ? 'Memeriksa SNMP…' : device.error ?? (device.updated ? 'SNMP aktif' : 'Menunggu polling');
          item.append(element('strong', device.name + ' [' + vendorTag + ']'), element('p', device.host + ':' + device.port + ' · ' + state));
          const remove = element('button', 'Hapus OLT', 'restart-button');
          remove.type = 'button';
          remove.setAttribute('aria-label', 'Hapus OLT ' + device.name);
          remove.addEventListener('click', async () => {
            if (!window.confirm('Hapus ' + device.name + ' (' + device.host + ') dari daftar pemantauan?')) return;
            remove.disabled = true;
            try {
              const result = await api('/api/admin/olts', { action: 'remove', host: device.host });
              message.textContent = result.message;
              await reload();
            } catch (error) {
              message.textContent = error.message;
              remove.disabled = false;
            }
          });
          item.append(remove);
          entries.append(item);
        }
        list.replaceChildren(devices.length ? entries : element('p', 'Belum ada OLT terdaftar.'));
      } catch (error) {
        message.textContent = error.message;
      }
    }

    refresh.addEventListener('click', reload);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      save.disabled = true;
      try {
        const result = await api('/api/admin/olts', { action: 'add', ...Object.fromEntries(new FormData(form)) });
        message.textContent = result.message;
        form.reset();
        await reload();
      } catch (error) {
        message.textContent = error.message;
      } finally {
        save.disabled = false;
      }
    });
    await reload();
  }

  function chart(title, unit, data, series, windowMs) {
    const section = element('section', null, 'ops-charts');
    section.append(element('h3', title));
    const points = data.filter(row => series.some(({ key }) => Number.isFinite(row[key])));
    if (!points.length) {
      section.append(element('p', 'Belum ada sampel untuk rentang ini.'));
      return section;
    }
    const number = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 });
    const measure = value => Number.isFinite(value) ? number.format(value) + ' ' + unit : '—';
    const stats = series.map(({ key, label, color }) => {
      const values = points.map(row => row[key]).filter(Number.isFinite);
      const low = values.length ? Math.min(...values) : null;
      const high = values.length ? Math.max(...values) : null;
      const avg = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
      const text = [label, 'Terakhir ' + measure(values.at(-1)), 'Min ' + measure(low),
        'Rata-rata ' + measure(avg), 'Maks ' + measure(high)].join(' · ');
      const summary = element('p', text);
      summary.style.borderInlineStart = '3px solid ' + color;
      summary.className = 'chart-summary';
      section.append(summary);
      return { low, high };
    });
    let min = unit === 'Mbps' ? 0 : Math.floor(Math.min(...stats.map(s => s.low ?? Infinity)));
    let max = Math.max(...stats.map(s => s.high ?? -Infinity));
    if (unit === 'dBm') max = Math.ceil(max);
    if (max === min) { if (unit === 'dBm') min -= 1; max += 1; }
    const canvas = element('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Grafik ' + title + '. Gunakan pemilih sampel untuk membaca data.');
    const end = Date.now();
    const begin = Math.max(end - windowMs, data[0].at - 60000);
    const labelTime = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Makassar',
      ...(end - begin > 86400000 ? { day:'2-digit', month:'2-digit' } : { hour:'2-digit', minute:'2-digit' }) });
    const sample = element('p', null, 'chart-sample');
    const label = element('label', 'Pilih sampel ' + title);
    const picker = element('input');
    Object.assign(picker, { type:'range', min:'0', max:String(points.length - 1), value:String(points.length - 1),
      disabled: points.length < 2 });
    label.append(picker);
    section.append(canvas, label, sample);
    const height = 186;
    const left = 48;
    const right = 12;
    const top = 12;
    const bottom = 150;
    let width = 0;

    function draw() {
      width = Math.max(220, canvas.clientWidth);
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(scale, scale);
      const x = at => left + (at - begin) / (end - begin) * (width - left - right);
      const y = value => bottom - (value - min) / (max - min) * (bottom - top);
      ctx.font = '11px system-ui';
      ctx.fillStyle = '#526381';
      ctx.strokeStyle = '#dbe5f5';
      ctx.textAlign = 'right';
      for (let i = 0; i <= 4; i++) {
        const value = min + (max - min) * i / 4;
        const position = y(value);
        ctx.beginPath();
        ctx.moveTo(left, position);
        ctx.lineTo(width - right, position);
        ctx.stroke();
        ctx.fillText(number.format(value), left - 6, position + 4);
      }
      ctx.textAlign = 'left';
      ctx.fillText(labelTime.format(begin), left, 172);
      ctx.textAlign = 'right';
      ctx.fillText(labelTime.format(end) + ' WITA', width - right, 172);
      for (const { key, color } of series) {
        ctx.strokeStyle = ctx.fillStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        let previousAt = 0;
        for (const row of data) {
          if (!Number.isFinite(row[key])) { previousAt = 0; continue; }
          const px = x(row.at);
          const py = y(row[key]);
          if (row.at - previousAt <= 120000) ctx.lineTo(px, py);
          else { ctx.moveTo(px, py); ctx.fillRect(px - 1, py - 1, 3, 3); }
          previousAt = row.at;
        }
        ctx.stroke();
      }
      const point = points[Number(picker.value)];
      const cursor = x(point.at);
      ctx.strokeStyle = '#526381';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cursor, top);
      ctx.lineTo(cursor, bottom);
      ctx.stroke();
      for (const { key, color } of series) {
        if (!Number.isFinite(point[key])) continue;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(cursor, y(point[key]), 4, 0, Math.PI * 2);
        ctx.fill();
      }
      sample.textContent = [time(point.at), ...series.map(({ key, label }) => label + ' ' + measure(point[key]))].join(' · ');
      picker.setAttribute('aria-valuetext', sample.textContent);
    }
    picker.addEventListener('input', draw);
    canvas.addEventListener('pointerdown', event => {
      const at = begin + (event.clientX - canvas.getBoundingClientRect().left - left) /
        (width - left - right) * (end - begin);
      let closest = 0;
      for (let i = 1; i < points.length; i++) {
        if (Math.abs(points[i].at - at) < Math.abs(points[closest].at - at)) closest = i;
      }
      picker.value = String(closest);
      draw();
    });
    requestAnimationFrame(draw);
    return section;
  }

  const shownTime = value => value == null ? 'Belum teramati' : time(value);

  function clientFacts(client) {
    const ppp = client.pppoe;
    const facts = [
      ['OLT', client.source.name + ' · ' + client.source.host],
      ['Grup PON SNMP', client.index.split('.').slice(0, -1).join('.') || '—'],
      ['Status ONU', (client.status ?? 'Tidak diketahui') + (client.stale ? ' · Data lama' : '')],
      ['Redaman', client.rx == null ? 'Belum terukur' : client.rx.toLocaleString('id-ID') + ' dBm'],
      ['Offline teramati sejak', shownTime(client.observation?.offline_since)],
      ['Terakhir teramati online', shownTime(client.observation?.last_online)],
      ['Sesi PPPoE', ppp?.username ? [ppp.username, ppp.address, ppp.uptime].filter(Boolean).join(' · ')
        : ppp?.state === 'ambiguous' ? 'MAC PPPoE ambigu' : 'Belum ada sesi yang cocok'],
      ['Sampel OLT', shownTime(client.sampledAt)],
    ];
    const list = element('dl', null, 'client-facts');
    for (const [name, value] of facts) {
      const field = element('div');
      field.append(element('dt', name), element('dd', value));
      list.append(field);
    }
    return list;
  }

  async function showHistory(row, back) {
    const target = open('Detail Pelanggan');
    const identity = element('p', (row.name || row.mac) + ' · ' + row.mac + ' · ' + row.source.name);
    const facts = element('div');
    const actions = element('div', null, 'client-actions');
    const range = element('select');
    range.add(new Option('1 jam', 'hour'));
    range.add(new Option('24 jam', '1'));
    range.add(new Option('7 hari', '7'));
    range.value = '1';
    range.setAttribute('aria-label', 'Rentang riwayat');
    const result = element('div');
    target.replaceChildren(identity, facts, actions, range, result);
    if (back) {
      const returnButton = element('button', 'Kembali ke kandidat', 'restart-button');
      returnButton.type = 'button';
      returnButton.onclick = back;
      target.prepend(returnButton);
    }
    async function update() {
      const days = range.value;
      const windowMs = days === 'hour' ? 3600000 : Number(days) * 86400000;
      result.replaceChildren(element('p', 'Memuat riwayat…'));
      try {
        const { client, history: data, actions: activity } = await api('/api/onu/detail?' + new URLSearchParams({
          host: row.source.host, mac: row.mac, index: row.index, days,
        }));
        if (range.value !== days) return;
        facts.replaceChildren(clientFacts(client));
        if (client.duplicate) facts.append(element('p', 'MAC ganda di OLT ini. Detail menggunakan registrasi ONU yang dipilih.'));
        actions.replaceChildren();
        if (!client.stale) {
          if (client.status === 'Online') {
            const restartArea = element('span');
            setRestartAction(restartArea, client);
            actions.append(restartArea);
          }
          if (client.status === 'Offline') deleteButton(actions, client);
        }
        const observations = data.filter(point => point.status);
        const changes = observations.filter((point, index) => index && point.status !== observations[index - 1].status)
          .map(point => ({ at: point.at, text: 'ONU teramati ' + point.status.toLowerCase() }));
        const outcomes = { sent:'Perintah diterima', rejected:'Ditolak', uncertain:'Hasil belum pasti', request:'Permintaan tercatat' };
        const timeline = [...changes, ...(activity ?? []).map(event => ({
          at: event.at,
          text: (event.operation === 'delete' ? 'Hapus ONU' : 'Restart Modem') + ' · ' + event.username +
            ' · ' + (outcomes[event.outcome] ?? event.outcome) + (event.recovery === 'online' ? ' · Kembali online' : ''),
        }))].sort((a, b) => b.at - a.at).slice(0, 30);
        const traffic = data.map(r => ({ ...r, tx: r.tx == null ? null : r.tx / 1e6,
          upload: r.upload == null ? null : r.upload / 1e6 }));
        result.replaceChildren(
          chart('Redaman', 'dBm', data, [{ key:'rx', label:'Redaman', color:'#174fcb' }], windowMs),
          chart('Trafik PPPoE', 'Mbps', traffic, [
            { key:'tx', label:'TX Unduh', color:'#174fcb' },
            { key:'upload', label:'RX Unggah', color:'#a12b66' },
          ], windowMs),
          element('h3', 'Lini masa'),
          items(timeline, event => time(event.at) + ' · ' + event.text, 'Belum ada perubahan status tercatat.'),
        );
      } catch (error) { result.replaceChildren(element('p', error.message)); }
    }
    range.addEventListener('change', update);
    await update();
  }

  function historyButton(cell, row) {
    let button = cell.querySelector('.history-button');
    if (!row.mac) { button?.remove(); return; }
    if (!button) {
      button = element('button', 'Detail Pelanggan', 'restart-button history-button');
      button.type = 'button';
      cell.append(button);
    }
    button.onclick = () => void showHistory(row);
  }

  async function showOffline(initial = '7') {
    const target = open('ONU Lama Offline');
    const label = element('label', 'Durasi offline teramati');
    const threshold = element('select');
    for (const days of [7, 14, 30]) threshold.add(new Option('Minimal ' + days + ' hari', String(days)));
    threshold.add(new Option('Semua yang terpantau offline', '0'));
    threshold.value = initial;
    label.append(threshold);
    const result = element('div');
    target.replaceChildren(element('p', 'Durasi dihitung sejak NMS mengamati ONU offline secara berkelanjutan.'), label, result);
    async function update() {
      const days = threshold.value;
      result.replaceChildren(element('p', 'Memuat kandidat…'));
      try {
        const { candidates, excluded } = await api('/api/admin/offline-onus?days=' + days);
        if (threshold.value !== days) return;
        const list = element('ul', null, 'ops-items');
        for (const row of candidates) {
          const item = element('li');
          const hours = Math.max(0, Math.floor((Date.now() - row.observation.offline_since) / 3600000));
          const duration = hours < 1 ? 'Kurang dari 1 jam' : Math.floor(hours / 24) + ' hari ' + hours % 24 + ' jam';
          item.append(element('strong', (row.name || row.mac) + (row.duplicate ? ' · MAC ganda' : '')),
            element('p', row.source.name + ' · ' + row.mac + ' · ' + duration),
            element('p', 'Terakhir online: ' + shownTime(row.observation.last_online)));
          const details = element('button', 'Detail Pelanggan', 'restart-button');
          details.type = 'button';
          details.onclick = () => void showHistory(row, () => void showOffline(days));
          item.append(details);
          list.append(item);
        }
        result.replaceChildren(element('p', candidates.length + ' kandidat'),
          candidates.length ? list : element('p', 'Belum ada ONU yang memenuhi durasi ini.'));
        if (excluded.length) result.append(element('p', 'Menunggu data terbaru dari ' + excluded.join(', ') + '.'));
      } catch (error) { result.replaceChildren(element('p', error.message)); }
    }
    threshold.addEventListener('change', update);
    await update();
  }
  byId('offline-menu').addEventListener('click', () => void showOffline());

  function deleteButton(cell, row) {
    let button = cell.querySelector('.delete-onu');
    if (!isAdmin || row.status !== 'Offline' || !row.mac || !row.source.directRestart) {
      button?.remove();
      return;
    }
    if (!button) {
      button = element('button', 'Hapus ONU', 'restart-button delete-onu');
      button.type = 'button';
      cell.append(button);
    }
    button.onclick = () => {
      const target = open('Hapus ONU dari OLT');
      const form = element('form');
      const label = element('label', 'Ketik ulang MAC ' + row.mac);
      const input = element('input');
      Object.assign(input, { required: true, maxLength: 17, autocomplete: 'off', spellcheck: false });
      label.append(input);
      const submit = element('button', 'Hapus dari OLT', 'restart-button delete-onu');
      const status = element('p');
      status.setAttribute('role', 'status');
      submit.disabled = true;
      input.addEventListener('input', () => { submit.disabled = input.value.trim().toUpperCase() !== row.mac; });
      form.append(label, submit, status);
      target.replaceChildren(
        element('p', [row.name, row.mac, row.source.name, row.source.host].filter(Boolean).join(' · ')),
        element('p', 'Registrasi ONU akan dihapus dari OLT. Daftarkan ulang ONU jika perlu digunakan kembali.'),
        form,
      );
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (submit.disabled || input.value.trim().toUpperCase() !== row.mac) return;
        submit.disabled = true;
        input.disabled = true;
        status.textContent = 'Memeriksa status dan menghapus dari OLT…';
        try {
          const result = await api('/api/onu/delete', { host: row.source.host, index: row.index,
            mac: row.mac, action: 'delete', confirmation: input.value.trim().toUpperCase() });
          status.textContent = result.message;
        } catch (error) {
          status.textContent = error.message || 'Hasil belum terkonfirmasi. Periksa daftar ONU di OLT.';
        }
      });
    };
  }

  async function start(load) {
    const auth = byId('auth-dialog');
    const form = byId('auth-form');
    const submit = byId('auth-submit');
    const result = byId('auth-result');
    const pinSection = byId('pin-section');
    const pinInput = byId('pin-input');
    const pinSubmit = byId('pin-submit');
    const pinResult = byId('pin-result');
    const switchToPass = byId('switch-to-pass');
    const switchToPin = byId('switch-to-pin');
    const setupPinLabel = byId('setup-pin-label');
    let setup = false;
    auth.addEventListener('cancel', event => event.preventDefault());

    if (switchToPass) switchToPass.onclick = () => {
      if (pinSection) pinSection.hidden = true;
      form.hidden = false;
    };
    if (switchToPin) switchToPin.onclick = () => {
      if (pinSection) pinSection.hidden = false;
      form.hidden = true;
      if (pinInput) pinInput.focus();
    };
    if (pinSubmit) pinSubmit.onclick = async () => {
      const pin = pinInput ? pinInput.value.trim() : '';
      if (!pin) return;
      if (pinResult) pinResult.textContent = 'Memverifikasi PIN…';
      try {
        await api('/api/pin/login', { pin });
        await enter();
      } catch (err) {
        if (pinResult) pinResult.textContent = err.message;
      }
    };

    const enter = async () => {
      const state = await api('/api/session');
      setup = state.setup;
      if (!state.user) {
        byId('auth-title').textContent = setup ? 'Buat akun admin' : 'Masuk ke NMS';
        submit.textContent = setup ? 'Buat admin' : 'Masuk';
        form.elements.password.autocomplete = setup ? 'new-password' : 'current-password';
        if (setupPinLabel) setupPinLabel.hidden = !setup;
        if (state.hasPin && !setup) {
          if (pinSection) pinSection.hidden = false;
          form.hidden = true;
          if (switchToPin) switchToPin.hidden = false;
        } else {
          if (pinSection) pinSection.hidden = true;
          form.hidden = false;
          if (switchToPin) switchToPin.hidden = true;
        }
        if (!auth.open) auth.showModal();
        return;
      }
      form.reset();
      if (auth.open) auth.close();
      byId('session-user').textContent = state.user.username;
      isAdmin = state.user.role === 'admin';
      byId('admin-menu').hidden = !isAdmin;
      byId('offline-menu').hidden = !isAdmin;
      byId('operations-menu').hidden = false;
      if ('Notification' in window && 'serviceWorker' in navigator) {
        if (Notification.permission === 'default') {
          Notification.requestPermission().catch(() => {});
        }
        if (Notification.permission === 'granted') {
          navigator.serviceWorker.register('/nms-worker.js').then(registration => {
            notificationRegistration = registration;
          }).catch(() => {});
        }
      }
      void load();
      void refreshAlarms();
      setInterval(refreshAlarms, 10000);
    };
    form.addEventListener('submit', async event => {
      event.preventDefault();
      submit.disabled = true;
      try {
        await api(setup ? '/api/setup' : '/api/login', Object.fromEntries(new FormData(form)));
        await enter();
      } catch (error) { result.textContent = error.message; }
      finally { submit.disabled = false; }
    });
    byId('logout').onclick = async () => {
      try { await api('/api/logout', {}); location.reload(); }
      catch (error) { byId('session-user').textContent = error.message; }
    };
    try { await enter(); } catch (error) {
      result.textContent = error.message;
      auth.showModal();
    }
  }

  return { start, historyButton, deleteButton };
})();
