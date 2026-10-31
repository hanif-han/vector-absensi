"use strict";

const crypto = require("node:crypto");
const { initializeApp } = require("firebase-admin/app");
const {
  getFirestore,
  Timestamp,
  FieldValue,
} = require("firebase-admin/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");

initializeApp();
const db = getFirestore();

// Wilayah yang sama dengan Firestore (Jakarta).
setGlobalOptions({ region: "asia-southeast2", maxInstances: 5 });

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Token: huruf, angka, simbol, dan spasi (ASCII yang bisa dicetak), 1-100 karakter.
const TOKEN_PATTERN = /^[\x20-\x7E]{1,100}$/;
const TOKEN_RAW_MAX = 300;

// Token hanya berlaku 1 jam sejak dibuat. Batas ini tetap berlaku walau waktu
// kedaluwarsa di dokumen token tertulis lebih lama.
const TOKEN_MAX_AGE_MS = 60 * 60 * 1000;

// Batas percobaan token yang gagal dalam satu jendela waktu.
const WINDOW_MS = 10 * 60 * 1000;
const LIMIT_PER_MEMBER = 5;
const LIMIT_PER_IP = 15;
const LIMIT_GLOBAL = 100;

// Daftar nama dan sesi disimpan sebentar di memori supaya hemat pembacaan.
const INFO_CACHE_MS = 15 * 1000;
let infoCache = { at: 0, data: null };

// Hanya berlaku di emulator: halaman uji lokal (dev-server.js, port 5500).
const DEV_ORIGINS = new Set(["http://127.0.0.1:5500", "http://localhost:5500"]);

/** Kesalahan yang diketahui: kode, status HTTP, dan pesan untuk anggota. */
class CheckinError extends Error {
  constructor(code, status, message, countsAsFailure = false) {
    super(message);
    this.code = code;
    this.status = status;
    this.countsAsFailure = countsAsFailure;
  }
}

function sendJson(res, status, body) {
  res.set("Cache-Control", "no-store");
  res.status(status).json(body);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { ok: false, code, message });
}

/**
 * CORS hanya diaktifkan di emulator (untuk halaman uji lokal). Di produksi
 * website dan fungsi satu alamat (lewat Hosting), jadi CORS tidak dibutuhkan.
 * Mengembalikan true jika permintaan sudah dijawab (OPTIONS).
 */
function devCors(req, res) {
  if (process.env.FUNCTIONS_EMULATOR !== "true") return false;
  const origin = req.headers.origin;
  if (origin && DEV_ORIGINS.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return true;
  }
  return false;
}

function sha(text) {
  return crypto
    .createHash("sha256")
    .update(String(text))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Alamat klien, sebaik mungkin. Header ini bisa dipalsukan jika fungsi
 * dipanggil langsung, jadi pembatas per-IP hanya pelengkap. Pembatas
 * per-anggota dan global tidak bergantung pada IP.
 */
function clientIp(req) {
  const fastly = req.headers["fastly-client-ip"];
  if (typeof fastly === "string" && fastly) return fastly.trim();
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
  return req.ip || "unknown";
}

// ---------- token ----------

/** Rapikan token: spasi ganda jadi satu, spasi tepi dibuang, huruf besar. */
function normalizeToken(raw) {
  return String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/** ID dokumen dari token. Sama persis dengan yang dihitung APK. */
function tokenDocId(token) {
  return `t_${Buffer.from(token, "utf8").toString("base64url")}`;
}

/** Waktu kedaluwarsa efektif (ms): paling lama 1 jam sejak token dibuat. */
function effectiveExpiryMs(t) {
  const candidates = [];
  if (t.expiresAt && typeof t.expiresAt.toMillis === "function") {
    candidates.push(t.expiresAt.toMillis());
  }
  if (t.createdAt && typeof t.createdAt.toMillis === "function") {
    candidates.push(t.createdAt.toMillis() + TOKEN_MAX_AGE_MS);
  }
  // Tanpa waktu sama sekali: dianggap sudah kedaluwarsa.
  return candidates.length > 0 ? Math.min(...candidates) : 0;
}

// ---------- batas percobaan ----------

function attemptRef(key) {
  return db.collection("checkinAttempts").doc(key);
}

function limitKeys(ip, memberId, memberKnown) {
  const keys = [
    { key: "global", limit: LIMIT_GLOBAL },
    { key: `ip_${sha(ip)}`, limit: LIMIT_PER_IP },
  ];
  // Hanya anggota yang benar-benar ada yang dihitung, supaya ID asal-asalan
  // tidak membuat dokumen penghitung baru tanpa batas.
  if (memberKnown) {
    keys.push({ key: `m_${sha(memberId)}`, limit: LIMIT_PER_MEMBER });
  }
  return keys;
}

async function isBlocked(keys) {
  const now = Date.now();
  const snaps = await Promise.all(keys.map((k) => attemptRef(k.key).get()));
  return snaps.some((snap, i) => {
    if (!snap.exists) return false;
    const d = snap.data();
    return now - d.windowStart < WINDOW_MS && d.count >= keys[i].limit;
  });
}

async function recordFailure(keys) {
  const now = Date.now();
  await Promise.all(
    keys.map((k) =>
      db.runTransaction(async (tx) => {
        const ref = attemptRef(k.key);
        const snap = await tx.get(ref);
        const d = snap.exists ? snap.data() : null;
        if (d && now - d.windowStart < WINDOW_MS) {
          tx.update(ref, {
            count: d.count + 1,
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
          tx.set(ref, {
            count: 1,
            windowStart: now,
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
      }),
    ),
  );
}

// ---------- GET /api/info ----------

exports.info = onRequest(async (req, res) => {
  if (devCors(req, res)) return;
  if (req.method !== "GET") {
    return sendError(res, 405, "METHOD_NOT_ALLOWED", "Metode tidak didukung.");
  }
  try {
    const now = Date.now();
    if (infoCache.data && now - infoCache.at < INFO_CACHE_MS) {
      return sendJson(res, 200, infoCache.data);
    }

    // Sesi yang punya minimal satu token aktif dan belum kedaluwarsa.
    const tokenSnap = await db
      .collection("checkinTokens")
      .where("active", "==", true)
      .get();
    const sessionIds = new Set();
    tokenSnap.forEach((doc) => {
      const t = doc.data();
      if (effectiveExpiryMs(t) <= now) return;
      if (t.sessionId) sessionIds.add(t.sessionId);
    });

    const sessions = [];
    if (sessionIds.size > 0) {
      const refs = [...sessionIds].map((id) =>
        db.collection("attendanceSessions").doc(id),
      );
      const snaps = await db.getAll(...refs);
      for (const s of snaps) {
        if (!s.exists) continue;
        const d = s.data();
        sessions.push({
          sessionId: s.id,
          date: d.sessionDate || "",
          name: d.sessionName || "",
        });
      }
      sessions.sort((a, b) => b.date.localeCompare(a.date));
    }

    // Daftar nama hanya diberikan kalau ada sesi yang sedang dibuka.
    // Isinya hanya ID dan nama anggota aktif (tanpa jabatan atau data lain).
    let members = [];
    if (sessions.length > 0) {
      const mSnap = await db.collection("members").get();
      members = mSnap.docs
        .filter((d) => d.data().isActive !== false)
        .map((d) => ({ id: d.id, name: String(d.data().name || "") }))
        .filter((m) => m.name)
        .sort((a, b) =>
          a.name.localeCompare(b.name, "id", { sensitivity: "base" }),
        );
    }

    const data = { sessions, members };
    infoCache = { at: now, data };
    return sendJson(res, 200, data);
  } catch (e) {
    logger.error("info gagal", { error: String((e && e.message) || e) });
    return sendError(
      res,
      500,
      "SERVER_ERROR",
      "Terjadi gangguan koneksi, silakan coba kembali.",
    );
  }
});

// ---------- POST /api/checkin ----------

exports.checkin = onRequest(async (req, res) => {
  if (devCors(req, res)) return;
  if (req.method !== "POST") {
    return sendError(res, 405, "METHOD_NOT_ALLOWED", "Metode tidak didukung.");
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const sessionId =
    typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const memberId =
    typeof body.memberId === "string" ? body.memberId.trim() : "";
  const rawToken = typeof body.token === "string" ? body.token : "";
  const tooLong = rawToken.length > TOKEN_RAW_MAX;
  const token = tooLong ? "" : normalizeToken(rawToken);

  if (!memberId) {
    return sendError(
      res,
      400,
      "NO_MEMBER",
      "Silakan pilih nama anggota terlebih dahulu.",
    );
  }
  if (!rawToken.trim()) {
    return sendError(res, 400, "NO_TOKEN", "Masukkan token terlebih dahulu.");
  }
  if (!sessionId) {
    return sendError(res, 400, "NO_SESSION", "Sesi absensi belum dipilih.");
  }
  if (!ID_PATTERN.test(memberId) || !ID_PATTERN.test(sessionId)) {
    return sendError(res, 400, "BAD_REQUEST", "Data yang dikirim tidak valid.");
  }

  const ip = clientIp(req);

  try {
    const memberPre = await db.collection("members").doc(memberId).get();
    const keys = limitKeys(ip, memberId, memberPre.exists);

    if (await isBlocked(keys)) {
      return sendError(
        res,
        429,
        "TOO_MANY_ATTEMPTS",
        "Terlalu banyak percobaan. Coba lagi beberapa menit lagi.",
      );
    }

    if (tooLong || !TOKEN_PATTERN.test(token)) {
      await recordFailure(keys);
      return sendError(
        res,
        404,
        "TOKEN_INVALID",
        "Token tidak ditemukan atau salah.",
      );
    }

    try {
      // Seluruh pemeriksaan dan penulisan dalam satu transaksi, jadi
      // check-in ganda atau dua orang bersamaan tidak saling menimpa.
      const result = await db.runTransaction(async (tx) => {
        const tokenRef = db.collection("checkinTokens").doc(tokenDocId(token));
        const sessionRef = db.collection("attendanceSessions").doc(sessionId);
        const memberRef = db.collection("members").doc(memberId);
        const [tokenSnap, sessionSnap, memberSnap] = await Promise.all([
          tx.get(tokenRef),
          tx.get(sessionRef),
          tx.get(memberRef),
        ]);

        if (!tokenSnap.exists) {
          throw new CheckinError(
            "TOKEN_INVALID",
            404,
            "Token tidak ditemukan atau salah.",
            true,
          );
        }
        const t = tokenSnap.data();
        if (t.sessionId !== sessionId) {
          throw new CheckinError(
            "TOKEN_INVALID",
            404,
            "Token tidak ditemukan atau salah.",
            true,
          );
        }
        if (t.active !== true) {
          throw new CheckinError(
            "TOKEN_INACTIVE",
            403,
            "Token sudah tidak aktif.",
            true,
          );
        }
        if (effectiveExpiryMs(t) <= Date.now()) {
          throw new CheckinError(
            "TOKEN_EXPIRED",
            403,
            "Token sudah kedaluwarsa.",
            true,
          );
        }
        if (!sessionSnap.exists) {
          throw new CheckinError(
            "SESSION_NOT_FOUND",
            404,
            "Sesi absensi tidak ditemukan.",
          );
        }
        if (!memberSnap.exists || memberSnap.data().isActive === false) {
          throw new CheckinError(
            "MEMBER_INVALID",
            403,
            "Anggota tidak aktif atau tidak ditemukan.",
          );
        }

        const member = memberSnap.data();
        const session = sessionSnap.data();
        const records = Array.isArray(session.records)
          ? [...session.records]
          : [];
        const idx = records.findIndex((r) => r && r.memberId === memberId);
        const now = Timestamp.now();

        if (idx >= 0) {
          const r = records[idx];
          if (r.status === "present") {
            throw new CheckinError(
              "ALREADY_CHECKED_IN",
              409,
              "Nama ini sudah absen pada sesi ini.",
            );
          }
          if (r.status === "excused") {
            throw new CheckinError(
              "EXCUSED",
              409,
              "Statusmu sudah dicatat Izin oleh admin. Hubungi admin bila perlu.",
            );
          }
          // Alpha -> Hadir. Nama, kategori, dan jabatan di sesi tidak diubah.
          records[idx] = {
            ...r,
            status: "present",
            source: "web",
            checkedInAt: now,
          };
        } else {
          // Anggota baru yang belum tercatat di sesi ini: ditambahkan sebagai
          // Hadir, dengan kategori dan jabatan saat ini sebagai salinan.
          const category = member.category === "admin" ? "admin" : "member";
          records.push({
            memberId,
            memberNameSnapshot: String(member.name || ""),
            status: "present",
            category,
            position: category === "admin" ? String(member.position || "") : "",
            source: "web",
            checkedInAt: now,
          });
        }

        const present = records.filter((r) => r.status === "present").length;
        const excused = records.filter((r) => r.status === "excused").length;
        tx.update(sessionRef, {
          records,
          totalMembers: records.length,
          totalPresent: present,
          totalExcused: excused,
          totalAbsent: records.length - present - excused,
          updatedAt: FieldValue.serverTimestamp(),
        });

        return {
          name: String(member.name || ""),
          checkedInAt: now.toDate().toISOString(),
        };
      });

      // Pesan berhasil baru dikirim setelah transaksi benar-benar tersimpan.
      return sendJson(res, 200, {
        ok: true,
        message: "Absensi berhasil disimpan. Terima kasih!",
        memberName: result.name,
        checkedInAt: result.checkedInAt,
      });
    } catch (e) {
      if (e instanceof CheckinError) {
        if (e.countsAsFailure) await recordFailure(keys);
        return sendError(res, e.status, e.code, e.message);
      }
      throw e;
    }
  } catch (e) {
    // Token dan alamat IP sengaja tidak dicatat di log.
    logger.error("checkin gagal", { error: String((e && e.message) || e) });
    return sendError(
      res,
      500,
      "SERVER_ERROR",
      "Terjadi gangguan koneksi, silakan coba kembali.",
    );
  }
});
exports.register = require('./register').register;
