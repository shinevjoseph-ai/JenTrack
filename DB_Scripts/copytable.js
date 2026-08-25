import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc } from "firebase/firestore";
 
// ── Your Firebase config (same project for both collections) ────
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
 
const SOURCE_COLLECTION = "attendance2";
const DEST_COLLECTION   = "attendance";
const DOC_ID            = "att:users";
 
const snap = await getDoc(doc(db, SOURCE_COLLECTION, DOC_ID));
 
if (snap.exists()) {
  await setDoc(doc(db, DEST_COLLECTION, DOC_ID), snap.data());
  console.log(`✅ Copied ${DOC_ID} from "${SOURCE_COLLECTION}" to "${DEST_COLLECTION}"`);
} else {
  console.log(`⚠️  ${DOC_ID} not found in "${SOURCE_COLLECTION}"`);
}