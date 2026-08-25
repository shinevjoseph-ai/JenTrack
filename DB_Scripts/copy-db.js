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

const KEYS = ["att:users", "att:records", "att:departments"];

for (const key of KEYS) {
  //const snap = await getDoc(doc(prodDb, "attendance", key));
  const snap = await getDoc(doc(prodDb, "attendance", key));
  if (snap.exists()) {
    await setDoc(doc(qaDb, "JENtrack-qa", key), snap.data());
    //await setDoc(doc(qaDb, "attendance2", key), snap.data());
    console.log(`✅ Copied ${key}`);
  } else {
    console.log(`⚠️  ${key} not found in prod — skipping`);
  }
}

console.log("🎉 Database copy complete!");
