import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc } from "firebase/firestore";

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
const db  = getFirestore(app);
const COLLECTION = "attendance";

// Data is stored as { value: <raw array/object> } — no JSON stringify needed,
// this matches exactly how src/firebase.js load()/save() work in the app.
async function load(key) {
  const snap = await getDoc(doc(db, COLLECTION, key));
  return snap.exists() ? snap.data().value : null;
}
async function save(key, val) {
  await setDoc(doc(db, COLLECTION, key), { value: val });
}

console.log("🚀 Starting serial-number migration...\n");

// ── Step 1: Load current users ───────────────────────────────────
const users = await load("att:users");
if (!users) {
  console.log("❌ att:users not found. Nothing to migrate.");
  process.exit(0);
}

// ── Step 2: Assign serial numbers ────────────────────────────────
// Sort by current name (alphabetical) so slNo assignment feels natural,
// but keep the special "u1" (main admin) fixed as #1 if present.
const mainAdmin = users.find(u => u.id === "u1");
const rest = users.filter(u => u.id !== "u1").sort((a, b) => a.name.localeCompare(b.name));
const ordered = mainAdmin ? [mainAdmin, ...rest] : rest;

const idMap = {}; // oldId -> newId
const newUsers = ordered.map((u, i) => {
  const slNo = i + 1;
  const newId = "u" + slNo;
  idMap[u.id] = newId;
  return { ...u, id: newId, slNo };
});

console.log(`✅ Assigned serial numbers to ${newUsers.length} users.`);
console.log("   ID remap table:");
Object.entries(idMap).forEach(([oldId, newId]) => {
  if (oldId !== newId) console.log(`   ${oldId} → ${newId}`);
});

// ── Step 3: Remap att:records (week → { userId: true/false }) ───
const records = await load("att:records");
let newRecords = {};
if (records) {
  for (const week of Object.keys(records)) {
    newRecords[week] = {};
    for (const oldUserId of Object.keys(records[week])) {
      const newUserId = idMap[oldUserId] || oldUserId; // keep unknown ids as-is
      newRecords[week][newUserId] = records[week][oldUserId];
    }
  }
  console.log(`✅ Remapped att:records across ${Object.keys(newRecords).length} week(s).`);
} else {
  console.log("⚠️  att:records not found — skipped.");
}

// ── Step 4: Remap att:business (week → { giverId: {recipientId: amount} } or legacy array) ──
const business = await load("att:business");
let newBusiness = {};
if (business) {
  for (const week of Object.keys(business)) {
    newBusiness[week] = {};
    for (const oldGiverId of Object.keys(business[week])) {
      const newGiverId = idMap[oldGiverId] || oldGiverId;
      const raw = business[week][oldGiverId];

      if (Array.isArray(raw)) {
        // legacy array format: [{ to, amount }]
        newBusiness[week][newGiverId] = raw.map(e => ({
          to: idMap[e.to] || e.to,
          amount: e.amount,
        }));
      } else if (raw && typeof raw === "object" && "to" in raw && "amount" in raw && typeof raw.amount === "number") {
        // very old single-entry format: { to, amount }
        newBusiness[week][newGiverId] = {
          to: idMap[raw.to] || raw.to,
          amount: raw.amount,
        };
      } else if (raw && typeof raw === "object") {
        // current format: { recipientId: amount, ... }
        const remapped = {};
        for (const oldRecipientId of Object.keys(raw)) {
          const newRecipientId = idMap[oldRecipientId] || oldRecipientId;
          remapped[newRecipientId] = raw[oldRecipientId];
        }
        newBusiness[week][newGiverId] = remapped;
      }
    }
  }
  console.log(`✅ Remapped att:business across ${Object.keys(newBusiness).length} week(s).`);
} else {
  console.log("⚠️  att:business not found — skipped.");
}

// ── Step 5: Write everything back ────────────────────────────────
await save("att:users", newUsers);
await save("att:records", newRecords);
await save("att:business", newBusiness);

console.log("\n🎉 Migration complete! All users now have a stable serial number (slNo),");
console.log("   and every attendance/business record has been remapped to match.");
