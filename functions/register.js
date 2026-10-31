"use strict";

const crypto = require("node:crypto");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");

// Batas percobaan pendaftaran dalam satu jendela waktu. SEMUA percobaan
// dihitung (berhasil atau gagal), supaya pembuatan akun tidak bisa dibanjiri.
const WINDOW_MS = 10 * 60 * 1000;
const LIMIT_PER_IP = 10;
const LIMIT_GLOBAL = 200;

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

// Hanya berlaku di emulator: halaman uji lokal (dev-server.js, port 5500).
const DEV_ORIGINS = new Set(["http://127.0.0.1:5500", "http://localhost:5500"]);

function sendJson(res, status, body) {
  res.set("Cache-Control", "no-store");
  res.status(status).json(body);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { ok: false, code, message });
}

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

/** Alamat klien sebaik mungkin (bisa dipalsukan jika fungsi dipanggil langsung). */
function clientIp(req) {
  const fastly = req.headers["fastly-client-ip"];
  if (typeof fastly === "string" && fastly) return fastly.trim();
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
  return req.ip || "unknown";
}

function attemptRef(key) {
  return getFirestore().collection("checkinAttempts").doc(key);
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

async function recordAttempt(keys) {
  const now = Date.now();
  await Promise.all(
    keys.map((k) =>
      getFirestore().runTransaction(async (tx) => {
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

// ---------- POST /api/register ----------
// Pendaftaran biasa: TANPA kode gabung dan TANPA token. Akun baru berstatus
// "pending" sampai disetujui admin di APK.

exports.register = onRequest(async (req, res) => {
  if (devCors(req, res)) return;
  if (req.method !== "POST") {
    return sendError(res, 405, "METHOD_NOT_ALLOWED", "Metode tidak didukung.");
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const displayName =
    typeof body.displayName === "string"
      ? body.displayName.trim().replace(/\s+/g, " ")
      : "";

  const keys = [
    { key: "reg_global", limit: LIMIT_GLOBAL },
    { key: `reg_ip_${sha(clientIp(req))}`, limit: LIMIT_PER_IP },
  ];

  try {
    if (await isBlocked(keys)) {
      return sendError(
        res,
        429,
        "TOO_MANY_ATTEMPTS",
        "Terlalu banyak percobaan. Coba lagi beberapa menit lagi.",
      );
    }
    await recordAttempt(keys);

    if (displayName.length < 2 || displayName.length > 40) {
      return sendError(
        res,
        400,
        "BAD_NAME",
        "Nama harus 2 sampai 40 karakter.",
      );
    }
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
      return sendError(res, 400, "BAD_EMAIL", "Format email tidak valid.");
    }
    if (password.length < 8 || password.length > 64) {
      return sendError(
        res,
        400,
        "BAD_PASSWORD",
        "Password harus 8 sampai 64 karakter.",
      );
    }

    // Saklar buka/tutup pendaftaran (diatur admin di APK). Tanpa dokumen ini,
    // pendaftaran terbuka. Ini bukan kode, hanya penutup darurat dari spam.
    const db = getFirestore();
    const cfg = await db.collection("config").doc("registration").get();
    if (cfg.exists && cfg.data().open === false) {
      return sendError(
        res,
        403,
        "REGISTRATION_CLOSED",
        "Pendaftaran sedang ditutup. Hubungi admin.",
      );
    }

    let user;
    try {
      user = await getAuth().createUser({
        email,
        password,
        displayName,
        emailVerified: false,
      });
    } catch (e) {
      if (e && e.code === "auth/email-already-exists") {
        return sendError(
          res,
          409,
          "EMAIL_EXISTS",
          "Email sudah terdaftar. Hubungi admin jika lupa password.",
        );
      }
      if (e && e.code === "auth/invalid-email") {
        return sendError(res, 400, "BAD_EMAIL", "Format email tidak valid.");
      }
      if (e && e.code === "auth/invalid-password") {
        return sendError(
          res,
          400,
          "BAD_PASSWORD",
          "Password harus 8 sampai 64 karakter.",
        );
      }
      throw e;
    }

    // Peran dan status ditulis server. Pendaftar tidak bisa menentukan
    // perannya sendiri. Status awal: menunggu persetujuan admin.
    try {
      await db.collection("appUsers").doc(user.uid).set({
        role: "member",
        status: "pending",
        displayName,
        email,
        source: "web",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      // Jangan tinggalkan akun tanpa dokumen peran.
      await getAuth()
        .deleteUser(user.uid)
        .catch(() => {});
      throw e;
    }

    return sendJson(res, 200, {
      ok: true,
      message: "Pendaftaran berhasil. Akunmu menunggu persetujuan admin.",
    });
  } catch (e) {
    // Password dan alamat IP sengaja tidak dicatat di log.
    logger.error("register gagal", { error: String((e && e.message) || e) });
    return sendError(
      res,
      500,
      "SERVER_ERROR",
      "Terjadi gangguan koneksi, silakan coba kembali.",
    );
  }
});