const PROJECT = "absensi-squad";
const ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
let cachedToken = null;
let tokenExpiry = 0;
let infoCache = null;
let infoCacheAt = 0;

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function decode(v) {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("timestampValue" in v) return new Date(v.timestampValue);
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decode);
  if ("mapValue" in v) return fields(v.mapValue.fields || {});
  return null;
}

function fields(f) {
  const result = {};
  for (const [k, v] of Object.entries(f || {})) result[k] = decode(v);
  return result;
}

function encode(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v)
    ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  return { mapValue: { fields: Object.fromEntries(
    Object.entries(v).map(([k, x]) => [k, encode(x)])
  ) } };
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function googleToken(env) {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;

  
  const now = Math.floor(Date.now() / 1000);
  const secret = env.GCP_SERVICE_ACCOUNT_JSON_B64.trim();
let accountText;

if (secret.startsWith("{")) {
  accountText = secret;
} else {
  const raw = atob(secret);
  const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
  accountText = new TextDecoder().decode(bytes);
}

const account = JSON.parse(accountText);
  const header = b64url(new TextEncoder().encode(JSON.stringify({
    alg: "RS256", typ: "JWT"
  })));
  const claim = b64url(new TextEncoder().encode(JSON.stringify({
   
    scope: "https://www.googleapis.com/auth/datastore",
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  })));
 
  const keyBytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", keyBytes, {
    name: "RSASSA-PKCS1-v1_5", hash: "SHA-256"
  }, false, ["sign"]);
  const unsigned = `${header}.${claim}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)
  );
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${b64url(new Uint8Array(sig))}`
    })
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error("Google OAuth gagal");
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

async function fs(env, path, options = {}) {
  const access = await googleToken(env);
  const response = await fetch(`${ROOT}/${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${access}`,
      ...(options.body ? { "content-type": "application/json" } : {})
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(data?.error?.message || "Firestore error");
    error.status = response.status;
    throw error;
  }
  return data;
}

async function getDoc(env, collection, id) {
  try {
    const d = await fs(env, `${collection}/${encodeURIComponent(id)}`);
    return { id, data: fields(d.fields), name: d.name };
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function listDocs(env, collection) {
  const result = await fs(env, `${collection}?pageSize=1000`);
  return (result.documents || []).map(d => ({
    id: d.name.split("/").pop(), data: fields(d.fields)
  }));
}

function tokenId(token) {
  const bytes = new TextEncoder().encode(token);
  return "t_" + b64url(bytes);
}

function expiry(data) {
  const times = [];
  if (data.expiresAt instanceof Date) times.push(data.expiresAt.getTime());
  if (data.createdAt instanceof Date) times.push(data.createdAt.getTime() + 3600000);
  return times.length ? Math.min(...times) : 0;
}

async function info(env) {
  if (infoCache && Date.now() - infoCacheAt < 15000) return infoCache;
  const tokens = await listDocs(env, "checkinTokens");
  const ids = new Set(tokens.filter(t =>
    t.data.active === true && expiry(t.data) > Date.now()
  ).map(t => t.data.sessionId).filter(Boolean));

  const sessions = [];
  for (const id of ids) {
    const s = await getDoc(env, "attendanceSessions", id);
    if (s) sessions.push({
      sessionId: id,
      date: s.data.sessionDate || "",
      name: s.data.sessionName || ""
    });
  }
  sessions.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  let members = [];
  if (sessions.length) {
    members = (await listDocs(env, "members"))
      .filter(m => m.data.isActive !== false && m.data.name)
      .map(m => ({ id: m.id, name: String(m.data.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, "id", { sensitivity: "base" }));
  }
  infoCache = { sessions, members };
  infoCacheAt = Date.now();
  return infoCache;
}

async function checkin(request, env) {
  const body = await request.json().catch(() => ({}));
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const memberId = typeof body.memberId === "string" ? body.memberId.trim() : "";
  const raw = typeof body.token === "string" ? body.token : "";
  const token = raw.replace(/\s+/g, " ").trim().toUpperCase();

  if (!memberId) return json(400, { ok: false, code: "NO_MEMBER", message: "Pilih nama anggota dahulu." });
  if (!raw.trim()) return json(400, { ok: false, code: "NO_TOKEN", message: "Masukkan token." });
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(memberId) ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(sessionId) ||
      raw.length > 300 || !/^[\x20-\x7E]{1,100}$/.test(token)) {
    return json(400, { ok: false, code: "BAD_REQUEST", message: "Data tidak valid." });
  }

  const t = await getDoc(env, "checkinTokens", tokenId(token));
  if (!t || t.data.sessionId !== sessionId)
    return json(404, { ok: false, code: "TOKEN_INVALID", message: "Token salah atau tidak ditemukan." });
  if (t.data.active !== true)
    return json(403, { ok: false, code: "TOKEN_INACTIVE", message: "Token tidak aktif." });
  if (expiry(t.data) <= Date.now())
    return json(403, { ok: false, code: "TOKEN_EXPIRED", message: "Token kedaluwarsa." });

  const member = await getDoc(env, "members", memberId);
  const session = await getDoc(env, "attendanceSessions", sessionId);
  if (!session) return json(404, { ok: false, code: "SESSION_NOT_FOUND", message: "Sesi tidak ditemukan." });
  if (!member || member.data.isActive === false)
    return json(403, { ok: false, code: "MEMBER_INVALID", message: "Anggota tidak aktif." });

  // Jangan menulis ke sesi secara langsung tanpa transaksi.
  // Transaksi diperlukan agar absensi bersamaan tidak menimpa data.
  return json(503, {
    ok: false,
    code: "CHECKIN_TRANSACTION_NOT_READY",
    message: "Pemeriksaan berhasil, tetapi penyimpanan absensi belum diaktifkan."
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      if (url.pathname === "/api/info" && request.method === "GET")
        return json(200, await info(env));
      if (url.pathname === "/api/checkin" && request.method === "POST")
        return await checkin(request, env);
      return json(404, { ok: false, code: "NOT_FOUND", message: "Endpoint tidak ditemukan." });
    } catch (e) {
      console.error("API error", String(e.message || e).slice(0, 200));
      return json(500, { ok: false, code: "SERVER_ERROR", message: "Gangguan koneksi. Coba lagi." });
    }
  }
};


