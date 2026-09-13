import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc } from "firebase/firestore";

// ── SOURCE (copy FROM this project) ──────────────────────────────
const sourceConfig = {
  apiKey: "AIzaSyB3AbNtUac5rHATF3W2glXIBsivBXwEThg",
  authDomain: "attendtrack-96e90.firebaseapp.com",
  projectId: "attendtrack-96e90",
  storageBucket: "attendtrack-96e90.firebasestorage.app",
  messagingSenderId: "175159103975",
  appId: "1:175159103975:web:ee0582dfa37730d2942d42"
};

// ── DESTINATION (copy TO this project) ───────────────────────────
const destConfig = {
  apiKey: "AIzaSyB3AbNtUac5rHATF3W2glXIBsivBXwEThg",
  authDomain: "attendtrack-96e90.firebaseapp.com",
  projectId: "attendtrack-96e90",
  storageBucket: "attendtrack-96e90.firebasestorage.app",
  messagingSenderId: "175159103975",
  appId: "1:175159103975:web:ee0582dfa37730d2942d42"
};

const sourceApp = initializeApp(sourceConfig, "source");
const destApp   = initializeApp(destConfig,   "dest");
const sourceDb  = getFirestore(sourceApp);
const destDb    = getFirestore(destApp);

// ── Collection + document keys to copy ───────────────────────────
// Update this if your collection name or document keys are different
const srcCOLLECTION = "attendance";
const destCOLLECTION = "JENtrack-qa";

const DOC_KEYS = [
  "att:users",
  "att:records",
  "att:departments",
  "att:meetingweeks",
  "att:business",
];

console.log(`🚀 Copying all tables from "${sourceConfig.projectId}" → "${destConfig.projectId}"...\n`);

let copied = 0;
let skipped = 0;

for (const key of DOC_KEYS) {
  try {
    const snap = await getDoc(doc(sourceDb, srcCOLLECTION, key));
    if (snap.exists()) {
      await setDoc(doc(destDb, destCOLLECTION, key), snap.data());
      console.log(`✅ Copied "${key}"`);
      copied++;
    } else {
      console.log(`⚠️  "${key}" not found in source — skipped`);
      skipped++;
    }
  } catch (err) {
    console.log(`❌ Error copying "${key}":`, err.message);
  }
}

console.log(`\n🎉 Done! ${copied} table(s) copied, ${skipped} skipped (not found).`);
