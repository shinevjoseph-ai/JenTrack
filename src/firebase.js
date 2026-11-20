import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDocFromServer, setDoc, runTransaction, addDoc, collection, serverTimestamp, getDocs, query, orderBy, limit, where } from "firebase/firestore";
import { describeChanges, sizeOf } from "./audit";

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

// ── Activity log ───────────────────────────────────────────────────────────
// Every save to every table adds one record to the "auditlog" collection: who, when,
// which table and what changed. One record per action (never read-then-rewrite), so
// entries cannot overwrite each other. Logging must never stop or delay a real save.
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const lastKnown = new Map(); // table key -> contents as this device last read or saved them
let auditActor = null;
const BUILD = typeof __BUILD_ID__ !== "undefined" ? __BUILD_ID__ : "dev";

// Called by the app whenever someone signs in or out.
export function setAuditActor(u) {
  auditActor = u ? { id: u.id, name: u.name, role: u.role } : null;
}

export async function logEvent(entry) {
  try {
    await addDoc(collection(db, "auditlog"), {
      ts: serverTimestamp(),
      clientTs: new Date().toISOString(),
      actorId: auditActor ? auditActor.id : null,
      actorName: auditActor ? auditActor.name : "not logged in",
      actorRole: auditActor ? auditActor.role : null,
      url: typeof window !== "undefined" ? window.location.href : "",
      build: BUILD,
      device: typeof navigator !== "undefined" ? navigator.userAgent : "",
      ...entry,
    });
  } catch (e) {
    console.error("Activity log write failed:", e);
  }
}

// Reads the activity log for Manage > System. Returns { rows (newest first), capped }.
//   no options      -> the latest 200 entries
//   from / to       -> everything in that date range (up to 1000), then narrowed to actorId if given
//   actorId only    -> everything by that member (up to 1000)
// actorId null means "not logged in"; leave it undefined for everyone. Each query uses a single
// field, so no extra Firestore index has to be created.
export async function loadAuditLog({ actorId, from, to, max } = {}) {
  const col = collection(db, "auditlog");
  let q, cap;
  if (from || to) {
    cap = max || 1000;
    const range = [];
    if (from) range.push(where("ts", ">=", from));
    if (to) range.push(where("ts", "<=", to));
    q = query(col, ...range, orderBy("ts", "desc"), limit(cap));
  } else if (actorId !== undefined) {
    cap = max || 1000;
    q = query(col, where("actorId", "==", actorId), limit(cap));
  } else {
    cap = max || 200;
    q = query(col, orderBy("ts", "desc"), limit(cap));
  }
  const snap = await getDocs(q);
  let rows = snap.docs.map((d) => {
    const x = d.data();
    return { id: d.id, ...x, ts: x.ts && x.ts.toDate ? x.ts.toDate().toISOString() : x.clientTs };
  });
  if (actorId !== undefined) rows = rows.filter((r) => (r.actorId === undefined ? null : r.actorId) === actorId);
  rows.sort((x, y) => (x.ts < y.ts ? 1 : x.ts > y.ts ? -1 : 0));
  return { rows, capped: snap.docs.length >= cap };
}

// Reads one table. Returns null ONLY when the server confirms the document does not exist.
// Any failure (offline, timeout, permission, quota) THROWS. It must never return null on a
// failed read: the app used to treat null as "no data yet" and save an empty table over the
// real one, which is how the user list was wiped. getDocFromServer also bypasses the local
// cache, so a stale or offline answer can never stand in for the real one.
export async function load(key) {
  const snap = await getDocFromServer(doc(db, "attendance", key));
  const value = snap.exists() ? snap.data().value : null;
  lastKnown.set(key, clone(value));
  return value;
}

// Tables that must never be emptied in one save. Removing the last remaining item is allowed;
// wiping two or more items at once, or saving "empty" over a table this device never read, is not.
const PROTECTED = new Set(["att:users", "att:records", "att:business", "att:departments", "att:meetingweeks", "att:meetingdates"]);

// Returns true when saved, false when refused or failed.
export async function save(key, val) {
  const known = lastKnown.has(key);
  const before = known ? lastKnown.get(key) : undefined;
  if (PROTECTED.has(key) && sizeOf(val) === 0 && (!known || sizeOf(before) >= 2)) {
    const had = known ? sizeOf(before) : null;
    console.error(`save BLOCKED: refused to empty ${key}`);
    logEvent({ type: "blocked", table: key, changes: [had === null ? "refused to save an empty table over contents this device had not read" : `refused to empty this table (${had} items)`], removals: had || 0, beforeSize: had, afterSize: 0 });
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("jen:save-blocked", { detail: { table: key } }));
    return false;
  }
  let described = { changes: ["(could not describe the change)"], truncated: false, removals: 0 };
  try { described = describeChanges(before === null ? undefined : before, val, known); } catch (e) { console.error("Activity log diff failed:", e); }
  const sizes = { beforeSize: known ? sizeOf(before) : null, afterSize: sizeOf(val) };
  try {
    await setDoc(doc(db, "attendance", key), { value: val });
    lastKnown.set(key, clone(val));
    // Flag a save that removes half or more of a table, so it stands out in the log.
    const bigDrop = known && sizes.beforeSize >= 4 && sizes.afterSize <= sizes.beforeSize / 2;
    logEvent({ type: "save", table: key, ...described, ...sizes, ...(bigDrop ? { bigDrop: true } : {}) });
    return true;
  } catch (e) {
    console.error("Firebase save error:", e);
    logEvent({ type: "save_failed", table: key, ...described, ...sizes, error: String((e && e.message) || e) });
    return false;
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
  let countBefore = 0;

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
    countBefore = users.length;
    lastKnown.set("att:users", clone([...users, createdUser]));
  });

  logEvent({
    type: "save", table: "att:users",
    changes: [`added #${createdUser.slNo} ${createdUser.name} (${createdUser.id})`], truncated: false, removals: 0,
    beforeSize: countBefore, afterSize: countBefore + 1,
  });

  return createdUser;
}
