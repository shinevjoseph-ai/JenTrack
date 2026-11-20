// remove-users-from-weeks.js
// Deletes the SAVED attendance and contribution entries of every member excluded in the app
// (Manage > Exclusions, stored in att:exclusions), for meetings dated on or after that member's date.
// If nothing has been saved in the app yet, it uses the same defaults as the app (u3 and u9 from 2026-11-01).
// User records, serial numbers and earlier meetings are never touched.
//
// Usage (from the project folder, see "Running a script" in the handoff doc):
//   node DB_Scripts\remove-users-from-weeks.js           -> DRY RUN, changes nothing
//   node DB_Scripts\remove-users-from-weeks.js --apply   -> writes a backup file, then applies

import fs from "fs";
import { initializeApp } from "firebase/app";
import { initializeFirestore, doc, getDoc, setDoc } from "firebase/firestore";

// ---- paste the real PRODUCTION config here (attendtrack-96e90) ----
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_AUTH_DOMAIN",
  projectId: "attendtrack-96e90",
  storageBucket: "YOUR_STORAGE_BUCKET",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

const DEFAULT_EXCLUSIONS = { u9: "2026-11-01" }; // same defaults as App.jsx
const COLLECTION = "attendance";
const APPLY = process.argv.includes("--apply");

const app = initializeApp(firebaseConfig);
const db = initializeFirestore(app, { experimentalForceLongPolling: true });

async function readTable(name) {
  const snap = await getDoc(doc(db, COLLECTION, name));
  if (!snap.exists()) return null;
  let v = snap.data().value;
  if (typeof v === "string") v = JSON.parse(v);
  return v;
}

// Maps every week key to its Monday using the SAME formula as the app's getWeekKey (not ISO weeks).
// Only used for weeks that have no saved meeting date.
const keyToMonday = {};
for (let d = new Date(2025, 11, 20); d <= new Date(2027, 11, 31); d.setDate(d.getDate() + 1)) {
  if (d.getDay() !== 1) continue; // Mondays only
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  const key = `${d.getFullYear()}-W${String(week).padStart(2, "0")}`;
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  keyToMonday[key] = iso;
}
const weekKeyToMonday = (wk) => keyToMonday[wk] || null;

const meetingDates = (await readTable("att:meetingdates")) || {};
const records = await readTable("att:records");
const business = await readTable("att:business");

if (!records || !business) {
  console.error("Could not read att:records or att:business. Nothing changed.");
  process.exit(1);
}

// Which members, and from when: the app's saved configuration, else the defaults
let exclusions = DEFAULT_EXCLUSIONS;
const savedCfg = await readTable("att:exclusions");
if (savedCfg && savedCfg.from && typeof savedCfg.from === "object") {
  exclusions = savedCfg.from;
  console.log("Using the exclusions saved in the app (att:exclusions).");
} else {
  console.log("No saved exclusions found; using the built-in defaults.");
}
const REMOVE_IDS = Object.keys(exclusions);
if (REMOVE_IDS.length === 0) {
  console.log("No members are excluded. Nothing to do.");
  process.exit(0);
}
console.log("Members and dates:", REMOVE_IDS.map((id) => `${id} from ${exclusions[id]}`).join(", "));

const weekDate = (wk) => meetingDates[wk] || weekKeyToMonday(wk);
const isExcluded = (id, wk) => {
  const from = exclusions[id];
  const d = weekDate(wk);
  return !!from && !!d && d >= from;
};

const allWeeks = new Set([...Object.keys(records), ...Object.keys(business)]);
const inScope = [];
for (const wk of allWeeks) {
  const date = weekDate(wk);
  if (date && REMOVE_IDS.some((id) => isExcluded(id, wk))) inScope.push({ wk, date, fromMeetingDate: !!meetingDates[wk] });
}
inScope.sort((a, b) => a.date.localeCompare(b.date));

console.log("Weeks in scope:");
inScope.forEach((s) =>
  console.log(`  ${s.wk}  ${s.date}  ${s.fromMeetingDate ? "(meeting date)" : "(estimated from week key - check)"}`)
);

const newRecords = JSON.parse(JSON.stringify(records));
const newBusiness = JSON.parse(JSON.stringify(business));
let recRemoved = 0, bizGiverRemoved = 0, bizRecipientRemoved = 0, bizAmount = 0;

for (const { wk } of inScope) {
  const ids = REMOVE_IDS.filter((id) => isExcluded(id, wk));
  // Attendance
  if (newRecords[wk] && typeof newRecords[wk] === "object") {
    for (const id of ids) {
      if (id in newRecords[wk]) { delete newRecords[wk][id]; recRemoved++; }
    }
  }
  // Business: as giver and as recipient
  const wkBiz = newBusiness[wk];
  if (wkBiz && typeof wkBiz === "object" && !Array.isArray(wkBiz)) {
    for (const id of ids) {
      if (wkBiz[id] && typeof wkBiz[id] === "object") {
        bizAmount += Object.values(wkBiz[id]).reduce((s, n) => s + (Number(n) || 0), 0);
      }
      if (id in wkBiz) { delete wkBiz[id]; bizGiverRemoved++; }
    }
    for (const giver of Object.keys(wkBiz)) {
      const row = wkBiz[giver];
      if (row && typeof row === "object" && !Array.isArray(row)) {
        for (const id of ids) {
          if (id in row) { bizAmount += Number(row[id]) || 0; delete row[id]; bizRecipientRemoved++; }
        }
      } else {
        console.warn(`  WARNING: ${wk} / ${giver} is in an older format; not edited. Review by hand.`);
      }
    }
  } else if (wkBiz) {
    console.warn(`  WARNING: ${wk} business data is in an older format; not edited. Review by hand.`);
  }
}

console.log("\nSummary" + (APPLY ? "" : " (DRY RUN)"));
console.log(`  attendance entries removed:        ${recRemoved}`);
console.log(`  business rows removed (as giver):  ${bizGiverRemoved}`);
console.log(`  business cells removed (as receiver): ${bizRecipientRemoved}`);
console.log(`  total rupees removed from business: ${bizAmount.toLocaleString("en-IN")}`);

if (!APPLY) {
  console.log("\nNothing was written. Re-run with --apply to make the change.");
  process.exit(0);
}

// Backup first
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupFile = `backup-records-business-${stamp}.json`;
fs.writeFileSync(backupFile, JSON.stringify({ records, business }, null, 2));
console.log(`\nBackup written: ${backupFile}`);

await setDoc(doc(db, COLLECTION, "att:records"), { value: newRecords });
await setDoc(doc(db, COLLECTION, "att:business"), { value: newBusiness });
console.log("Done. att:records and att:business updated.");
process.exit(0);
