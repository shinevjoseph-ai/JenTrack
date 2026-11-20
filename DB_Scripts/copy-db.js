import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc } from "firebase/firestore";

// ── SOURCE (Production) ──────────────────────────────────────────
const prodConfig = {
  apiKey: "AIzaSyB3AbNtUac5rHATF3W2glXIBsivBXwEThg",
  authDomain: "attendtrack-96e90.firebaseapp.com",
  projectId: "attendtrack-96e90",
  storageBucket: "attendtrack-96e90.firebasestorage.app",
  messagingSenderId: "175159103975",
  appId: "1:175159103975:web:ee0582dfa37730d2942d42"
};


// ── DESTINATION (QA) ─────────────────────────────────────────────
const qaConfig = {
  apiKey: "AIzaSyB3AbNtUac5rHATF3W2glXIBsivBXwEThg",
  authDomain: "attendtrack-96e90.firebaseapp.com",
  projectId: "attendtrack-96e90",
  storageBucket: "attendtrack-96e90.firebasestorage.app",
  messagingSenderId: "175159103975",
  appId: "1:175159103975:web:ee0582dfa37730d2942d42"
};

const prodApp = initializeApp(prodConfig, "prod");
const qaApp   = initializeApp(qaConfig,   "qa");
const prodDb  = getFirestore(prodApp);
const qaDb    = getFirestore(qaApp);


const SourceDB1 = "attendance";
const BakDB1 = "attendance2";
//const BakDB1 = "JENtrack-qa";

const KEYS = ["att:users", "att:records", "att:departments"];

  console.log("");
  console.log("🎉  >>  DB Backup Started from.. " + SourceDB1);
  console.log("");
for (const key of KEYS) {
  //const snap = await getDoc(doc(prodDb, "attendance", key));
  const snap = await getDoc(doc(prodDb, SourceDB1, key));
  if (snap.exists()) {
    await setDoc(doc(qaDb, BakDB1, key), snap.data());
    //await setDoc(doc(qaDb, "attendance2", key), snap.data());
    console.log(`✅ Copied table : ${key}`);
  } else {
    console.log(`⚠️  ${key} not found in prod — skipping`);
  }
}

console.log("");
console.log("  >>  From Database.. " + SourceDB1 +"  To >>  " + BakDB1);
console.log("");
console.log("🎉 Database copy complete!");