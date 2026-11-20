import { initializeApp } from "firebase/app";
import { initializeFirestore, doc, getDoc } from "firebase/firestore";


//node node .\DB_Scripts\check-users.js

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
// Node.js scripts (unlike browsers) often can't use Firestore's default WebSocket
// streaming connection, which surfaces as a misleading "client is offline" error.
// Forcing long-polling makes it work reliably from the command line.
const db = initializeFirestore(app, { experimentalForceLongPolling: true });

const snap = await getDoc(doc(db, "attendance", "att:users"));
if (!snap.exists()) {
  console.log("❌ att:users document does not exist at all!");
  process.exit(0);
}

const users = snap.data().value || [];

if (users.length === 0) {
  console.log("🚨🚨🚨 ALERT: att:users is EMPTY (0 users)! 🚨🚨🚨");
  console.log("This is the exact symptom of the data-wipe bug — your user list is gone from the live database.");
  console.log("Restore immediately from your 'attendance2' backup using restore-users-now.js.");
  process.exit(1);
}

console.log(`✅ att:users has ${users.length} user(s). Looks healthy.\n`);

// Show every user matching "admin" in name (case-insensitive)
const admins = users.filter(u => u.name.toLowerCase().includes("admin"));
console.log(`Users matching "admin" (${admins.length}):`);
admins.forEach(u => console.log(`  id=${u.id}  slNo=${u.slNo}  name="${u.name}"  role=${u.role}  pin=${u.pin}`));

// Check for duplicate names
console.log("\n--- Duplicate name check ---");
const nameCount = {};
users.forEach(u => { nameCount[u.name] = (nameCount[u.name] || 0) + 1; });
const dupNames = Object.entries(nameCount).filter(([, c]) => c > 1);
if (dupNames.length) {
  dupNames.forEach(([name, count]) => console.log(`  ⚠️  "${name}" appears ${count} times`));
} else {
  console.log("  None found.");
}

// Check for duplicate ids
console.log("\n--- Duplicate id check ---");
const idCount = {};
users.forEach(u => { idCount[u.id] = (idCount[u.id] || 0) + 1; });
const dupIds = Object.entries(idCount).filter(([, c]) => c > 1);
if (dupIds.length) {
  dupIds.forEach(([id, count]) => console.log(`  ⚠️  id "${id}" appears ${count} times`));
} else {
  console.log("  None found.");
}

// Specifically show the exact u1 record
console.log("\n--- id === \"u1\" record ---");
const u1 = users.find(u => u.id === "u1");
console.log(u1 ? JSON.stringify(u1, null, 2) : "❌ No user with id 'u1' found!");

// Show anyone with the isSuperAdmin flag
console.log("\n--- Users with isSuperAdmin === true ---");
const superAdmins = users.filter(u => u.isSuperAdmin === true);
if (superAdmins.length) {
  superAdmins.forEach(u => console.log(`  id=${u.id}  name="${u.name}"`));
} else {
  console.log("  None found (relying on id === 'u1' fallback only).");
}
