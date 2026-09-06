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

// ── Edit these if you need to rename a different week ────────────
const OLD_KEY = "2026-W33";
const NEW_KEY = "2026-W32";

const snap = await getDoc(doc(db, "attendance", "att:business"));
if (!snap.exists()) {
  console.log("❌ att:business not found.");
  process.exit(0);
}

const business = snap.data().value || {};

if (!(OLD_KEY in business)) {
  console.log(`⚠️  Key "${OLD_KEY}" not found in att:business. Nothing to rename.`);
  console.log("Existing week keys:", Object.keys(business));
  process.exit(0);
}

if (NEW_KEY in business) {
  console.log(`⚠️  Key "${NEW_KEY}" already exists in att:business.`);
  console.log("Merging entries from both keys — new key's existing givers take priority on conflict.");
  business[NEW_KEY] = { ...business[OLD_KEY], ...business[NEW_KEY] };
} else {
  business[NEW_KEY] = business[OLD_KEY];
}

delete business[OLD_KEY];

await setDoc(doc(db, "attendance", "att:business"), { value: business });

console.log(`✅ Renamed "${OLD_KEY}" → "${NEW_KEY}" in att:business.`);
