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

const SOURCE_COLLECTION = "JENtrack-qa";
const DEST_COLLECTION   = "attendance";
const DOC_ID            = "att:users";

console.log(`🔍 Reading backup from "${SOURCE_COLLECTION}/${DOC_ID}"...\n`);

const backupSnap = await getDoc(doc(db, SOURCE_COLLECTION, DOC_ID));

if (!backupSnap.exists()) {
  console.log(`❌ Backup not found at "${SOURCE_COLLECTION}/${DOC_ID}". Nothing restored.`);
  process.exit(0);
}

const backupData = backupSnap.data();
const users = backupData.value || [];

console.log(`Found ${users.length} user(s) in the backup:\n`);
users.forEach(u => console.log(`  #${u.slNo ?? "—"}  id=${u.id}  ${u.name}  (${u.role})`));

// Also check what's currently live, before we overwrite it, just for the record.
const liveSnap = await getDoc(doc(db, DEST_COLLECTION, DOC_ID));
const liveCount = liveSnap.exists() && Array.isArray(liveSnap.data().value) ? liveSnap.data().value.length : 0;
console.log(`\nCurrently live "${DEST_COLLECTION}/${DOC_ID}" has ${liveCount} user(s) before this restore.`);

console.log(`\n🚀 Restoring backup into "${DEST_COLLECTION}/${DOC_ID}"...`);
await setDoc(doc(db, DEST_COLLECTION, DOC_ID), backupData);

console.log(`\n✅ Restore complete! ${users.length} user(s) written to "${DEST_COLLECTION}/${DOC_ID}".`);
console.log(`   Since att:records and att:business were untouched, all historical attendance`);
console.log(`   and contribution data should now correctly reconnect to these restored users.`);
