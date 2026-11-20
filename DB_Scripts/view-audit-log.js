import { initializeApp } from "firebase/app";
import { initializeFirestore, doc, getDoc } from "firebase/firestore";

// ── Your Firebase config ─────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyB3AbNtUac5rHATF3W2glXIBsivBXwEThg",
  authDomain: "attendtrack-96e90.firebaseapp.com",
  projectId: "attendtrack-96e90",
  storageBucket: "attendtrack-96e90.firebasestorage.app",
  messagingSenderId: "175159103975",
  appId: "1:175159103975:web:ee0582dfa37730d2942d42"
};

const app = initializeApp(firebaseConfig);
const db  = initializeFirestore(app, { experimentalForceLongPolling: true });

const snap = await getDoc(doc(db, "attendance", "att:userauditlog"));

if (!snap.exists()) {
  console.log("No audit log found yet — either nothing has written to att:users since this");
  console.log("feature was deployed, or the log document hasn't been created yet.");
  process.exit(0);
}

const log = snap.data().value || [];

if (log.length === 0) {
  console.log("Audit log exists but is empty.");
  process.exit(0);
}

console.log(`📋 Found ${log.length} entries (showing most recent first)\n`);

[...log].reverse().forEach(entry => {
  const marker = entry.event === "blocked" ? "🚫 BLOCKED" : "✅ write";
  const dropWarning = entry.beforeCount > entry.afterCount + 1 ? "  ⚠️ SUSPICIOUS DROP" : "";
  console.log(`${entry.ts}  ${marker}  by: ${entry.actorName} (${entry.actorId})`);
  console.log(`   ${entry.beforeCount} → ${entry.afterCount} users${dropWarning}`);
  if (entry.url) console.log(`   from: ${entry.url}`);
  console.log("");
});

console.log("=== Summary ===");
const blocked = log.filter(e => e.event === "blocked");
console.log(`Total writes: ${log.length}`);
console.log(`Blocked attempts: ${blocked.length}`);
if (blocked.length > 0) {
  console.log("\n⚠️  Blocked attempts were caught before any damage — but look at who/what triggered them above.");
}
