(function () {
  'use strict';

  const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli',
    'Agustus', 'September', 'Oktober', 'November', 'Desember'];

 
  const LOCAL_DEV =
    (location.hostname === '127.0.0.1' || location.hostname === 'localhost') &&
    location.port === '5500';
  const FUNCTIONS_BASE = 'http://127.0.0.1:5001/demo-absensi-squad/asia-southeast2';

  function endpoint(name) {
    return LOCAL_DEV ? FUNCTIONS_BASE + '/' + name : '/api/' + name;
  }

  const MSG_NETWORK = 'Terjadi gangguan koneksi, silakan coba kembali.';

  const el = (id) => document.getElementById(id);
  const stateBox = el('state');
  const form = el('form');
  const sessionInfo = el('sessionInfo');
  const sessionSelect = el('sessionSelect');
  const memberBtn = el('memberBtn');
  const tokenInput = el('token');
  const submitBtn = el('submit');
  const resultBox = el('result');
  const againBtn = el('again');
  const picker = el('picker');
  const pickerClose = el('pickerClose');
  const search = el('search');
  const list = el('list');
  const countEl = el('count');
  const emptyEl = el('empty');

  const state = {
    sessions: [],
    members: [],
    sessionIndex: 0,
    member: null,
    busy: false,
    done: false,
  };

  // ---------- util ----------

  function pad(n) { return String(n).padStart(2, '0'); }

  function formatDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return iso || '';
    return Number(m[3]) + ' ' + BULAN[Number(m[2]) - 1] + ' ' + m[1];
  }

  function formatTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return pad(d.getHours()) + '.' + pad(d.getMinutes());
  }

  async function request(name, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(
        endpoint(name),
        Object.assign({ cache: 'no-store', signal: controller.signal }, options)
      );
      let body = null;
      try { body = await res.json(); } catch (e) { body = null; }
      return { status: res.status, body: body };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- tampilan ----------

  function showState(message, withRetry) {
    stateBox.hidden = false;
    stateBox.textContent = '';
    const p = document.createElement('p');
    p.textContent = message;
    stateBox.appendChild(p);
    if (withRetry) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'secondary';
      btn.textContent = 'Muat ulang';
      btn.addEventListener('click', load);
      stateBox.appendChild(btn);
    }
  }

  function hideState() {
    stateBox.hidden = true;
    stateBox.textContent = '';
  }

  function showResult(kind, message) {
    resultBox.hidden = false;
    resultBox.className = 'result ' + kind;
    resultBox.textContent = message;
  }

  function hideResult() {
    resultBox.hidden = true;
    resultBox.textContent = '';
  }

  function currentSession() {
    return state.sessions[state.sessionIndex];
  }

  function renderSession() {
    const multi = state.sessions.length > 1;
    sessionSelect.hidden = !multi;
    sessionInfo.hidden = multi;

    if (multi) {
      sessionSelect.textContent = '';
      state.sessions.forEach(function (s, i) {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = formatDate(s.date) + (s.name ? ' · ' + s.name : '');
        sessionSelect.appendChild(o);
      });
      sessionSelect.value = String(state.sessionIndex);
    } else {
      const s = state.sessions[0];
      sessionInfo.textContent = '';
      const d = document.createElement('div');
      d.className = 'session-date';
      d.textContent = formatDate(s.date);
      sessionInfo.appendChild(d);
      if (s.name) {
        const n = document.createElement('div');
        n.className = 'session-name';
        n.textContent = s.name;
        sessionInfo.appendChild(n);
      }
    }
  }

  function updateSubmit() {
    submitBtn.disabled =
      state.busy || state.done || !state.member || !tokenInput.value.trim();
  }

  function setBusy(busy) {
    state.busy = busy;
    submitBtn.textContent = busy ? 'MENGIRIM…' : 'ABSEN';
    memberBtn.disabled = busy || state.done;
    tokenInput.disabled = busy || state.done;
    updateSubmit();
  }

  // ---------- pemilih nama ----------

  function renderList() {
    const q = search.value.trim().toLowerCase();
    const items = state.members.filter(function (m) {
      return !q || m.name.toLowerCase().indexOf(q) !== -1;
    });
    list.textContent = '';
    items.forEach(function (m) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'item' + (state.member && state.member.id === m.id ? ' selected' : '');
      b.textContent = m.name;
      b.addEventListener('click', function () { choose(m); });
      li.appendChild(b);
      list.appendChild(li);
    });
    emptyEl.hidden = items.length > 0;
    countEl.textContent = items.length + ' nama';
  }

  function openPicker() {
    search.value = '';
    renderList();
    if (typeof picker.showModal === 'function') {
      picker.showModal();
    } else {
      picker.setAttribute('open', '');
    }
    setTimeout(function () { search.focus(); }, 0);
  }

  function closePicker() {
    if (typeof picker.close === 'function') picker.close();
    else picker.removeAttribute('open');
  }

  function choose(member) {
    state.member = member;
    memberBtn.textContent = member.name;
    memberBtn.classList.add('has-value');
    hideResult();
    closePicker();
    updateSubmit();
  }

  function resetForNextPerson() {
    state.member = null;
    state.done = false;
    memberBtn.textContent = 'Pilih namamu';
    memberBtn.classList.remove('has-value');
    memberBtn.disabled = false;
    tokenInput.disabled = false;
    sessionSelect.disabled = false;
    tokenInput.value = '';
    againBtn.hidden = true;
    hideResult();
    updateSubmit();
  }

  // ---------- kirim absen ----------

  function onSuccess(body) {
    state.done = true;
    tokenInput.value = '';
    tokenInput.disabled = true;
    memberBtn.disabled = true;
    sessionSelect.disabled = true;
    const t = formatTime(body.checkedInAt);
    const name = body.memberName || (state.member && state.member.name) || '';
    showResult(
      'success',
      'Absensi berhasil disimpan. Terima kasih, ' + name + '!' + (t ? ' (' + t + ')' : '')
    );
    againBtn.hidden = false;
    updateSubmit();
  }

  async function submit(event) {
    event.preventDefault();
    if (state.busy || state.done) return;
    hideResult();

    if (!state.member) {
      showResult('error', 'Silakan pilih nama anggota terlebih dahulu.');
      return;
    }
    if (!tokenInput.value.trim()) {
      showResult('error', 'Masukkan token terlebih dahulu.');
      return;
    }

    setBusy(true);
    try {
      const r = await request('checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: currentSession().sessionId,
          memberId: state.member.id,
          token: tokenInput.value,
        }),
      });
      // "Berhasil" hanya ditampilkan jika server menyatakan data sudah tersimpan.
      if (r.status === 200 && r.body && r.body.ok === true) {
        onSuccess(r.body);
      } else if (r.body && typeof r.body.message === 'string') {
        showResult('error', r.body.message);
      } else {
        showResult('error', MSG_NETWORK);
      }
    } catch (e) {
      showResult('error', MSG_NETWORK);
    } finally {
      setBusy(false);
    }
  }

  // ---------- muat data awal ----------

  async function load() {
    showState('Memuat sesi absensi…', false);
    form.hidden = true;
    try {
      const r = await request('info', { method: 'GET' });
      if (r.status !== 200 || !r.body || !Array.isArray(r.body.sessions)) {
        throw new Error('respons tidak valid');
      }
      state.sessions = r.body.sessions;
      state.members = Array.isArray(r.body.members) ? r.body.members : [];
      state.sessionIndex = 0;

      if (state.sessions.length === 0) {
        showState(
          'Belum ada sesi absensi yang dibuka. Tanyakan admin, lalu muat ulang halaman ini.',
          true
        );
        return;
      }
      hideState();
      renderSession();
      form.hidden = false;
      updateSubmit();
    } catch (e) {
      showState(MSG_NETWORK, true);
    }
  }

  // ---------- pasang event ----------

  memberBtn.addEventListener('click', openPicker);
  pickerClose.addEventListener('click', closePicker);
  picker.addEventListener('click', function (e) {
    if (e.target === picker) closePicker(); // klik di area gelap
  });
  search.addEventListener('input', renderList);
  tokenInput.addEventListener('input', function () {
    hideResult();
    updateSubmit();
  });
  sessionSelect.addEventListener('change', function () {
    state.sessionIndex = Number(sessionSelect.value) || 0;
    hideResult();
  });
  againBtn.addEventListener('click', resetForNextPerson);
  form.addEventListener('submit', submit);

  load();
})();