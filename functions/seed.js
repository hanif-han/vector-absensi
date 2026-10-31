"use strict";

const { initializeApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");

// Pengaman: skrip ini TIDAK boleh menulis ke database asli.
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error(
    "DIHENTIKAN: FIRESTORE_EMULATOR_HOST belum diisi.\n" +
      'Jalankan dulu: $env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080"',
  );
  process.exit(1);
}

initializeApp({ projectId: process.env.GCLOUD_PROJECT || "demo-absensi-squad" });
const db = getFirestore();

function isoToday() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Sama persis dengan tokenDocId di index.js dan docId di APK. */
function tokenDocId(token) {
  return `t_${Buffer.from(token, "utf8").toString("base64url")}`;
}

function person(name, category, position, isActive) {
  return {
    name,
    nameLowercase: name.toLowerCase(),
    isActive,
    category,
    position,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  };
}

function record(memberId, name, status, category, position) {
  return {
    memberId,
    memberNameSnapshot: name,
    status,
    category,
    position,
  };
}

async function main() {
  const batch = db.batch();

  // Anggota
  const members = {
    m_andi: person("Andi Rahmawan", "member", "", true),
    m_budi: person("Budi Santoso", "member", "", true),
    m_citra: person("Citra Dewi", "member", "", true),
    m_dewi: person("Dewi Lestari", "admin", "Leader", true),
    m_eko: person("Eko Prasetyo", "member", "", false), // nonaktif
    m_fajar: person("Fajar Nugroho", "member", "", true), // belum ada di sesi
  };
  for (const [id, data] of Object.entries(members)) {
    batch.set(db.collection("members").doc(id), data);
  }

  // Sesi (Fajar sengaja tidak ada di daftar catatan)
  const records = [
    record("m_andi", "Andi Rahmawan", "absent", "member", ""),
    record("m_budi", "Budi Santoso", "present", "member", ""),
    record("m_citra", "Citra Dewi", "excused", "member", ""),
    record("m_dewi", "Dewi Lestari", "absent", "admin", "Leader"),
    record("m_eko", "Eko Prasetyo", "absent", "member", ""),
  ];
  batch.set(db.collection("attendanceSessions").doc("sesi_uji"), {
    sessionDate: isoToday(),
    totalMembers: 5,
    totalPresent: 1,
    totalExcused: 1,
    totalAbsent: 3,
    records,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });

  // Token (disimpan dalam bentuk yang sudah dirapikan: huruf besar)
  const hour = 60 * 60 * 1000;
  const now = Date.now();
  const tokens = [
    { token: "ABC234", active: true, created: now, expires: now + hour },
    { token: "HADIR #1 OK!", active: true, created: now, expires: now + hour },
    { token: "EXPIRD", active: true, created: now - 2 * hour, expires: now - hour },
    { token: "OFFTKN", active: false, created: now, expires: now + hour },
    // Waktu kedaluwarsa di dokumen sengaja 10 jam ke depan, tetapi token dibuat
    // 2 jam lalu: batas 1 jam sejak dibuat tetap berlaku (harus ditolak).
    { token: "LAMA99", active: true, created: now - 2 * hour, expires: now + 10 * hour },
  ];
  for (const t of tokens) {
    batch.set(db.collection("checkinTokens").doc(tokenDocId(t.token)), {
      token: t.token,
      sessionId: "sesi_uji",
      sessionDate: isoToday(),
      active: t.active,
      source: "auto",
      expiresAt: Timestamp.fromMillis(t.expires),
      createdBy: "seed",
      createdAt: Timestamp.fromMillis(t.created),
    });
  }

  await batch.commit();
  console.log("Data contoh dibuat di emulator.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});