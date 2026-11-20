// Builds the "what changed" lines for the activity log. Pure functions, no Firebase.
const MAX_CHANGES = 30;
const SECRET = new Set(["pin"]); // never written to the log

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const short = (v) => {
  if (v === undefined) return "—";
  if (v === null || typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return v === "" ? '""' : (v.length > 40 ? v.slice(0, 40) + "…" : v);
  if (Array.isArray(v)) return `[${v.length} items]`;
  return `{${Object.keys(v).length} fields}`;
};
const labelOf = (item) => {
  if (!isObj(item)) return "";
  if (item.slNo !== undefined && item.slNo !== null && item.slNo !== "") return `#${item.slNo} ${item.name || ""}`.trim();
  return item.name || String(item.id);
};
const at = (path, text) => (path.length ? `${path.join(" › ")} › ${text}` : text);

function walk(path, a, b, out) {
  const last = path[path.length - 1];
  if (SECRET.has(last)) { if (a !== b) out.add(`${path.join(" › ")}: changed (value hidden)`); return; }

  if (Array.isArray(a) || Array.isArray(b)) {
    const A = Array.isArray(a) ? a : [], B = Array.isArray(b) ? b : [];
    const all = [...A, ...B];
    if (all.length > 0 && all.every((x) => isObj(x) && x.id !== undefined)) {
      const am = new Map(A.map((x) => [x.id, x])), bm = new Map(B.map((x) => [x.id, x]));
      for (const [id, x] of am) if (!bm.has(id)) out.add(at(path, `removed ${labelOf(x)} (${id})`), true);
      for (const [id, x] of bm) {
        if (!am.has(id)) out.add(at(path, `added ${labelOf(x)} (${id})`));
        else walk([...path, labelOf(x) || String(id)], am.get(id), x, out);
      }
      return;
    }
    const as = A.map((x) => JSON.stringify(x)), bs = B.map((x) => JSON.stringify(x));
    const removed = A.filter((x, i) => !bs.includes(as[i])), added = B.filter((x, i) => !as.includes(bs[i]));
    removed.forEach((x) => out.add(at(path, `removed ${short(x)}`), true));
    added.forEach((x) => out.add(at(path, `added ${short(x)}`)));
    if (!removed.length && !added.length && as.join() !== bs.join()) out.add(at(path, "order changed"));
    return;
  }

  if (isObj(a) || isObj(b)) {
    if (a !== undefined && b !== undefined && isObj(a) !== isObj(b)) { out.add(`${path.join(" › ")}: ${short(a)} → ${short(b)}`); return; }
    const A = isObj(a) ? a : {}, B = isObj(b) ? b : {};
    for (const k of [...new Set([...Object.keys(A), ...Object.keys(B)])].sort()) walk([...path, k], A[k], B[k], out);
    return;
  }

  // A blank field appearing where there was none (or the reverse) is not a real change.
  const blank = (v) => v === undefined || v === null || v === "";
  // A deletion is a value that disappears, or an amount set to 0 (how the app removes an entry).
  const isRemoval = !blank(a) && (b === undefined || b === null || (typeof a === "number" && a > 0 && b === 0));
  if (a !== b && !(blank(a) && blank(b))) out.add(`${path.join(" › ") || "value"}: ${short(a)} → ${short(b)}`, isRemoval);
}

// known = false when this device never read the table before saving it.
export function describeChanges(before, after, known = true) {
  if (!known) return { changes: ["previous contents not known to this device"], truncated: false, removals: 0 };
  // Every change is counted; only the first MAX_CHANGES lines are kept.
  const out = { lines: [], total: 0, removals: 0, add(line, isRemoval) { this.total++; if (isRemoval) this.removals++; if (this.lines.length < MAX_CHANGES) this.lines.push(line); } };
  walk([], before, after, out);
  return { changes: out.lines, truncated: out.total > MAX_CHANGES, removals: out.removals };
}

export const sizeOf = (v) => (Array.isArray(v) ? v.length : isObj(v) ? Object.keys(v).length : (v === undefined || v === null ? 0 : 1));
