import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc, runTransaction } from "firebase/firestore";

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

export async function load(key) {
  try {
    const snap = await getDoc(doc(db, "attendance", key));
    return snap.exists() ? snap.data().value : null;
  } catch (e) {
    console.error("Firebase load error:", e);
    return null;
  }
}

export async function save(key, val) {
  try {
    await setDoc(doc(db, "attendance", key), { value: val });
  } catch (e) {
    console.error("Firebase save error:", e);
  }
}

// Atomically add a new user to att:users, computing a collision-free
// slNo/id inside a Firestore transaction. If two admins add a member at
// the exact same moment, Firestore automatically re-runs this function
// against the latest data (usually invisibly, within a few ms) until it
// succeeds — no data corruption, no manual retry needed in the normal
// case. Only if all internal retries are exhausted (extremely rare,
// e.g. sustained conflict or network issue) does this throw, and the
// caller should show a "please try again" message.
export async function addUserAtomic(newUserFields) {
  const ref = doc(db, "attendance", "att:users");
  let createdUser = null;

  await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(ref);
    const users = snap.exists() && Array.isArray(snap.data().value) ? snap.data().value : [];

    const existingIds = new Set(users.map(u => u.id));
    let nextSlNo = users.reduce((max, u) => Math.max(max, u.slNo || 0), 0) + 1;
    let newId = "u" + nextSlNo;
    while (existingIds.has(newId)) {
      nextSlNo++;
      newId = "u" + nextSlNo;
    }

    createdUser = { ...newUserFields, id: newId, slNo: nextSlNo };
    transaction.set(ref, { value: [...users, createdUser] });
  });

  return createdUser;
}
