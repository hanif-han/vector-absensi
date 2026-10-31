(function () {
  'use strict';

  // Uji lokal: halaman dari dev-server.js (port 5500) memanggil emulator langsung.
  // Di produksi, semua lewat alamat yang sama (/api/...) melalui Firebase Hosting.
  const LOCAL_DEV =
    (location.hostname === '127.0.0.1' || location.hostname === 'localhost') &&
    location.port === '5500';
  const FUNCTIONS_BASE = 'http://127.0.0.1:5001/demo-absensi-squad/asia-southeast2';
  const endpoint = (name) => (LOCAL_DEV ? FUNCTIONS_BASE + '/' + name : '/api/' + name);

  const MSG_NETWORK = 'Terjadi gangguan koneksi, silakan coba kembali.';

  const el = (id) => document.getElementById(id);
  const form = el('form');
  const nameInput = el('displayName');
  const emailInput = el('email');
  const passInput = el('password');
  const pass2Input = el('password2');
  const submitBtn = el('submit');
  const resultBox = el('result');

  let busy = false;
  let done = false;

  function showResult(kind, message) {
    resultBox.hidden = false;
    resultBox.className = 'result ' + kind;
    resultBox.textContent = message;
  }

  function hideResult() {
    resultBox.hidden = true;
    resultBox.textContent = '';
  }

  function updateSubmit() {
    submitBtn.disabled =
      busy || done ||
      !nameInput.value.trim() || !emailInput.value.trim() ||
      !passInput.value || !pass2Input.value;
  }

  function setBusy(value) {
    busy = value;
    submitBtn.textContent = value ? 'MENGIRIM…' : 'DAFTAR';
    [nameInput, emailInput, passInput, pass2Input].forEach(function (f) {
      f.disabled = value || done;
    });
    updateSubmit();
  }

  // Pemeriksaan awal di browser (server memeriksa lagi dengan aturan yang sama).
  function validate() {
    const name = nameInput.value.trim().replace(/\s+/g, ' ');
    const email = emailInput.value.trim();
    const pass = passInput.value;
    if (name.length < 2 || name.length > 40) return 'Nama harus 2 sampai 40 karakter.';
    if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email)) return 'Format email tidak valid.';
    if (pass.length < 8 || pass.length > 64) return 'Password harus 8 sampai 64 karakter.';
    if (pass !== pass2Input.value) return 'Kedua password tidak sama.';
    return '';
  }

  async function submit(event) {
    event.preventDefault();
    if (busy || done) return;
    hideResult();

    const problem = validate();
    if (problem) {
      showResult('error', problem);
      return;
    }

    setBusy(true);
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, 15000);
    try {
      const res = await fetch(endpoint('register'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
        body: JSON.stringify({
          displayName: nameInput.value,
          email: emailInput.value,
          password: passInput.value,
        }),
      });
      let body = null;
      try { body = await res.json(); } catch (e) { body = null; }

      // "Berhasil" hanya ditampilkan jika server menyatakan data sudah tersimpan.
      if (res.status === 200 && body && body.ok === true) {
        done = true;
        passInput.value = '';
        pass2Input.value = '';
        showResult('success', body.message || 'Pendaftaran berhasil. Akunmu menunggu persetujuan admin.');
      } else if (body && typeof body.message === 'string') {
        showResult('error', body.message);
      } else {
        showResult('error', MSG_NETWORK);
      }
    } catch (e) {
      showResult('error', MSG_NETWORK);
    } finally {
      clearTimeout(timer);
      setBusy(false);
    }
  }

  [nameInput, emailInput, passInput, pass2Input].forEach(function (f) {
    f.addEventListener('input', function () {
      hideResult();
      updateSubmit();
    });
  });
  form.addEventListener('submit', submit);
  updateSubmit();
})();