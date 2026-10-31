// VECTOR SYNDICATE: backend absensi di Cloudflare Workers (gratis, tanpa kartu).
// Menggantikan Cloud Functions Firebase yang butuh paket Blaze.
// Aturan bisnisnya sama dengan versi Firebase (22 uji check-in dan 11 uji daftar).

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Token: huruf, angka, simbol, dan spasi (ASCII yang bisa dicetak), 1-100 karakter.
const TOKEN_PATTERN = /^[\x20-\x7E]{1,100}$/;
const TOKEN_RAW_MAX = 300;

// Token hanya berlaku 1 jam sejak dibuat. Batas ini tetap berlaku walau waktu
// kedaluwarsa di dokumen token tertulis lebih lama.
const TOKEN_MAX_AGE_MS = 60 * 60 * 1000;

// Batas percobaan dalam satu jendela waktu.
const WINDOW_MS = 10 * 60 * 1000;
const LIMIT_PER_MEMBER = 5;
const LIMIT_PER_IP = 15;
const LIMIT_GLOBAL = 100;
const REG_LIMIT_PER_IP = 10;
const REG_LIMIT_GLOBAL = 200;

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

// Daftar nama dan sesi disimpan sebentar di memori supaya hemat pembacaan.
const INFO_CACHE_MS = 15 * 1000;
let infoCache = { at: 0, data: null };

const MSG_SERVER = 'Terjadi gangguan koneksi, silakan coba kembali.';

// ---------- respons ----------

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function fail(status, code, message) {
  return json(status, { ok: false, code, message });
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 8192) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch (e) {
    return null;
  }
}

/** Kesalahan yang diketahui: kode, status HTTP, dan pesan untuk anggota. */
class CheckinError extends Error {
  constructor(code, status, message, countsAsFailure = false) {
    super(message);
    this.code = code;
    this.status = status;
    this.countsAsFailure = countsAsFailure;
  }
}

// ---------- util ----------

function bytesToB64Url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function jsonToB64Url(obj) {
  return bytesToB64Url(new TextEncoder().encode(JSON.stringify(obj)));
}

function pemToDer(pem) {
  const b64 = String(pem)
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function sha(text) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(String(text)),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

/** Rapikan token: spasi ganda jadi satu, spasi tepi dibuang, huruf besar. */
function normalizeToken(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/** ID dokumen dari token. Sama persis dengan yang dihitung APK (base64url tanpa padding). */
function tokenDocId(token) {
  return 't_' + bytesToB64Url(new TextEncoder().encode(token));
}

// ---------- tipe data Firestore (REST) ----------

/** Waktu Firestore. Disimpan sebagai teks RFC 3339 agar tidak ada presisi yang hilang. */
class Ts {
  constructor(iso) {
    this.iso = iso;
  }
  get ms() {
    return Date.parse(this.iso);
  }
}

function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Ts) return { timestampValue: v.iso };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v)
      ? { integerValue: String(v) }
      : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'object') return { mapValue: { fields: toFields(v) } };
  throw new Error('Tipe data tidak didukung');
}

function toFields(obj) {
  const out = {};
  for (const [k, val] of Object.entries(obj)) out[k] = toValue(val);
  return out;
}

function fromValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return new Ts(v.timestampValue);
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  return null;
}

function fromFields(fields) {
  const out = {};
  for (const [k, val] of Object.entries(fields || {})) out[k] = fromValue(val);
  return out;
}

function decodeDoc(doc) {
  const name = doc.name || '';
  const marker = '/documents/';
  const idx = name.indexOf(marker);
  const path = idx >= 0 ? name.slice(idx + marker.length) : name;
  return { id: path.split('/').pop(), path, data: fromFields(doc.fields) };
}

/** Waktu kedaluwarsa efektif (ms): paling lama 1 jam sejak token dibuat. */
function effectiveExpiryMs(t) {
  const c = [];
  if (t.expiresAt instanceof Ts) c.push(t.expiresAt.ms);
  if (t.createdAt instanceof Ts) c.push(t.createdAt.ms + TOKEN_MAX_AGE_MS);
  const valid = c.filter((n) => Number.isFinite(n));
  // Tanpa waktu yang valid: dianggap sudah kedaluwarsa.
  return valid.length > 0 ? Math.min(...valid) : 0;
}

// ---------- akses Google (akun layanan) ----------

let tokenCache = { value: '', exp: 0 };

/**
 * Token akses Google dari akun layanan (disimpan sebagai rahasia Worker).
 * Di emulator (lokal) tidak dipakai: emulator menerima "owner".
 */
async function getAccessToken(env) {
  if (env.FIRESTORE_EMULATOR_HOST || env.AUTH_EMULATOR_HOST) return 'owner';

  const now = Date.now();
  if (tokenCache.value && tokenCache.exp - now > 5 * 60 * 1000) {
    return tokenCache.value;
  }

  let sa;
  try {
    sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT);
  } catch (e) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT belum diisi atau bukan JSON');
  }
  if (!sa || !sa.client_email || !sa.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT tidak lengkap');
  }

  const iat = Math.floor(now / 1000);
  const unsigned =
    jsonToB64Url({ alg: 'RS256', typ: 'JWT' }) +
    '.' +
    jsonToB64Url({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      iat,
      exp: iat + 3600,
    });
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned),
  );
  const assertion = unsigned + '.' + bytesToB64Url(new Uint8Array(sig));

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.access_token) {
    throw new Error('Gagal mendapat token akses Google (' + res.status + ')');
  }
  tokenCache = {
    value: data.access_token,
    exp: now + (Number(data.expires_in) || 3600) * 1000,
  };
  return tokenCache.value;
}

// ---------- klien Firestore (REST) ----------

class Firestore {
  constructor(env) {
    this.env = env;
    const project = env.FIREBASE_PROJECT_ID;
    const emu = env.FIRESTORE_EMULATOR_HOST;
    const host = emu
      ? 'http://' + emu
      : 'https://firestore.googleapis.com';
    this.root = `${host}/v1/projects/${project}/databases/(default)/documents`;
    this.resource = `projects/${project}/databases/(default)/documents`;
  }

  docName(path) {
    return `${this.resource}/${path}`;
  }

  async request(method, url, body) {
    const token = await getAccessToken(this.env);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = null;
    }
    if (!res.ok) {
      const err = new Error('Firestore ' + res.status);
      err.status = res.status;
      err.code = data && data.error ? data.error.status : '';
      throw err;
    }
    return data;
  }

  /** Satu dokumen, atau null jika tidak ada. */
  async get(path) {
    try {
      return decodeDoc(await this.request('GET', `${this.root}/${path}`));
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  /** Beberapa dokumen sekaligus (urutan sama dengan [paths]; null jika tidak ada). */
  async batchGet(paths, transaction) {
    const body = { documents: paths.map((p) => this.docName(p)) };
    if (transaction) body.transaction = transaction;
    const items = await this.request('POST', `${this.root}:batchGet`, body);
    const found = {};
    for (const item of items || []) {
      if (item.found) {
        const d = decodeDoc(item.found);
        found[d.path] = d;
      }
    }
    return paths.map((p) => found[p] || null);
  }

  async query(structuredQuery) {
    const items = await this.request('POST', `${this.root}:runQuery`, {
      structuredQuery,
    });
    return (items || []).filter((r) => r.document).map((r) => decodeDoc(r.document));
  }

  async commit(writes, transaction) {
    const body = { writes };
    if (transaction) body.transaction = transaction;
    return this.request('POST', `${this.root}:commit`, body);
  }

  /** Perbarui sebagian field dokumen yang sudah ada. */
  updateWrite(path, fields, transforms = []) {
    const w = {
      update: { name: this.docName(path), fields: toFields(fields) },
      updateMask: { fieldPaths: Object.keys(fields) },
      currentDocument: { exists: true },
    };
    if (transforms.length > 0) {
      w.updateTransforms = transforms.map((f) => ({
        fieldPath: f,
        setToServerValue: 'REQUEST_TIME',
      }));
    }
    return w;
  }

  /** Buat atau timpa dokumen utuh. */
  setWrite(path, fields, transforms = [], mustNotExist = false) {
    const w = { update: { name: this.docName(path), fields: toFields(fields) } };
    if (mustNotExist) w.currentDocument = { exists: false };
    if (transforms.length > 0) {
      w.updateTransforms = transforms.map((f) => ({
        fieldPath: f,
        setToServerValue: 'REQUEST_TIME',
      }));
    }
    return w;
  }

  /**
   * Transaksi baca-tulis. fn menerima { getAll(paths), write(w) }.
   * Jika terjadi bentrok, diulang sampai [attempts] kali.
   */
  async transaction(fn, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
      const begin = await this.request('POST', `${this.root}:beginTransaction`, {
        options: { readWrite: {} },
      });
      const tx = begin.transaction;
      const writes = [];
      let result;
      try {
        result = await fn({
          getAll: (paths) => this.batchGet(paths, tx),
          write: (w) => writes.push(w),
        });
      } catch (e) {
        await this.request('POST', `${this.root}:rollback`, {
          transaction: tx,
        }).catch(() => {});
        throw e;
      }
      if (writes.length === 0) {
        await this.request('POST', `${this.root}:rollback`, {
          transaction: tx,
        }).catch(() => {});
        return result;
      }
      try {
        await this.commit(writes, tx);
        return result;
      } catch (e) {
        const conflict = e.status === 409 || e.code === 'ABORTED';
        if (conflict && i < attempts - 1) continue;
        throw e;
      }
    }
    throw new Error('Transaksi gagal');
  }
}

/** Panggilan admin Firebase Authentication (membuat dan menghapus akun). */
async function authAdmin(env, suffix, body) {
  const project = env.FIREBASE_PROJECT_ID;
  const emu = env.AUTH_EMULATOR_HOST;
  const base = emu
    ? `http://${emu}/identitytoolkit.googleapis.com/v1/projects/${project}`
    : `https://identitytoolkit.googleapis.com/v1/projects/${project}`;
  const token = await getAccessToken(env);
  const res = await fetch(base + suffix, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

// ---------- batas percobaan ----------

async function isBlocked(fs, keys) {
  const docs = await fs.batchGet(keys.map((k) => `checkinAttempts/${k.key}`));
  const now = Date.now();
  return docs.some(
    (d, i) =>
      d && now - d.data.windowStart < WINDOW_MS && d.data.count >= keys[i].limit,
  );
}

async function recordAttempt(fs, keys) {
  const now = Date.now();
  await Promise.all(
    keys.map((k) =>
      fs.transaction(async (tx) => {
        const path = `checkinAttempts/${k.key}`;
        const [doc] = await tx.getAll([path]);
        if (doc && now - doc.data.windowStart < WINDOW_MS) {
          tx.write(fs.updateWrite(path, { count: doc.data.count + 1 }, ['updatedAt']));
        } else {
          tx.write(fs.setWrite(path, { count: 1, windowStart: now }, ['updatedAt']));
        }
      }),
    ),
  );
}

async function checkinKeys(ip, memberId, memberKnown) {
  const keys = [
    { key: 'global', limit: LIMIT_GLOBAL },
    { key: `ip_${await sha(ip)}`, limit: LIMIT_PER_IP },
  ];
  // Hanya anggota yang benar-benar ada yang dihitung, supaya ID asal-asalan
  // tidak membuat dokumen penghitung baru tanpa batas.
  if (memberKnown) keys.push({ key: `m_${await sha(memberId)}`, limit: LIMIT_PER_MEMBER });
  return keys;
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'local';
}

// ---------- GET /api/info ----------

async function handleInfo(request, env) {
  if (request.method !== 'GET') {
    return fail(405, 'METHOD_NOT_ALLOWED', 'Metode tidak didukung.');
  }
  const now = Date.now();
  if (infoCache.data && now - infoCache.at < INFO_CACHE_MS) {
    return json(200, infoCache.data);
  }

  const fs = new Firestore(env);

  // Sesi yang punya minimal satu token aktif dan belum kedaluwarsa.
  const tokenDocs = await fs.query({
    from: [{ collectionId: 'checkinTokens' }],
    where: {
      fieldFilter: {
        field: { fieldPath: 'active' },
        op: 'EQUAL',
        value: { booleanValue: true },
      },
    },
  });
  const sessionIds = new Set();
  for (const d of tokenDocs) {
    if (effectiveExpiryMs(d.data) <= now) continue;
    const id = d.data.sessionId;
    if (typeof id === 'string' && ID_PATTERN.test(id)) sessionIds.add(id);
  }

  const sessions = [];
  if (sessionIds.size > 0) {
    const ids = [...sessionIds];
    const docs = await fs.batchGet(ids.map((id) => `attendanceSessions/${id}`));
    docs.forEach((d, i) => {
      if (!d) return;
      sessions.push({
        sessionId: ids[i],
        date: String(d.data.sessionDate || ''),
        name: String(d.data.sessionName || ''),
      });
    });
    sessions.sort((a, b) => b.date.localeCompare(a.date));
  }

  // Daftar nama hanya diberikan kalau ada sesi yang sedang dibuka.
  // Isinya hanya ID dan nama anggota aktif (tanpa jabatan atau data lain).
  let members = [];
  if (sessions.length > 0) {
    const mDocs = await fs.query({ from: [{ collectionId: 'members' }] });
    members = mDocs
      .filter((d) => d.data.isActive !== false)
      .map((d) => ({ id: d.id, name: String(d.data.name || '') }))
      .filter((m) => m.name)
      .sort((a, b) => a.name.localeCompare(b.name, 'id', { sensitivity: 'base' }));
  }

  const data = { sessions, members };
  infoCache = { at: now, data };
  return json(200, data);
}

// ---------- POST /api/checkin ----------

async function handleCheckin(request, env) {
  if (request.method !== 'POST') {
    return fail(405, 'METHOD_NOT_ALLOWED', 'Metode tidak didukung.');
  }

  const body = (await readJson(request)) || {};
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  const rawToken = typeof body.token === 'string' ? body.token : '';
  const tooLong = rawToken.length > TOKEN_RAW_MAX;
  const token = tooLong ? '' : normalizeToken(rawToken);

  if (!memberId) {
    return fail(400, 'NO_MEMBER', 'Silakan pilih nama anggota terlebih dahulu.');
  }
  if (!rawToken.trim()) {
    return fail(400, 'NO_TOKEN', 'Masukkan token terlebih dahulu.');
  }
  if (!sessionId) {
    return fail(400, 'NO_SESSION', 'Sesi absensi belum dipilih.');
  }
  if (!ID_PATTERN.test(memberId) || !ID_PATTERN.test(sessionId)) {
    return fail(400, 'BAD_REQUEST', 'Data yang dikirim tidak valid.');
  }

  const fs = new Firestore(env);
  const memberPre = await fs.get(`members/${memberId}`);
  const keys = await checkinKeys(clientIp(request), memberId, memberPre !== null);

  if (await isBlocked(fs, keys)) {
    return fail(
      429,
      'TOO_MANY_ATTEMPTS',
      'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.',
    );
  }

  if (tooLong || !TOKEN_PATTERN.test(token)) {
    await recordAttempt(fs, keys);
    return fail(404, 'TOKEN_INVALID', 'Token tidak ditemukan atau salah.');
  }

  try {
    // Seluruh pemeriksaan dan penulisan dalam satu transaksi, jadi
    // check-in ganda atau dua orang bersamaan tidak saling menimpa.
    const result = await fs.transaction(async (tx) => {
      const sessionPath = `attendanceSessions/${sessionId}`;
      const [tokenDoc, sessionDoc, memberDoc] = await tx.getAll([
        `checkinTokens/${tokenDocId(token)}`,
        sessionPath,
        `members/${memberId}`,
      ]);

      if (!tokenDoc || tokenDoc.data.sessionId !== sessionId) {
        throw new CheckinError('TOKEN_INVALID', 404, 'Token tidak ditemukan atau salah.', true);
      }
      const t = tokenDoc.data;
      if (t.active !== true) {
        throw new CheckinError('TOKEN_INACTIVE', 403, 'Token sudah tidak aktif.', true);
      }
      if (effectiveExpiryMs(t) <= Date.now()) {
        throw new CheckinError('TOKEN_EXPIRED', 403, 'Token sudah kedaluwarsa.', true);
      }
      if (!sessionDoc) {
        throw new CheckinError('SESSION_NOT_FOUND', 404, 'Sesi absensi tidak ditemukan.');
      }
      if (!memberDoc || memberDoc.data.isActive === false) {
        throw new CheckinError('MEMBER_INVALID', 403, 'Anggota tidak aktif atau tidak ditemukan.');
      }

      const member = memberDoc.data;
      const records = Array.isArray(sessionDoc.data.records)
        ? [...sessionDoc.data.records]
        : [];
      const idx = records.findIndex((r) => r && r.memberId === memberId);
      const nowTs = new Ts(new Date().toISOString());

      if (idx >= 0) {
        const r = records[idx];
        if (r.status === 'present') {
          throw new CheckinError('ALREADY_CHECKED_IN', 409, 'Nama ini sudah absen pada sesi ini.');
        }
        if (r.status === 'excused') {
          throw new CheckinError(
            'EXCUSED',
            409,
            'Statusmu sudah dicatat Izin oleh admin. Hubungi admin bila perlu.',
          );
        }
        // Alpha -> Hadir. Nama, kategori, dan jabatan di sesi tidak diubah.
        records[idx] = { ...r, status: 'present', source: 'web', checkedInAt: nowTs };
      } else {
        // Anggota baru yang belum tercatat di sesi ini: ditambahkan sebagai
        // Hadir, dengan kategori dan jabatan saat ini sebagai salinan.
        const category = member.category === 'admin' ? 'admin' : 'member';
        records.push({
          memberId,
          memberNameSnapshot: String(member.name || ''),
          status: 'present',
          category,
          position: category === 'admin' ? String(member.position || '') : '',
          source: 'web',
          checkedInAt: nowTs,
        });
      }

      const present = records.filter((r) => r.status === 'present').length;
      const excused = records.filter((r) => r.status === 'excused').length;
      tx.write(
        fs.updateWrite(
          sessionPath,
          {
            records,
            totalMembers: records.length,
            totalPresent: present,
            totalExcused: excused,
            totalAbsent: records.length - present - excused,
          },
          ['updatedAt'],
        ),
      );

      return { name: String(member.name || ''), checkedInAt: nowTs.iso };
    });

    // Pesan berhasil baru dikirim setelah transaksi benar-benar tersimpan.
    return json(200, {
      ok: true,
      message: 'Absensi berhasil disimpan. Terima kasih!',
      memberName: result.name,
      checkedInAt: result.checkedInAt,
    });
  } catch (e) {
    if (e instanceof CheckinError) {
      if (e.countsAsFailure) await recordAttempt(fs, keys);
      return fail(e.status, e.code, e.message);
    }
    throw e;
  }
}

// ---------- POST /api/register ----------
// Pendaftaran biasa: TANPA kode gabung dan TANPA token. Akun baru berstatus
// "pending" sampai disetujui admin di APK.

async function handleRegister(request, env) {
  if (request.method !== 'POST') {
    return fail(405, 'METHOD_NOT_ALLOWED', 'Metode tidak didukung.');
  }

  const body = (await readJson(request)) || {};
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const displayName =
    typeof body.displayName === 'string'
      ? body.displayName.trim().replace(/\s+/g, ' ')
      : '';

  const fs = new Firestore(env);
  const keys = [
    { key: 'reg_global', limit: REG_LIMIT_GLOBAL },
    { key: `reg_ip_${await sha(clientIp(request))}`, limit: REG_LIMIT_PER_IP },
  ];

  if (await isBlocked(fs, keys)) {
    return fail(
      429,
      'TOO_MANY_ATTEMPTS',
      'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.',
    );
  }
  // Semua percobaan dihitung (berhasil atau gagal), supaya pembuatan akun
  // tidak bisa dibanjiri.
  await recordAttempt(fs, keys);

  if (displayName.length < 2 || displayName.length > 40) {
    return fail(400, 'BAD_NAME', 'Nama harus 2 sampai 40 karakter.');
  }
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    return fail(400, 'BAD_EMAIL', 'Format email tidak valid.');
  }
  if (password.length < 8 || password.length > 64) {
    return fail(400, 'BAD_PASSWORD', 'Password harus 8 sampai 64 karakter.');
  }

  // Saklar buka/tutup pendaftaran (diatur admin di APK). Tanpa dokumen ini,
  // pendaftaran terbuka. Ini bukan kode, hanya penutup darurat dari spam.
  const cfg = await fs.get('config/registration');
  if (cfg && cfg.data.open === false) {
    return fail(403, 'REGISTRATION_CLOSED', 'Pendaftaran sedang ditutup. Hubungi admin.');
  }

  const created = await authAdmin(env, '/accounts', {
    email,
    password,
    displayName,
    emailVerified: false,
  });
  if (!created.ok) {
    const msg = String((created.data && created.data.error && created.data.error.message) || '');
    if (msg.includes('EMAIL_EXISTS')) {
      return fail(409, 'EMAIL_EXISTS', 'Email sudah terdaftar. Hubungi admin jika lupa password.');
    }
    if (msg.includes('INVALID_EMAIL')) {
      return fail(400, 'BAD_EMAIL', 'Format email tidak valid.');
    }
    if (msg.includes('WEAK_PASSWORD') || msg.includes('INVALID_PASSWORD')) {
      return fail(400, 'BAD_PASSWORD', 'Password harus 8 sampai 64 karakter.');
    }
    throw new Error('Pembuatan akun gagal (' + created.status + ')');
  }
  const uid = created.data && created.data.localId;
  if (!uid) throw new Error('Pembuatan akun tidak mengembalikan ID');

  // Peran dan status ditulis server. Pendaftar tidak bisa menentukan
  // perannya sendiri. Status awal: menunggu persetujuan admin.
  try {
    await fs.commit([
      fs.setWrite(
        `appUsers/${uid}`,
        { role: 'member', status: 'pending', displayName, email, source: 'web' },
        ['createdAt', 'updatedAt'],
        true,
      ),
    ]);
  } catch (e) {
    // Jangan tinggalkan akun tanpa dokumen peran.
    await authAdmin(env, '/accounts:delete', { localId: uid }).catch(() => {});
    throw e;
  }

  return json(200, {
    ok: true,
    message: 'Pendaftaran berhasil. Akunmu menunggu persetujuan admin.',
  });
}

// ---------- router ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/info') return await handleInfo(request, env);
      if (url.pathname === '/api/checkin') return await handleCheckin(request, env);
      if (url.pathname === '/api/register') return await handleRegister(request, env);
      if (url.pathname.startsWith('/api/')) {
        return fail(404, 'NOT_FOUND', 'Alamat tidak ditemukan.');
      }
      if (env.ASSETS) return await env.ASSETS.fetch(request);
      return new Response('Tidak ditemukan', { status: 404 });
    } catch (e) {
      // Token, password, dan alamat IP sengaja tidak dicatat di log.
      console.error('error', String((e && e.message) || e));
      return fail(500, 'SERVER_ERROR', MSG_SERVER);
    }
  },
};