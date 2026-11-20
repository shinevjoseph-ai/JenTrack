import { useState, useEffect, useRef } from "react";
import { load, save, addUserAtomic } from "./firebase";
import jenLogo from "./assets/jen-logo.png";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

const C = {
  bg: "#0F1117", card: "#1A1D27", border: "#2A2D3A",
  accent: "#6C63FF", green: "#22C55E", red: "#EF4444",
  amber: "#F59E0B", text: "#F0F0F5", muted: "#8888AA",
};

const isPrivileged = (role) => role === "admin" || role === "head_table";

// Robust super-admin check: prefers the explicit isSuperAdmin flag,
// but falls back to id === "u1" for any legacy user records that
// predate this flag (so nothing breaks without a migration).
const isSuperAdmin = (u) => !!u && (u.isSuperAdmin === true || u.id === "u1");

// ════════════════════════════════════════════════════════════════
// ROLE-BASED PERMISSIONS (placeholder layer)
// ────────────────────────────────────────────────────────────────
// All checks below currently return the SAME behavior the app has
// today (no restrictions beyond isPrivileged). This layer exists so
// future role-based rules can be added in ONE place instead of
// scattered across screens/components.
//
// Roles today: "admin", "head_table", "member"
// Planned (not yet implemented): per-field visibility on member
// details (e.g. hide phone/email/address from certain roles),
// per-role attendance history scope (e.g. head_table sees only
// their own department), and per-role Business/Contribution access.
// ════════════════════════════════════════════════════════════════

// Can this role open the Manage → Users "View Details" / Edit modals at all?
const canViewMemberDetails = (sessionRole) => isPrivileged(sessionRole);

// Can this role see a given contact field (phone/email/address) on a member's
// details view? `field` is one of: "phone" | "email" | "address" | "location"
// TODO: return false for specific role/field combinations when defined.
const canViewContactField = (sessionRole, field) => true;

// Can this role edit another member's profile (vs. only their own)?
const canEditOtherMembers = (sessionRole) => isPrivileged(sessionRole);

// Can this role view attendance data for members outside their own record?
// TODO: e.g. scope head_table to only their department's members.
const canViewAttendanceScope = (sessionRole, viewerId, targetMemberId) =>
  isPrivileged(sessionRole) || viewerId === targetMemberId;

// Can this role view the Business/Contribution tab at all?
const canViewBusinessTab = (sessionRole) => isPrivileged(sessionRole);

// Can this role view Manage → Categories / Meeting Weeks sections?
const canViewManageSection = (sessionRole, section) => sessionRole === "admin";

const roleLabel    = (role) => role === "admin" ? "👑 Admin" : role === "head_table" ? "🎖️ Head Table" : "Member";
const roleColor    = (role) => role === "admin" ? "#6C63FF" : role === "head_table" ? "#F59E0B" : "#8888AA";
const getGiverEntries = (business, week, giverId) => {
  const raw = (business[week] || {})[giverId];
  if (!raw) return [];
  if (Array.isArray(raw)) return raw; // legacy array-of-entries format
  // Very old single-entry format: { to: recipientId, amount: number }
  const keys = Object.keys(raw);
  if (keys.length === 2 && "to" in raw && "amount" in raw && typeof raw.amount === "number") {
    return [{ to: raw.to, amount: Math.round(raw.amount) }];
  }
  // Current format: { recipientId: amount, recipientId2: amount2, ... } — only keep numeric amounts
  return Object.entries(raw)
    .filter(([, amount]) => typeof amount === "number" && Number.isFinite(amount))
    .map(([to, amount]) => ({ to, amount: Math.round(amount) }));
};

// Week key: "YYYY-Www" e.g. "2026-W31"
// Aligned to the Monday of the week (matches getWeekLabel's Mon-Sun range exactly),
// so the key never disagrees with the displayed label depending on which day it's computed.
const getWeekKey = (offset = 0) => {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1) + offset * 7);
  const jan1 = new Date(monday.getFullYear(), 0, 1);
  const week = Math.ceil(((monday - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${monday.getFullYear()}-W${String(week).padStart(2, "0")}`;
};

const getWeekLabel = (offset = 0) => {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1) + offset * 7);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (d) => d.toLocaleDateString("en-IN", { month: "short", day: "2-digit" });
  return `${fmt(monday)} — ${fmt(sunday)}`;
};

// Convert a "YYYY-Www" week key back into an offset relative to the current week
const weekKeyToOffset = (key) => {
  const todayKey  = getWeekKey(0);
  const todayYear = parseInt(todayKey.split("-W")[0]);
  const todayWeek = parseInt(todayKey.split("-W")[1]);
  const tYear     = parseInt(key.split("-W")[0]);
  const tWeek     = parseInt(key.split("-W")[1]);
  return (tYear - todayYear) * 52 + (tWeek - todayWeek);
};

// Returns the actual Monday/Sunday Date objects (as "YYYY-MM-DD" strings) for a given week key,
// used to constrain the meeting-date picker to that week's real calendar range.
const getWeekDateRange = (key) => {
  const offset = weekKeyToOffset(key);
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1) + offset * 7);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { monday: iso(monday), sunday: iso(sunday) };
};

// Shows the actual selected meeting date for a week (from meetingDates), formatted nicely.
// Falls back to the plain Mon-Sun week label if that meeting hasn't had a date set yet.
const getMeetingDateOrWeekLabel = (weekKey, weekOffset, meetingDates) => {
  const meetingDate = meetingDates && meetingDates[weekKey];
  return meetingDate
    ? new Date(meetingDate + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
    : getWeekLabel(weekOffset);
};

// Computes the true reporting span for a given meeting week: from the day AFTER the
// previous meeting's date, through the current meeting's date (inclusive). This widens
// the span to cover any skipped/postponed weeks in between (14, 21+ days), since
// contribution data logged during a gap has nowhere else to be reported. Falls back to
// a single calendar week if there's no previous meeting or no dates have been set yet.
const computeMeetingSpan = (currentWeek, meetingWeeks, meetingDates, weekOffset) => {
  const sortedMeetingWeeks = [...meetingWeeks].sort();
  const curIdx = sortedMeetingWeeks.indexOf(currentWeek);
  const prevMeetingWeek = curIdx > 0 ? sortedMeetingWeeks[curIdx - 1] : null;

  let spanWeekKeys;
  if (!meetingWeeks.includes(currentWeek)) {
    spanWeekKeys = [currentWeek];
  } else {
    const curOffset = weekKeyToOffset(currentWeek);
    const prevOffset = prevMeetingWeek ? weekKeyToOffset(prevMeetingWeek) : curOffset - 1;
    spanWeekKeys = [];
    for (let o = prevOffset + 1; o <= curOffset; o++) spanWeekKeys.push(getWeekKey(o));
  }

  const spanLabel = prevMeetingWeek && meetingDates[prevMeetingWeek] && meetingDates[currentWeek]
    ? (() => {
        const dayAfterPrev = new Date(new Date(meetingDates[prevMeetingWeek] + "T00:00:00").getTime() + 86400000);
        const curDate = new Date(meetingDates[currentWeek] + "T00:00:00");
        const fmt = (d) => d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
        return `${fmt(dayAfterPrev)} — ${fmt(curDate)}`;
      })()
    : getWeekLabel(weekOffset);

  return { prevMeetingWeek, spanWeekKeys, spanLabel };
};

const inputStyle = {
  width: "100%", background: "#252836", border: "1px solid #6C63FF55",
  borderRadius: 10, padding: "12px 14px", color: "#F0F0F5",
  fontSize: 16, boxSizing: "border-box", outline: "none",
  boxShadow: "inset 0 1px 4px #0004",
};

// ── Atoms ─────────────────────────────────────────────────────────
const Input = ({ value, onChange, type = "text", placeholder, maxLength }) => (
  <input value={value} onChange={e => onChange(e.target.value)}
    type={type} placeholder={placeholder} maxLength={maxLength} style={inputStyle} />
);

const Btn = ({ children, onClick, style = {}, disabled }) => (
  <button onClick={onClick} disabled={disabled} style={{
    background: disabled ? "#2A2D3A" : "#6C63FF", color: disabled ? "#8888AA" : "#fff",
    border: "none", borderRadius: 12, padding: "14px 0", width: "100%",
    fontSize: 16, fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer",
    letterSpacing: ".5px", ...style,
  }}>{children}</button>
);

const Tag = ({ present }) => (
  <span style={{ background: present ? "#22C55E22" : "#EF444422", color: present ? "#22C55E" : "#EF4444", borderRadius: 20, padding: "3px 11px", fontSize: 12, fontWeight: 700 }}>
    {present ? "Present" : "Absent"}
  </span>
);

const Card = ({ children, style = {} }) => (
  <div style={{ background: "#1A1D27", border: "1px solid #2A2D3A", borderRadius: 16, padding: 20, marginBottom: 14, ...style }}>
    {children}
  </div>
);

const H1    = ({ children }) => <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 4 }}>{children}</div>;
const Label = ({ children }) => <div style={{ fontSize: 12, color: "#B0B3C6", marginBottom: 6, fontWeight: 700, letterSpacing: ".8px", textTransform: "uppercase" }}>{children}</div>;

function Toast({ t }) {
  return <div style={{ position: "fixed", top: 20, left: "50%", transform: "translateX(-50%)", background: t.color, color: "#fff", borderRadius: 12, padding: "12px 22px", fontWeight: 700, fontSize: 15, zIndex: 999, whiteSpace: "nowrap", boxShadow: "0 4px 20px #0008" }}>{t.msg}</div>;
}

const Toggle = ({ checked, onChange }) => (
  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
    <label style={{ position: "relative", display: "inline-block", width: 44, height: 24, cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ opacity: 0, width: 0, height: 0 }} />
      <span style={{ position: "absolute", inset: 0, borderRadius: 99, background: checked ? "#22C55E" : "#2A2D3A", transition: ".3s" }}>
        <span style={{ position: "absolute", height: 18, width: 18, left: checked ? 23 : 3, bottom: 3, background: "#fff", borderRadius: "50%", transition: ".3s" }} />
      </span>
    </label>
    <span style={{ fontSize: 11, color: checked ? "#22C55E" : "#EF4444", fontWeight: 700 }}>{checked ? "Active" : "Inactive"}</span>
  </div>
);

// ── Week Nav ──────────────────────────────────────────────────────
const WeekNav = ({ weekOffset, setWeekOffset, meetingWeeks, meetingDates, disabled }) => {
  const currentKey = getWeekKey(weekOffset);
  const sorted     = [...(meetingWeeks || [])].sort();
  const idx        = sorted.indexOf(currentKey);
  const hasPrev    = !disabled && idx > 0;
  const hasNext    = !disabled && idx < sorted.length - 1;
  const noMeetings = sorted.length === 0;

  const jumpToKey = (key) => setWeekOffset(weekKeyToOffset(key));

  const label = disabled ? "All Time"
    : noMeetings ? "No meeting weeks set"
    : idx === -1 ? `${getWeekKey(weekOffset)}`
    : `Meeting Week ${idx + 1} of ${sorted.length}`;

  const meetingDate = meetingDates && meetingDates[currentKey];
  const subtitle = disabled
    ? "Spans every logged week"
    : meetingDate
    ? new Date(meetingDate + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
    : getWeekLabel(weekOffset);

  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#1A1D27", borderBottom: "1px solid #2A2D3A", padding: "10px 20px", opacity: disabled ? 0.5 : 1 }}>
      <button onClick={() => hasPrev && jumpToKey(sorted[idx - 1])} disabled={!hasPrev}
        style={{ background: hasPrev ? "#2A2D3A" : "#1A1D27", border: "none", color: hasPrev ? "#F0F0F5" : "#3A3D4A", borderRadius: 8, padding: "6px 14px", fontSize: 16, cursor: hasPrev ? "pointer" : "not-allowed", fontWeight: 700 }}>‹‹</button>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 13, color: disabled ? "#8888AA" : noMeetings ? "#F59E0B" : "#F0F0F5", fontWeight: 700 }}>📅 {label}</div>
        <div style={{ fontSize: 11, color: "#8888AA" }}>{subtitle}</div>
      </div>
      <button onClick={() => hasNext && jumpToKey(sorted[idx + 1])} disabled={!hasNext}
        style={{ background: hasNext ? "#2A2D3A" : "#1A1D27", border: "none", color: hasNext ? "#F0F0F5" : "#3A3D4A", borderRadius: 8, padding: "6px 14px", fontSize: 16, cursor: hasNext ? "pointer" : "not-allowed", fontWeight: 700 }}>››</button>
    </div>
  );
};

// ── Nav ───────────────────────────────────────────────────────────
const Nav = ({ screen, session, setScreen, setSession }) => {
  const tabs = session?.role === "admin"
    ? [["home","🏠","Home"],["mark","✅","Attendance"],["biz","💰","Business"],["admin","⚙️","Manage"]]
    : session?.role === "head_table"
    ? [["home","🏠","Home"],["mark","✅","Attendance"],["biz","💰","Business"],["profile","👤","Profile"]]
    : [["home","🏠","Home"],["biz","💰","Business"],["profile","👤","Profile"],["history","📅","History"]];
  return (
    <div style={{ position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 420, background: "#1A1D27", borderTop: "1px solid #2A2D3A", display: "flex", zIndex: 99 }}>
      {tabs.map(([s, icon, label]) => (
        <button key={s} onClick={() => setScreen(s)} style={{ flex: 1, background: screen === s ? "#6C63FF22" : "none", border: "none", color: screen === s ? "#6C63FF" : "#8888AA", padding: "10px 0 14px", fontSize: 10, fontWeight: screen === s ? 700 : 500, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, borderTop: screen === s ? "2px solid #6C63FF" : "2px solid transparent" }}>
          <span style={{ fontSize: 18 }}>{icon}</span>{label}
        </button>
      ))}
      <button onClick={() => { setSession(null); setScreen("login"); }} style={{ flex: 1, background: "none", border: "none", color: "#8888AA", padding: "10px 0 14px", fontSize: 10, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
        <span style={{ fontSize: 18 }}>🚪</span>Logout
      </button>
    </div>
  );
};

// ── Edit Modal ────────────────────────────────────────────────────
const EditModal = ({ editUser, editFields, setEditFields, setEditUser, saveEdit, sessionRole, sessionId, sessionIsSuperAdmin, departments }) => {
  if (!editUser) return null;
  const isEditingSelf = editUser.id === sessionId;
  const canEditRole = isPrivileged(sessionRole) && !isEditingSelf;
  return (
    <div style={{ position: "fixed", inset: 0, background: "#000a", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div style={{ background: "#1A1D27", borderRadius: "20px 20px 0 0", width: "100%", maxWidth: 420, padding: 24, maxHeight: "85vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div style={{ fontWeight: 800, fontSize: 18 }}>✏️ Edit Profile</div>
          <button onClick={() => setEditUser(null)} style={{ background: "#2A2D3A", border: "none", color: "#F0F0F5", borderRadius: 8, padding: "6px 12px", cursor: "pointer", fontWeight: 700 }}>✕ Close</button>
        </div>
        <Label>Full Name</Label>
        <Input value={editFields.name} onChange={v => setEditFields(f => ({ ...f, name: v }))} placeholder="Full name" />
        <div style={{ height: 12 }} />
        <Label>Member Photo (image URL)</Label>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12 }}>
          {editFields.photoUrl ? (
            <img src={editFields.photoUrl} alt="Member" style={{ width: 48, height: 48, borderRadius: "50%", objectFit: "cover", border: "1px solid #2A2D3A", flexShrink: 0 }} onError={e => { e.target.style.display = "none"; }} />
          ) : (
            <div style={{ width: 48, height: 48, borderRadius: "50%", background: "#0F1117", border: "1px solid #2A2D3A", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, color: "#3A3D4A", flexShrink: 0 }}>👤</div>
          )}
          <Input value={editFields.photoUrl} onChange={v => setEditFields(f => ({ ...f, photoUrl: v }))} placeholder="Paste image URL" />
        </div>
        <Label>PIN</Label>
        <Input value={editFields.pin} onChange={v => setEditFields(f => ({ ...f, pin: v }))} type="text" placeholder="PIN" />
        <div style={{ height: 12 }} />
        {canEditRole && sessionIsSuperAdmin && (
          <>
            <Label>Super Admin</Label>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#252836", border: "1px solid #6C63FF55", borderRadius: 10, padding: "10px 14px", marginBottom: 12 }}>
              <span style={{ fontSize: 12, color: "#8888AA" }}>Grants access to Clear Contribution Data and Serial Number editing</span>
              <Toggle checked={editFields.isSuperAdmin === true} onChange={v => setEditFields(f => ({ ...f, isSuperAdmin: v }))} />
            </div>
          </>
        )}
        {canEditRole && (
          <>
            <Label>Serial Number</Label>
            {editFields.isSuperAdmin === true || editUser.id === "u1" ? (
              <>
                <Input value={editFields.slNo !== undefined && editFields.slNo !== null ? String(editFields.slNo) : ""} onChange={v => setEditFields(f => ({ ...f, slNo: v.replace(/[^0-9]/g, "") }))} type="text" placeholder="e.g. 5" />
                <div style={{ fontSize: 11, color: "#8888AA", marginTop: 4, marginBottom: 12 }}>Controls sort order across all pages. Duplicate numbers are allowed but not recommended.</div>
              </>
            ) : (
              <div style={{ fontSize: 15, color: "#F0F0F5", fontWeight: 700, marginBottom: 12 }}>#{editFields.slNo !== undefined && editFields.slNo !== "" ? editFields.slNo : "—"}</div>
            )}
            <Label>Role & Status</Label>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
              <select value={editFields.role} onChange={e => setEditFields(f => ({ ...f, role: e.target.value }))} style={{ ...inputStyle, flex: 1 }}>
                <option value="admin">👑 Admin</option>
                <option value="head_table">🎖️ Head Table</option>
                <option value="member">Member</option>
              </select>
              <Toggle checked={editFields.active !== false} onChange={v => setEditFields(f => ({ ...f, active: v }))} />
            </div>
          </>
        )}
        <Label>Phone</Label>
        <Input value={editFields.phone} onChange={v => setEditFields(f => ({ ...f, phone: v }))} placeholder="Phone number" />
        <div style={{ height: 12 }} />
        <Label>Email</Label>
        <Input value={editFields.email} onChange={v => setEditFields(f => ({ ...f, email: v }))} placeholder="Email address" />
        <div style={{ height: 12 }} />
        <Label>Category</Label>
        <select value={editFields.department} onChange={e => setEditFields(f => ({ ...f, department: e.target.value }))} style={{ ...inputStyle, marginBottom: 0 }}>
          <option value="">— Select Category —</option>
          {(departments || []).map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
        </select>
        <div style={{ height: 12 }} />
        <Label>Address</Label>
        <Input value={editFields.address} onChange={v => setEditFields(f => ({ ...f, address: v }))} placeholder="Address" />
        <div style={{ height: 12 }} />
        <Label>Pincode</Label>
        <Input value={editFields.pincode} onChange={v => setEditFields(f => ({ ...f, pincode: v }))} placeholder="Pincode" />
        <div style={{ height: 12 }} />
        <Label>Business</Label>
        <Input value={editFields.business} onChange={v => setEditFields(f => ({ ...f, business: v }))} placeholder="Business" />
        <div style={{ height: 12 }} />
        <Label>Business Location (Google Maps link)</Label>
        <Input value={editFields.location} onChange={v => setEditFields(f => ({ ...f, location: v }))} placeholder="Paste Google Maps link" />
        <div style={{ height: 12 }} />
        <Label>Business Photo (image URL)</Label>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12 }}>
          {editFields.bizPhotoUrl ? (
            <img src={editFields.bizPhotoUrl} alt="Business" style={{ width: 48, height: 48, borderRadius: 8, objectFit: "cover", border: "1px solid #2A2D3A", flexShrink: 0 }} onError={e => { e.target.style.display = "none"; }} />
          ) : (
            <div style={{ width: 48, height: 48, borderRadius: 8, background: "#0F1117", border: "1px solid #2A2D3A", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, color: "#3A3D4A", flexShrink: 0 }}>🏢</div>
          )}
          <Input value={editFields.bizPhotoUrl} onChange={v => setEditFields(f => ({ ...f, bizPhotoUrl: v }))} placeholder="Paste image URL" />
        </div>
        <div style={{ height: 8 }} />
        <Btn onClick={saveEdit}>💾 Save Changes</Btn>
      </div>
    </div>
  );
};

// ── View Details Modal (read-only, with Edit button to switch) ───
const ViewDetailsModal = ({ viewUser, setViewUser, onEdit, departments, sessionRole }) => {
  if (!viewUser) return null;
  const Row = ({ label, value, href }) => (
    <div style={{ padding: "10px 0", borderBottom: "1px solid #2A2D3A" }}>
      <div style={{ fontSize: 11, color: "#8888AA", fontWeight: 700, letterSpacing: ".5px", textTransform: "uppercase", marginBottom: 3 }}>{label}</div>
      {value ? (
        href ? (
          <a href={href} style={{ fontSize: 15, color: "#6C63FF", fontWeight: 600, textDecoration: "none" }}>{value}</a>
        ) : (
          <div style={{ fontSize: 15, color: "#F0F0F5", fontWeight: 600 }}>{value}</div>
        )
      ) : (
        <div style={{ fontSize: 15, color: "#3A3D4A" }}>—</div>
      )}
    </div>
  );
  return (
    <div style={{ position: "fixed", inset: 0, background: "#000a", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div style={{ background: "#1A1D27", borderRadius: "20px 20px 0 0", width: "100%", maxWidth: 420, padding: 24, maxHeight: "85vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ fontWeight: 800, fontSize: 18 }}>👁️ View Details</div>
          <div style={{ display: "flex", gap: 8 }}>
            {canEditOtherMembers(sessionRole) && (
              <button onClick={() => { setViewUser(null); onEdit(viewUser); }} style={{ background: "#6C63FF22", border: "none", color: "#6C63FF", borderRadius: 8, padding: "6px 12px", cursor: "pointer", fontWeight: 700 }}>✏️ Edit</button>
            )}
            <button onClick={() => setViewUser(null)} style={{ background: "#2A2D3A", border: "none", color: "#F0F0F5", borderRadius: 8, padding: "6px 12px", cursor: "pointer", fontWeight: 700 }}>✕ Close</button>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
          {viewUser.photoUrl ? (
            <img src={viewUser.photoUrl} alt={viewUser.name} style={{ width: 84, height: 84, borderRadius: "50%", objectFit: "cover", border: "2px solid #2A2D3A" }} onError={e => { e.target.style.display = "none"; }} />
          ) : (
            <div style={{ width: 84, height: 84, borderRadius: "50%", background: "#0F1117", border: "2px solid #2A2D3A", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32, color: "#3A3D4A" }}>👤</div>
          )}
        </div>
        <Row label="Full Name" value={viewUser.name} />
        <Row label="Role" value={roleLabel(viewUser.role)} />
        <Row label="Status" value={viewUser.active === false ? "Inactive" : "Active"} />
        {canViewContactField(sessionRole, "phone") && <Row label="Phone" value={viewUser.phone} href={viewUser.phone ? `tel:${viewUser.phone}` : undefined} />}
        {canViewContactField(sessionRole, "email") && <Row label="Email" value={viewUser.email} href={viewUser.email ? `mailto:${viewUser.email}` : undefined} />}
        <Row label="Category" value={viewUser.department} />
        {canViewContactField(sessionRole, "address") && <Row label="Address" value={viewUser.address} />}
        <Row label="Pincode" value={viewUser.pincode} />
        <Row label="Business" value={viewUser.business} />
        <Row label="Business Location" value={viewUser.location ? "📍 View on Map" : ""} href={viewUser.location || undefined} />
        {viewUser.bizPhotoUrl && (
          <div style={{ padding: "10px 0" }}>
            <div style={{ fontSize: 11, color: "#8888AA", fontWeight: 700, letterSpacing: ".5px", textTransform: "uppercase", marginBottom: 8 }}>Business Photo</div>
            <img src={viewUser.bizPhotoUrl} alt="Business" style={{ width: "100%", maxHeight: 180, borderRadius: 10, objectFit: "cover", border: "1px solid #2A2D3A" }} onError={e => { e.target.style.display = "none"; }} />
          </div>
        )}
      </div>
    </div>
  );
};

// ── Meeting Date Picker Modal ──────────────────────────────────────
const MeetingDateModal = ({ weekKey, pendingDate, setPendingDate, onConfirm, onCancel }) => {
  if (!weekKey) return null;
  const { monday, sunday } = getWeekDateRange(weekKey);
  return (
    <div style={{ position: "fixed", inset: 0, background: "#000a", zIndex: 210, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ background: "#1A1D27", borderRadius: 16, width: "100%", maxWidth: 360, padding: 24 }}>
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 6 }}>📅 Select Meeting Date</div>
        <div style={{ fontSize: 12, color: "#8888AA", marginBottom: 16 }}>Pick the actual date this meeting is held on, within {monday} to {sunday}.</div>
        <input type="date" value={pendingDate} min={monday} max={sunday}
          onChange={e => setPendingDate(e.target.value)}
          style={{ width: "100%", background: "#252836", border: "1px solid #6C63FF55", borderRadius: 10, padding: "12px 14px", color: "#F0F0F5", fontSize: 15, marginBottom: 20, boxSizing: "border-box" }} />
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onCancel} style={{ flex: 1, background: "#2A2D3A", border: "none", color: "#8888AA", borderRadius: 10, padding: "12px 0", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Cancel</button>
          <button onClick={onConfirm} style={{ flex: 1, background: "#6C63FF", border: "none", color: "#fff", borderRadius: 10, padding: "12px 0", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Confirm</button>
        </div>
      </div>
    </div>
  );
};

// ── Bar Chart (weekly trend) ──────────────────────────────────────
function BarChart({ weeks, records, members, selectedWeek, meetingDates }) {
  const max = members.length || 1;
  const fmtDate = (w) => {
    const dateStr = (meetingDates && meetingDates[w]) || getWeekDateRange(w).monday;
    const d = new Date(dateStr + "T00:00:00");
    const dd = String(d.getDate()).padStart(2, "0");
    const mmm = d.toLocaleDateString("en-IN", { month: "short" }).toUpperCase();
    return `${dd}/${mmm}`;
  };
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 90, marginTop: 8 }}>
      {weeks.map((w, i) => {
        const present   = members.filter(m => (records[w] || {})[m.id] === true).length;
        const absent    = members.filter(m => (records[w] || {})[m.id] === false).length;
        const pPct      = Math.round((present / max) * 100);
        const aPct      = Math.round((absent  / max) * 100);
        const isSelected = w === selectedWeek;
        return (
          <div key={w} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <div style={{ fontSize: 9, color: "#8888AA", fontWeight: 600 }}>{present}/{max}</div>
            <div style={{ width: "100%", height: 60, display: "flex", flexDirection: "column", justifyContent: "flex-end", borderRadius: 6, overflow: "hidden", background: "#2A2D3A" }}>
              <div style={{ width: "100%", height: `${aPct}%`, background: "#EF4444", minHeight: absent  > 0 ? 3 : 0 }} />
              <div style={{ width: "100%", height: `${pPct}%`, background: isSelected ? "#6C63FF" : "#22C55E", minHeight: present > 0 ? 3 : 0 }} />
            </div>
            <div style={{ fontSize: 9, color: isSelected ? "#6C63FF" : "#8888AA", fontWeight: isSelected ? 700 : 400 }}>{fmtDate(w)}</div>
          </div>
        );
      })}
    </div>
  );
}

function Donut({ present, absent, unmarked, total }) {
  const r = 36, cx = 44, cy = 44, stroke = 10, circ = 2 * Math.PI * r;
  const pPct = total ? present / total : 0, aPct = total ? absent / total : 0, uPct = total ? unmarked / total : 0;
  return (
    <svg width={88} height={88} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#2A2D3A" strokeWidth={stroke} />
      {[[pPct,"#22C55E",0],[aPct,"#EF4444",pPct],[uPct,"#F59E0B",pPct+aPct]].map(([pct,color,offset],i) => (
        <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeDasharray={`${pct*circ} ${circ}`} strokeDashoffset={-offset*circ} strokeLinecap="butt" />
      ))}
      <text x={cx} y={cy+1} textAnchor="middle" dominantBaseline="middle" fill="#F0F0F5" fontSize={14} fontWeight={800}
        style={{ transform: `rotate(90deg)`, transformOrigin: `${cx}px ${cy}px` }}>
        {total ? Math.round(pPct*100) : 0}%
      </text>
    </svg>
  );
}

// ════════════════════════════════════════════════════════════════
export default function App() {
  const [users, setUsers]                 = useState(null);
  const [records, setRecords]             = useState(null);
  const [session, setSession]             = useState(null);
  const [screen, setScreen]               = useState("login");
  const [pinInput, setPinInput]           = useState("");
  const [selUser, setSelUser]             = useState("");
  const [typeUsername, setTypeUsername]   = useState(false);
  const [usernameInput, setUsernameInput] = useState("");
  const [toast, setToast]                 = useState(null);
  const [loading, setLoading]             = useState(true);
  const [loadError, setLoadError]         = useState(false);
  const [attTab, setAttTab]               = useState("mark");
  const [manageTab, setManageTab]         = useState("users");
  const [userSearch, setUserSearch]       = useState("");
  const [deptSearch, setDeptSearch]       = useState("");
  const [showUnassigned, setShowUnassigned] = useState(false);
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);
  const [showInactive, setShowInactive]   = useState(false);
  const [meetingWeeks, setMeetingWeeks]   = useState([]);
  const [meetingDates, setMeetingDates]   = useState({}); // key: weekKey -> "YYYY-MM-DD" chosen meeting date
  const [datePickerFor, setDatePickerFor] = useState(null); // weekKey currently showing the date-picker popup
  const [pendingDate, setPendingDate]     = useState("");
  const [editDeptId, setEditDeptId]       = useState(null);
  const [showAddDeptForm, setShowAddDeptForm] = useState(false);
  const deptFormRef                       = useRef(null);
  const [business, setBusiness]           = useState({});
  const [bizView, setBizView]             = useState("entry"); // entry | matrix
  const [takerSelect, setTakerSelect]     = useState({}); // key: giverId -> selected taker id
  const [showReceiversOnly, setShowReceiversOnly] = useState(false);
  const [reportScope, setReportScope]     = useState("all"); // all | week
  const [showClearWeekConfirm, setShowClearWeekConfirm] = useState(false);
  const [confirmUserAction, setConfirmUserAction]       = useState(null); // { uid, type: "disable" | "remove" }
  const [bizAmountInput, setBizAmountInput] = useState({}); // key: `${week}_${giverId}_${recipientId}` -> typed value
  const [editUser, setEditUser]           = useState(null);
  const [viewUser, setViewUser]           = useState(null);
  const [editFields, setEditFields]       = useState({});
  const [weekOffset, setWeekOffset]       = useState(0);
  const [homeChartPage, setHomeChartPage] = useState(0);
  const [showAddForm, setShowAddForm]     = useState(false);
  const [departments, setDepartments]     = useState([]);
  const [newDept, setNewDept]             = useState({ name: "", description: "", comments: "" });

  // Add member fields
  const [newName, setNewName]             = useState("");
  const [newPin, setNewPin]               = useState("");
  const [newRole, setNewRole]             = useState("member");
  const [newActive, setNewActive]         = useState(true);
  const [newPhone, setNewPhone]           = useState("");
  const [newEmail, setNewEmail]           = useState("");
  const [newDepartment, setNewDepartment] = useState("");
  const [newAddress, setNewAddress]       = useState("");
  const [newPincode, setNewPincode]       = useState("");
  const [newBusiness, setNewBusiness]     = useState("");
  const [newLocation, setNewLocation]     = useState("");
  const [newPhotoUrl, setNewPhotoUrl]     = useState("");
  const [newBizPhotoUrl, setNewBizPhotoUrl] = useState("");

  useEffect(() => {
    const timeout = setTimeout(() => setLoadError(true), 10000);
    (async () => {
      try {
        let u = await load("att:users");
        if (!u) {
          // This should ONLY fire on a genuine first-ever run (att:users document
          // truly doesn't exist yet). load() now throws on real read errors instead
          // of returning null, so a transient failure can no longer land here. Still
          // logged, since this is the exact code path the original data-wipe bug lived in.
          u = [];
          await save("att:users", u);
          try {
            const existing = (await load("att:userauditlog")) || [];
            await save("att:userauditlog", [...existing, {
              ts: new Date().toISOString(), actorId: "system", actorName: "initial load (document did not exist)",
              event: "write", beforeCount: -1, afterCount: 0,
              url: typeof window !== "undefined" ? window.location.href : "unknown",
            }].slice(-200));
          } catch (e) { console.error("Failed to write audit log:", e); }
        }
        u = u.map(x => ({ active: true, ...x }));
        let r = await load("att:records");
        if (!r) { r = {}; await save("att:records", r); }
        let d = await load("att:departments");
        if (!d) { d = []; await save("att:departments", d); }
        let mw = await load("att:meetingweeks");
        if (!mw) { mw = []; await save("att:meetingweeks", mw); }
        let md = await load("att:meetingdates");
        if (!md) { md = {}; await save("att:meetingdates", md); }
        let bz = await load("att:business");
        if (!bz) { bz = {}; await save("att:business", bz); }
        setUsers(u); setRecords(r); setDepartments(d); setMeetingWeeks(mw); setMeetingDates(md); setBusiness(bz); setLoading(false);
        clearTimeout(timeout);
      } catch (e) { setLoadError(true); clearTimeout(timeout); }
    })();
    return () => clearTimeout(timeout);
  }, []);

  const showToast      = (msg, color = "#22C55E") => { setToast({ msg, color }); setTimeout(() => setToast(null), 2800); };
  const persistRecords     = async (r) => { setRecords(r); await save("att:records", r); };
  // Audit log: records who/what/when for every write attempt to att:users, kept in
  // a separate document so we can answer "who did it" after the fact. Capped to the
  // most recent 200 entries so the document doesn't grow unbounded.
  const logUserListChange = async (event, beforeCount, afterCount) => {
    try {
      const existing = (await load("att:userauditlog")) || [];
      const entry = {
        ts: new Date().toISOString(),
        actorId: session?.id || "unknown",
        actorName: session?.name || "unknown (not logged in / initial load)",
        event, // "write" | "blocked"
        beforeCount,
        afterCount,
        url: typeof window !== "undefined" ? window.location.href : "unknown",
      };
      const updated = [...existing, entry].slice(-200);
      await save("att:userauditlog", updated);
    } catch (e) {
      console.error("Failed to write audit log:", e);
    }
  };

  // Safety net: this is the SINGLE choke point every user-list write goes through
  // (initial load, add, edit, disable, remove). Legitimate removals happen one at a
  // time via deleteMember (with confirmation), so the count should only ever drop
  // by 1 per call. A jump straight from many users to zero in one write is almost
  // never a deliberate, correct action — it's the signature of stale/corrupted local
  // state (e.g. an old browser tab still running pre-fix code, or a failed read
  // upstream) silently wiping the table. Block it outright rather than trust the caller.
  const persistUsers = async (u) => {
    // Every legitimate call site changes the list by at most 1 person (deleteMember
    // removes exactly one; toggleActive/saveEdit use .map() and never change length
    // at all). A drop of more than 1 in a single write is never a normal, deliberate
    // action — block it outright rather than trust the caller, whatever the cause.
    const drop = users.length - (Array.isArray(u) ? u.length : 0);
    if (Array.isArray(u) && drop > 1) {
      console.error(`persistUsers BLOCKED: refused to drop from ${users.length} to ${u.length} users in one write.`);
      showToast("⚠️ Blocked a save that would have removed multiple members at once. Please refresh the page and try again — contact the super admin if this keeps happening.", "#EF4444");
      await logUserListChange("blocked", users.length, u.length);
      return;
    }
    await logUserListChange("write", users.length, Array.isArray(u) ? u.length : -1);
    setUsers(u);
    await save("att:users", u);
  };
  const persistDepartments  = async (d)  => { setDepartments(d);   await save("att:departments",  d); };
  const persistMeetingWeeks = async (mw) => { setMeetingWeeks(mw); await save("att:meetingweeks", mw); };
  const persistMeetingDates = async (md) => { setMeetingDates(md); await save("att:meetingdates", md); };
  const persistBusiness     = async (bz) => { setBusiness(bz);     await save("att:business", bz); };

  const getRecipientMap = (week, giverId) => {
    const map = {};
    getGiverEntries(business, week, giverId).forEach(e => { map[e.to] = e.amount; });
    return map;
  };

  const saveRecipientAmount = async (week, giverId, recipientId, rawValue) => {
    const amt = parseInt(rawValue, 10);
    if (!rawValue || isNaN(amt) || amt <= 0) return showToast("Enter a valid amount", "#F59E0B");
    const map = getRecipientMap(week, giverId);
    map[recipientId] = amt;
    const updated = { ...business, [week]: { ...(business[week] || {}) } };
    updated[week][giverId] = map;
    await persistBusiness(updated);
    const inputKey = `${week}_${giverId}_${recipientId}`;
    setBizAmountInput(f => ({ ...f, [inputKey]: "" }));
    const giverName = users.find(u => u.id === giverId)?.name;
    const receiverName = users.find(u => u.id === recipientId)?.name;
    showToast(`${giverName} → ${receiverName}: ₹${amt.toLocaleString("en-IN")}`, "#22C55E");
  };

  const clearWeekBusiness = async (week) => {
    if (!isSuperAdmin(session)) return showToast("Only the super admin can clear contribution data", "#EF4444");
    const updated = { ...business };
    delete updated[week];
    await persistBusiness(updated);
    showToast(`Contribution data cleared for ${getWeekLabel(weekOffset)}`, "#F59E0B");
  };

  const toggleMeetingWeek = async (wk) => {
    const latestWeek = meetingWeeks.length ? [...meetingWeeks].sort().slice(-1)[0] : null;
    const isFrozen = meetingWeeks.includes(wk) && wk !== latestWeek;
    if (isFrozen && !isSuperAdmin(session)) {
      return showToast("This meeting is frozen. Only the super admin can change it.", "#EF4444");
    }
    if (meetingWeeks.includes(wk)) {
      // Deselecting an already-selected week — remove it and its chosen date directly.
      const updated = meetingWeeks.filter(w => w !== wk);
      await persistMeetingWeeks(updated);
      const updatedDates = { ...meetingDates };
      delete updatedDates[wk];
      await persistMeetingDates(updatedDates);
      showToast("Week removed", "#F59E0B");
    } else {
      // Selecting a new week — open the date picker instead of adding immediately.
      const { monday } = getWeekDateRange(wk);
      setPendingDate(meetingDates[wk] || monday);
      setDatePickerFor(wk);
    }
  };

  const confirmMeetingDate = async () => {
    if (!datePickerFor || !pendingDate) return;
    const latestWeek = meetingWeeks.length ? [...meetingWeeks].sort().slice(-1)[0] : null;
    const isFrozen = meetingWeeks.includes(datePickerFor) && datePickerFor !== latestWeek;
    if (isFrozen && !isSuperAdmin(session)) {
      setDatePickerFor(null);
      setPendingDate("");
      return showToast("This meeting is frozen. Only the super admin can change it.", "#EF4444");
    }
    const { monday, sunday } = getWeekDateRange(datePickerFor);
    if (pendingDate < monday || pendingDate > sunday) {
      return showToast("Please choose a date within that week", "#F59E0B");
    }
    const updated = meetingWeeks.includes(datePickerFor) ? meetingWeeks : [...meetingWeeks, datePickerFor].sort();
    await persistMeetingWeeks(updated);
    await persistMeetingDates({ ...meetingDates, [datePickerFor]: pendingDate });
    showToast(`Meeting date set ✓`, "#22C55E");
    setDatePickerFor(null);
    setPendingDate("");
  };

  const addDept = async () => {
    if (!newDept.name.trim()) return showToast("Enter a category name", "#F59E0B");
    if (editDeptId) {
      if (departments.some(d => d.name === newDept.name.trim() && d.id !== editDeptId)) return showToast("Already exists", "#F59E0B");
      const updated = departments.map(d => d.id === editDeptId ? { ...d, name: newDept.name.trim(), description: newDept.description.trim(), comments: newDept.comments.trim() } : d).sort((a, b) => a.name.localeCompare(b.name));
      await persistDepartments(updated);
      setNewDept({ name: "", description: "", comments: "" });
      setEditDeptId(null);
      setShowAddDeptForm(false);
      showToast("Category updated ✓");
      return;
    }
    if (departments.some(d => d.name === newDept.name.trim())) return showToast("Already exists", "#F59E0B");
    const d = { id: "d" + Date.now(), name: newDept.name.trim(), description: newDept.description.trim(), comments: newDept.comments.trim() };
    const updated = [...departments, d].sort((a, b) => a.name.localeCompare(b.name));
    await persistDepartments(updated);
    setNewDept({ name: "", description: "", comments: "" });
    setShowAddDeptForm(false);
    showToast(`${d.name} added!`);
  };

  const openEditDept = (d) => {
    setEditDeptId(d.id);
    setNewDept({ name: d.name, description: d.description || "", comments: d.comments || "" });
    setShowAddDeptForm(true);
    setTimeout(() => deptFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };

  const cancelEditDept = () => {
    setEditDeptId(null);
    setNewDept({ name: "", description: "", comments: "" });
    setShowAddDeptForm(false);
  };

  const deleteDept = async (id) => {
    const dept = departments.find(d => d.id === id);
    await persistDepartments(departments.filter(d => d.id !== id));
    if (editDeptId === id) cancelEditDept();
    showToast(`${dept?.name} removed`, "#F59E0B");
  };
  const resetForm      = () => { setNewName(""); setNewPin(""); setNewRole("member"); setNewActive(true); setNewPhone(""); setNewEmail(""); setNewDepartment(""); setNewAddress(""); setNewPincode(""); setNewBusiness(""); setNewLocation(""); setNewPhotoUrl(""); setNewBizPhotoUrl(""); setShowAddForm(false); };

  const handleLogin = () => {
    let u;
    if (typeUsername) {
      u = users.find(x => x.name.toLowerCase() === usernameInput.trim().toLowerCase());
      if (!u) return showToast("User not found", "#F59E0B");
    } else {
      u = users.find(x => x.id === selUser);
      if (!u) return showToast("Select a member first", "#F59E0B");
    }
    if (u.active === false) return showToast("Account disabled. Contact admin.", "#EF4444");
    if (u.pin !== pinInput) return showToast("Wrong PIN", "#EF4444");
    if (meetingWeeks.length > 0) {
      const latestWeek = [...meetingWeeks].sort().slice(-1)[0];
      setWeekOffset(weekKeyToOffset(latestWeek));
    } else {
      setWeekOffset(0);
    }
    setSession(u); setScreen("home"); setPinInput(""); setSelUser(""); setUsernameInput("");
  };

  const markAttendance = async (uid, present) => {
    const wk = getWeekKey(weekOffset);
    const frozen = meetingWeeks.length > 0 && meetingWeeks.includes(wk) && wk !== [...meetingWeeks].sort().slice(-1)[0];
    if (frozen && !isSuperAdmin(session)) {
      return showToast("This meeting is frozen. Only the super admin can make changes.", "#EF4444");
    }
    const updated = { ...records, [wk]: { ...(records[wk] || {}), [uid]: present } };
    await persistRecords(updated);
    showToast(`${users.find(x => x.id === uid)?.name} marked ${present ? "Present ✓" : "Absent ✗"}`, present ? "#22C55E" : "#EF4444");
  };

  const addMember = async () => {
    if (!newName.trim() || newPin.length < 4) return showToast("Name and 4+ char PIN required", "#F59E0B");
    const fields = { name: newName.trim(), pin: newPin, role: newRole, active: newActive, phone: newPhone.trim(), email: newEmail.trim(), department: newDepartment.trim(), address: newAddress.trim(), pincode: newPincode.trim(), business: newBusiness.trim(), location: newLocation.trim(), photoUrl: newPhotoUrl.trim(), bizPhotoUrl: newBizPhotoUrl.trim() };
    try {
      const created = await addUserAtomic(fields);
      // Refresh local state from the source of truth after the atomic write
      const latest = await load("att:users");
      setUsers(latest || []);
      resetForm();
      showToast(`${created.name} added! (#${created.slNo})`);
    } catch (e) {
      console.error("addMember transaction failed:", e);
      showToast("Couldn't add member — please try again", "#EF4444");
    }
  };

  const deleteMember = async (uid) => { await persistUsers(users.filter(u => u.id !== uid)); showToast("Member removed", "#F59E0B"); };

  const toggleActive = async (uid) => {
    const updated = users.map(u => u.id === uid ? { ...u, active: !u.active } : u);
    await persistUsers(updated);
    const u = updated.find(x => x.id === uid);
    showToast(`${u.name} ${u.active ? "enabled ✓" : "disabled ✗"}`, u.active ? "#22C55E" : "#F59E0B");
  };

  const openEdit = (u) => {
    setEditUser(u);
    setEditFields({ name: u.name, pin: u.pin, role: u.role, active: u.active !== false, phone: u.phone || "", email: u.email || "", department: u.department || "", address: u.address || "", pincode: u.pincode || "", business: u.business || "", location: u.location || "", photoUrl: u.photoUrl || "", bizPhotoUrl: u.bizPhotoUrl || "", slNo: u.slNo !== undefined ? u.slNo : "", isSuperAdmin: u.isSuperAdmin === true });
  };

  const saveEdit = async () => {
    if (!editFields.name.trim()) return showToast("Name cannot be empty", "#F59E0B");
    if (editFields.pin.length < 4) return showToast("PIN must be at least 4 characters", "#F59E0B");
    // Only an existing super admin may grant or revoke the isSuperAdmin flag on someone else.
    // Anyone else's attempt to change it is silently ignored — the flag stays as it was.
    const isSuperAdminField = isSuperAdmin(session) ? editFields.isSuperAdmin === true : (editUser.isSuperAdmin === true);
    const targetIsSuperAdmin = isSuperAdminField || editUser.id === "u1";
    const parsedSlNo = targetIsSuperAdmin
      ? (editFields.slNo === "" || editFields.slNo === undefined ? editUser.slNo : parseInt(editFields.slNo, 10))
      : editUser.slNo; // never change slNo for anyone who isn't a super admin
    const updated = users.map(u => u.id === editUser.id ? { ...u, ...editFields, isSuperAdmin: isSuperAdminField, slNo: parsedSlNo } : u);
    await persistUsers(updated);
    if (session.id === editUser.id) setSession(s => ({ ...s, ...editFields, isSuperAdmin: isSuperAdminField, slNo: parsedSlNo }));
    setEditUser(null);
    showToast("Profile updated ✓");
  };

  if (loading) return (
    <div style={{ background: "#0F1117", minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#8888AA", fontFamily: "system-ui", gap: 16, padding: 24 }}>
      {loadError ? (
        <>
          <div style={{ fontSize: 40 }}>⚠️</div>
          <div style={{ color: "#F0F0F5", fontWeight: 700, fontSize: 18 }}>Connection Failed</div>
          <div style={{ color: "#8888AA", fontSize: 13, textAlign: "center" }}>Unable to reach Firebase. Check your internet or Firebase rules.</div>
          <button onClick={() => window.location.reload()} style={{ background: "#6C63FF", color: "#fff", border: "none", borderRadius: 12, padding: "12px 28px", fontSize: 15, fontWeight: 700, cursor: "pointer", marginTop: 8 }}>🔄 Retry</button>
        </>
      ) : (
        <>
          <img src={jenLogo} alt="JEN" style={{ width: 120, maxWidth: "60%" }} />
          <div style={{ color: "#F0F0F5", fontWeight: 700 }}>Loading JEN Track…</div>
          <div style={{ color: "#8888AA", fontSize: 13 }}>Loading Member List</div>
        </>
      )}
    </div>
  );

  const currentWeek   = getWeekKey(weekOffset);
  const weekRec       = records[currentWeek] || {};
  const weekBiz       = business[currentWeek] || {};
  const weekBizTotal  = Object.keys(weekBiz).reduce((s, gid) => s + getGiverEntries(business, currentWeek, gid).reduce((a, e) => a + (e.amount || 0), 0), 0);
  const grandBizTotal = Object.keys(business).reduce((s, wk) => s + Object.keys(business[wk] || {}).reduce((a, gid) => a + getGiverEntries(business, wk, gid).reduce((b, e) => b + (e.amount || 0), 0), 0), 0);
  const activeMembers = users.filter(u => u.id !== "u1" && u.active !== false);
  const latestMeetingWeek = meetingWeeks.length ? [...meetingWeeks].sort().slice(-1)[0] : null;
  // A meeting week is "frozen" for attendance marking once a later meeting week exists —
  // only the super admin may still edit it. The latest meeting week (or any non-meeting
  // week, e.g. before the first meeting is scheduled) is never frozen.
  const isWeekFrozen = latestMeetingWeek !== null && meetingWeeks.includes(currentWeek) && currentWeek !== latestMeetingWeek;
  const canMarkAttendance = !isWeekFrozen || isSuperAdmin(session);
  const presentCount  = activeMembers.filter(m => weekRec[m.id] === true).length;
  const absentCount   = activeMembers.filter(m => weekRec[m.id] === false).length;
  const unmarked      = activeMembers.length - presentCount - absentCount;

  const memberStats   = activeMembers.map(m => {
    let p = 0, a = 0, u = 0;
    meetingWeeks.forEach(w => { const v = (records[w] || {})[m.id]; if (v === true) p++; else if (v === false) a++; else u++; });
    const total = meetingWeeks.length || 1;
    const bizGiven = meetingWeeks.reduce((s, w) => s + getGiverEntries(business, w, m.id).reduce((a, e) => a + (e.amount || 0), 0), 0);
    const bizReceived = meetingWeeks.reduce((s, w) => {
      const wkBiz = business[w] || {};
      let total = 0;
      Object.keys(wkBiz).forEach(gid => { getGiverEntries(business, w, gid).forEach(e => { if (e.to === m.id) total += (e.amount || 0); }); });
      return s + total;
    }, 0);
    return { ...m, present: p, absent: a, unmarked: u, rate: Math.round((p / total) * 100), bizGiven, bizReceived };
  });

  const S = { fontFamily: "system-ui, sans-serif", background: "#0F1117", minHeight: "100vh", color: "#F0F0F5", maxWidth: 420, margin: "0 auto", padding: "0 0 80px" };

  // ── LOGIN ──
  if (screen === "login") return (
    <div style={{ ...S, display: "flex", flexDirection: "column", justifyContent: "center", padding: "40px 24px" }}>
      {toast && <Toast t={toast} />}
      <div style={{ textAlign: "center", marginBottom: 36 }}>
        <img src={jenLogo} alt="JEN" style={{ width: 180, maxWidth: "70%", marginBottom: 8 }} />
        <div style={{ color: "#8888AA", fontSize: 14, marginTop: 4 }}>Joint Entrepreneurs Network</div>
      </div>
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <Label>{typeUsername ? "Type Username" : "Select Member"}</Label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, color: "#8888AA" }}>
            <input type="checkbox" checked={typeUsername} onChange={e => { setTypeUsername(e.target.checked); setSelUser(""); setUsernameInput(""); }} style={{ accentColor: "#6C63FF", width: 15, height: 15 }} />
            Type name
          </label>
        </div>
        {typeUsername ? (
          <input value={usernameInput} onChange={e => setUsernameInput(e.target.value)} placeholder="Type your full name" style={{ ...inputStyle, marginBottom: 16 }} />
        ) : (
          <select value={selUser} onChange={e => setSelUser(e.target.value)} style={{ ...inputStyle, marginBottom: 16, color: selUser ? "#F0F0F5" : "#8888AA" }}>
            <option value="">— Choose your name —</option>
            {users.filter(u => u.id !== "u1" && u.active !== false).map(u => (
              <option key={u.id} value={u.id}>{u.name}{u.role !== "member" ? ` ${roleLabel(u.role)}` : ""}</option>
            ))}
          </select>
        )}
        <Label>PIN</Label>
        <Input value={pinInput} onChange={setPinInput} type="password" placeholder="Enter PIN" maxLength={8} />
        <div style={{ height: 16 }} />
        <Btn onClick={handleLogin}>Sign In</Btn>
      </Card>
    </div>
  );

  // ── HOME ──
  if (screen === "home") return (
    <div style={S}>
      {toast && <Toast t={toast} />}
      <EditModal editUser={editUser} editFields={editFields} setEditFields={setEditFields} setEditUser={setEditUser} saveEdit={saveEdit} sessionRole={session.role} sessionId={session.id} sessionIsSuperAdmin={isSuperAdmin(session)} departments={departments} />
      <WeekNav weekOffset={weekOffset} setWeekOffset={setWeekOffset} meetingWeeks={meetingWeeks} meetingDates={meetingDates} />
      <div style={{ padding: "20px 20px 12px" }}>
        <div style={{ color: "#8888AA", fontSize: 13 }}>Welcome back,</div>
        <H1>{session.name} {session.role === "admin" ? "👑" : session.role === "head_table" ? "🎖️" : ""}</H1>
      </div>
      {session.role === "member" && (
        <div style={{ padding: "0 20px 8px" }}>
          <div style={{ background: "#6C63FF22", border: "1px solid #6C63FF44", borderRadius: 12, padding: "10px 14px", fontSize: 13, color: "#6C63FF" }}>
            ℹ️ View your attendance history and edit your profile from the tabs below.
          </div>
        </div>
      )}
      <div style={{ padding: "0 20px" }}>
        {isPrivileged(session.role) ? (
          <>
            <Card>
              <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
                {[["✅", presentCount, "#22C55E", "Present"],["❌", absentCount, "#EF4444", "Absent"],["⏳", unmarked, "#F59E0B", "Unmarked"]].map(([icon, val, color, label]) => (
                  <div key={label} style={{ flex: 1, textAlign: "center", background: "#0F1117", borderRadius: 10, padding: "10px 4px" }}>
                    <div style={{ fontSize: 20 }}>{icon}</div>
                    <div style={{ fontSize: 22, fontWeight: 800, color }}>{val}</div>
                    <div style={{ fontSize: 10, color: "#8888AA" }}>{label}</div>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div style={{ fontSize: 13, color: "#8888AA", fontWeight: 600 }}>MEETING ATTENDANCE</div>
                <div style={{ fontSize: 13, color: "#F0F0F5", fontWeight: 700 }}>{getMeetingDateOrWeekLabel(currentWeek, weekOffset, meetingDates)}</div>
              </div>
              {[
                { label: "👑 Admin",      color: "#6C63FF", members: users.filter(u => u.role === "admin"      && u.active !== false) },
                { label: "🎖️ Head Table", color: "#F59E0B", members: users.filter(u => u.role === "head_table" && u.active !== false) },
                { label: "Members",       color: "#8888AA", members: activeMembers },
              ].filter(g => g.members.length > 0).map(group => (
                <div key={group.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #2A2D3A" }}>
                  <div style={{ fontSize: 14, color: group.color, fontWeight: 700 }}>{group.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: group.color }}>{group.members.length}</div>
                </div>
              ))}
            </Card>

            {meetingWeeks.length === 0 && (
              <Card>
                <div style={{ textAlign: "center", padding: "20px 0" }}>
                  <div style={{ fontSize: 36, marginBottom: 10 }}>📅</div>
                  <div style={{ fontWeight: 700, color: "#F59E0B", marginBottom: 6 }}>No Meeting Weeks Set</div>
                  <div style={{ fontSize: 13, color: "#8888AA" }}>Go to Manage → Meeting Weeks to select your meeting weeks.</div>
                </div>
              </Card>
            )}
            {meetingWeeks.length > 0 && (
              <>
                <Card>
                  <div style={{ fontSize: 13, color: "#8888AA", fontWeight: 600, marginBottom: 4 }}>
                    {meetingWeeks.includes(getWeekKey(weekOffset)) ? "THIS MEETING" : "SELECTED WEEK"}
                  </div>
                  <div style={{ fontSize: 11, color: "#8888AA", marginBottom: 12 }}>{getMeetingDateOrWeekLabel(currentWeek, weekOffset, meetingDates)}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
                    <Donut present={presentCount} absent={absentCount} unmarked={unmarked} total={activeMembers.length} />
                    <div style={{ flex: 1 }}>
                      {[["Present",presentCount,"#22C55E"],["Absent",absentCount,"#EF4444"],["Unmarked",unmarked,"#F59E0B"]].map(([l,v,c]) => (
                        <div key={l} style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                          <span style={{ color: "#8888AA", fontSize: 13 }}>{l}</span>
                          <span style={{ color: c, fontWeight: 700, fontSize: 15 }}>{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </Card>

                <Card>
                  {(() => {
                    const maxPage = Math.max(0, Math.ceil(meetingWeeks.length / 10) - 1);
                    const safePage = Math.min(homeChartPage, maxPage);
                    return (
                      <>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                          <div style={{ fontSize: 13, color: "#8888AA", fontWeight: 600 }}>
                            ALL MEETINGS ({meetingWeeks.length})
                          </div>
                          {meetingWeeks.length > 10 && (
                            <div style={{ display: "flex", gap: 6 }}>
                              <button onClick={() => setHomeChartPage(p => Math.max(0, Math.min(p, maxPage) - 1))} disabled={safePage === 0}
                                style={{ background: safePage === 0 ? "#1A1D27" : "#2A2D3A", border: "none", color: safePage === 0 ? "#3A3D4A" : "#F0F0F5", borderRadius: 6, padding: "3px 9px", fontSize: 13, cursor: safePage === 0 ? "not-allowed" : "pointer", fontWeight: 700 }}>‹‹</button>
                              <button onClick={() => setHomeChartPage(p => Math.min(maxPage, Math.min(p, maxPage) + 1))} disabled={safePage >= maxPage}
                                style={{ background: safePage >= maxPage ? "#1A1D27" : "#2A2D3A", border: "none", color: safePage >= maxPage ? "#3A3D4A" : "#F0F0F5", borderRadius: 6, padding: "3px 9px", fontSize: 13, cursor: safePage >= maxPage ? "not-allowed" : "pointer", fontWeight: 700 }}>››</button>
                            </div>
                          )}
                        </div>
                        <BarChart weeks={[...meetingWeeks].sort().slice(safePage * 10, safePage * 10 + 10)} records={records} members={activeMembers} selectedWeek={currentWeek} meetingDates={meetingDates} />
                      </>
                    );
                  })()}
                  <div style={{ display: "flex", gap: 16, marginTop: 8 }}>
                    <span style={{ fontSize: 11, color: "#8888AA" }}>■ <span style={{ color: "#22C55E" }}>Present</span></span>
                    <span style={{ fontSize: 11, color: "#8888AA" }}>■ <span style={{ color: "#EF4444" }}>Absent</span></span>
                  </div>
                </Card>

                <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "18px 0 10px" }}>
                  <div style={{ flex: 1, height: 1, background: "#2A2D3A" }} />
                  <div style={{ fontSize: 12, color: "#8888AA", fontWeight: 700, letterSpacing: ".5px", textTransform: "uppercase", whiteSpace: "nowrap" }}>Total Attendance Statistics</div>
                  <div style={{ flex: 1, height: 1, background: "#2A2D3A" }} />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
                  <Card style={{ marginBottom: 0 }}>
                    <div style={{ fontSize: 11, color: "#8888AA", marginBottom: 4 }}>ACTIVE MEMBERS</div>
                    <div style={{ fontSize: 30, fontWeight: 800, color: "#6C63FF" }}>{activeMembers.length}</div>
                    <div style={{ fontSize: 11, color: "#8888AA" }}>of {users.filter(u => u.id !== "u1").length} total</div>
                  </Card>
                  <Card style={{ marginBottom: 0, background: "#EF444411", border: "1px solid #EF444433" }}>
                    <div style={{ fontSize: 11, color: "#EF4444", marginBottom: 4, fontWeight: 700 }}>⚠️ BELOW 50%</div>
                    <div style={{ fontSize: 30, fontWeight: 800, color: "#EF4444" }}>{memberStats.filter(m => m.rate < 50).length}</div>
                    <div style={{ fontSize: 11, color: "#8888AA" }}>member{memberStats.filter(m => m.rate < 50).length !== 1 ? "s" : ""}</div>
                  </Card>
                </div>

                {memberStats.filter(m => m.rate < 50).length > 0 && (
                  <Card style={{ background: "#EF444411", border: "1px solid #EF444433" }}>
                    <div style={{ fontSize: 13, color: "#EF4444", fontWeight: 700, marginBottom: 12 }}>⚠️ NEEDS ATTENTION (below 50% attendance)</div>
                    {[...memberStats].filter(m => m.rate < 50).sort((a, b) => a.rate - b.rate).map(m => (
                      <div key={m.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: "1px solid #EF444433" }}>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>{m.name}</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 12, color: "#8888AA" }}>{m.present} / {meetingWeeks.length}</span>
                          <span style={{ background: "#EF444422", color: "#EF4444", borderRadius: 20, padding: "3px 11px", fontSize: 13, fontWeight: 800 }}>{m.rate}%</span>
                        </div>
                      </div>
                    ))}
                  </Card>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <Card>
              <div style={{ fontSize: 14, color: "#8888AA", fontWeight: 600, marginBottom: 12 }}>THIS WEEK</div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0" }}>
                <div style={{ fontWeight: 600, fontSize: 15 }}>{session.name}</div>
                {weekRec[session.id] === undefined
                  ? <span style={{ background: "#2A2D3A", color: "#8888AA", borderRadius: 20, padding: "3px 11px", fontSize: 12, fontWeight: 700 }}>Not marked</span>
                  : <Tag present={weekRec[session.id]} />}
              </div>
            </Card>

            {(() => {
              const mine = memberStats.find(m => m.id === session.id);
              const given = mine?.bizGiven || 0;
              const received = mine?.bizReceived || 0;
              return (
                <Card>
                  <div style={{ fontSize: 14, color: "#8888AA", fontWeight: 600, marginBottom: 12 }}>MY BUSINESS in JEN</div>
                  <div style={{ display: "flex", gap: 10 }}>
                    <div style={{ flex: 1, background: "#6C63FF11", border: "1px solid #6C63FF33", borderRadius: 10, padding: "12px 10px", textAlign: "center" }}>
                      <div style={{ fontSize: 18 }}>↗</div>
                      <div style={{ fontSize: 18, fontWeight: 800, color: "#6C63FF" }}>₹{given.toLocaleString("en-IN")}</div>
                      <div style={{ fontSize: 10, color: "#8888AA" }}>Given</div>
                    </div>
                    <div style={{ flex: 1, background: "#22C55E11", border: "1px solid #22C55E33", borderRadius: 10, padding: "12px 10px", textAlign: "center" }}>
                      <div style={{ fontSize: 18 }}>↙</div>
                      <div style={{ fontSize: 18, fontWeight: 800, color: "#22C55E" }}>₹{received.toLocaleString("en-IN")}</div>
                      <div style={{ fontSize: 10, color: "#8888AA" }}>Received</div>
                    </div>
                  </div>
                </Card>
              );
            })()}
          </>
        )}
      </div>
      <Nav screen={screen} session={session} setScreen={setScreen} setSession={setSession} />
    </div>
  );

  // ── ATTENDANCE ──
  if (screen === "mark") {
    if (!isPrivileged(session.role)) return (
      <div style={S}>
        {toast && <Toast t={toast} />}
        <div style={{ padding: "28px 20px" }}>
          <H1>Attendance</H1>
          <div style={{ background: "#EF444422", border: "1px solid #EF444444", borderRadius: 14, padding: 20, marginTop: 20, textAlign: "center" }}>
            <div style={{ fontSize: 36, marginBottom: 10 }}>🚫</div>
            <div style={{ fontWeight: 700, fontSize: 16, color: "#EF4444", marginBottom: 8 }}>Access Restricted</div>
            <div style={{ color: "#8888AA", fontSize: 13 }}>Only admins and head table can view attendance.</div>
          </div>
        </div>
        <Nav screen={screen} session={session} setScreen={setScreen} setSession={setSession} />
      </div>
    );

    const avgRate = memberStats.length ? Math.round(memberStats.reduce((s, m) => s + m.rate, 0) / memberStats.length) : 0;
    const best    = [...memberStats].sort((a, b) => b.rate - a.rate)[0];
    const worst   = [...memberStats].sort((a, b) => a.rate - b.rate)[0];

    return (
      <div style={S}>
        {toast && <Toast t={toast} />}
        <WeekNav weekOffset={weekOffset} setWeekOffset={setWeekOffset} meetingWeeks={meetingWeeks} meetingDates={meetingDates} />
        <div style={{ padding: "16px 20px 8px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <H1>✅ Attendance</H1>
          <div style={{ fontSize: 13, color: "#F0F0F5", fontWeight: 700 }}>{getMeetingDateOrWeekLabel(currentWeek, weekOffset, meetingDates)}</div>
        </div>

        <div style={{ display: "flex", gap: 6, padding: "0 20px 12px", overflowX: "auto" }}>
          {[["mark","Mark"],["members","Per Member"],["history","History"]].map(([t, label]) => (
            <button key={t} onClick={() => setAttTab(t)} style={{ background: attTab === t ? "#6C63FF" : "#2A2D3A", color: attTab === t ? "#fff" : "#8888AA", border: "none", borderRadius: 20, padding: "7px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>{label}</button>
          ))}
        </div>

        <div style={{ padding: "0 20px" }}>

          {attTab === "mark" && (
            <>
              {isWeekFrozen && (
                <Card style={{ background: "#F59E0B11", border: "1px solid #F59E0B44", marginBottom: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 22 }}>🔒</span>
                    <div>
                      <div style={{ fontSize: 13, color: "#F59E0B", fontWeight: 700 }}>This meeting is frozen</div>
                      <div style={{ fontSize: 12, color: "#8888AA" }}>
                        {canMarkAttendance
                          ? "You're viewing as super admin — editing is still allowed."
                          : "A newer meeting exists. Only the super admin can make changes here."}
                      </div>
                    </div>
                  </div>
                </Card>
              )}
              <Card style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 13, color: "#8888AA", fontWeight: 600, marginBottom: 12 }}>WEEK SUMMARY</div>
                <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
                  {[["✅", presentCount, "#22C55E", "Present"],["❌", absentCount, "#EF4444", "Absent"],["⏳", unmarked, "#F59E0B", "Unmarked"]].map(([icon, val, color, label]) => (
                    <div key={label} style={{ flex: 1, textAlign: "center", background: "#0F1117", borderRadius: 10, padding: "10px 4px" }}>
                      <div style={{ fontSize: 20 }}>{icon}</div>
                      <div style={{ fontSize: 22, fontWeight: 800, color }}>{val}</div>
                      <div style={{ fontSize: 10, color: "#8888AA" }}>{label}</div>
                    </div>
                  ))}
                </div>
              </Card>
              {[...activeMembers].sort((a, b) => (a.slNo || 0) - (b.slNo || 0)).map(m => {
                const status = weekRec[m.id];
                return (
                  <Card key={m.id}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 16 }}>#{m.slNo || "—"} &nbsp;{m.name}</div>
                        <div style={{ fontSize: 12, color: roleColor(m.role), fontWeight: 600 }}>{roleLabel(m.role)}</div>
                      </div>
                      {status !== undefined ? <Tag present={status} /> : <span style={{ background: "#2A2D3A", color: "#3A3D4A", borderRadius: 20, padding: "3px 11px", fontSize: 12, fontWeight: 700 }}>Not marked</span>}
                    </div>
                    <div style={{ display: "flex", gap: 10 }}>
                      <Btn onClick={() => markAttendance(m.id, true)}  disabled={!canMarkAttendance} style={{ background: status === true  ? "#22C55E" : "#2A2D3A", flex: 1, padding: "10px 0", fontSize: 14 }}>✅ Present</Btn>
                      <Btn onClick={() => markAttendance(m.id, false)} disabled={!canMarkAttendance} style={{ background: status === false ? "#EF4444" : "#2A2D3A", flex: 1, padding: "10px 0", fontSize: 14 }}>❌ Absent</Btn>
                    </div>
                  </Card>
                );
              })}
            </>
          )}

          {attTab === "members" && meetingWeeks.length > 0 && [...memberStats].sort((a, b) => (a.slNo || 0) - (b.slNo || 0)).map(m => (
            <Card key={m.id}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 16 }}>#{m.slNo || "—"} &nbsp;{m.name}</div>
                <span style={{ background: m.rate >= 70 ? "#22C55E22" : "#EF444422", color: m.rate >= 70 ? "#22C55E" : "#EF4444", borderRadius: 20, padding: "3px 11px", fontSize: 13, fontWeight: 800 }}>{m.rate}%</span>
              </div>
              <div style={{ background: "#2A2D3A", borderRadius: 99, height: 6, marginBottom: 10 }}>
                <div style={{ width: `${m.rate}%`, height: "100%", borderRadius: 99, background: m.rate >= 70 ? "#22C55E" : "#EF4444", transition: "width .4s" }} />
              </div>
              <div style={{ display: "flex", gap: 16, fontSize: 12, marginBottom: 10 }}>
                <span style={{ color: "#22C55E" }}>✅ {m.present}</span>
                <span style={{ color: "#EF4444" }}>❌ {m.absent}</span>
                <span style={{ color: "#F59E0B" }}>⏳ {m.unmarked}</span>
              </div>
              {(m.bizGiven > 0 || m.bizReceived > 0) && (
                <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                  {m.bizGiven > 0 && (
                    <div style={{ flex: 1, background: "#6C63FF11", border: "1px solid #6C63FF33", borderRadius: 8, padding: "6px 10px", fontSize: 12, color: "#6C63FF", fontWeight: 700 }}>
                      ↗ Given: ₹{m.bizGiven.toLocaleString("en-IN")}
                    </div>
                  )}
                  {m.bizReceived > 0 && (
                    <div style={{ flex: 1, background: "#22C55E11", border: "1px solid #22C55E33", borderRadius: 8, padding: "6px 10px", fontSize: 12, color: "#22C55E", fontWeight: 700 }}>
                      ↙ Received: ₹{m.bizReceived.toLocaleString("en-IN")}
                    </div>
                  )}
                </div>
              )}
              <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                {[...meetingWeeks].sort().map(w => {
                  const v = (records[w] || {})[m.id];
                  return <div key={w} title={w} style={{ width: 10, height: 10, borderRadius: "50%", background: v === true ? "#22C55E" : v === false ? "#EF4444" : "#2A2D3A" }} />;
                })}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#8888AA", marginTop: 4 }}>
                <span>First meeting</span><span>Latest</span>
              </div>
            </Card>
          ))}
          {attTab === "members" && meetingWeeks.length === 0 && (
            <Card>
              <div style={{ textAlign: "center", padding: "20px 0" }}>
                <div style={{ fontSize: 36, marginBottom: 10 }}>📅</div>
                <div style={{ fontWeight: 700, color: "#F59E0B", marginBottom: 6 }}>No Meeting Weeks Set</div>
                <div style={{ fontSize: 13, color: "#8888AA" }}>Go to Manage → Meeting Weeks to select your meeting weeks.</div>
              </div>
            </Card>
          )}

          {attTab === "history" && (
            <>
              <div style={{ fontSize: 13, color: "#8888AA", marginBottom: 14 }}>
                Week: <b style={{ color: "#F0F0F5" }}>{getMeetingDateOrWeekLabel(currentWeek, weekOffset, meetingDates)}</b>
              </div>
              <Card>
                <div style={{ fontSize: 14, color: "#8888AA", fontWeight: 600, marginBottom: 12 }}>ALL MEMBERS</div>
                {[...activeMembers].sort((a, b) => (a.slNo || 0) - (b.slNo || 0)).map(m => (
                  <div key={m.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #2A2D3A" }}>
                    <div style={{ fontWeight: 600 }}>#{m.slNo || "—"} &nbsp;{m.name}</div>
                    {weekRec[m.id] === undefined ? <span style={{ background: "#2A2D3A", color: "#8888AA", borderRadius: 20, padding: "3px 11px", fontSize: 12, fontWeight: 700 }}>No record</span> : <Tag present={weekRec[m.id]} />}
                  </div>
                ))}
                {activeMembers.length > 0 && (
                  <div style={{ marginTop: 14, fontSize: 13, color: "#8888AA" }}>
                    Present: <b style={{ color: "#22C55E" }}>{activeMembers.filter(m => weekRec[m.id] === true).length}</b> &nbsp;|&nbsp;
                    Absent: <b style={{ color: "#EF4444" }}>{activeMembers.filter(m => weekRec[m.id] === false).length}</b>
                  </div>
                )}
              </Card>
            </>
          )}

        </div>
        <Nav screen={screen} session={session} setScreen={setScreen} setSession={setSession} />
      </div>
    );
  }

  // ── BUSINESS ──
  if (screen === "biz") {
    return (
      <div style={S}>
        {toast && <Toast t={toast} />}
        <WeekNav weekOffset={weekOffset} setWeekOffset={setWeekOffset} meetingWeeks={meetingWeeks} meetingDates={meetingDates} disabled={bizView === "matrix" && reportScope === "all"} />
        <div style={{ padding: "16px 20px 8px" }}><H1>💰 Business</H1></div>
        <div style={{ padding: "0 20px" }}>
          <div style={{ display: "flex", gap: 8, marginTop: 14, marginBottom: 14 }}>
            {[["entry","✏️ Contribution"],["matrix","📊 Report"]].map(([t, label]) => (
              <button key={t} onClick={() => setBizView(t)} style={{ background: bizView === t ? "#6C63FF" : "#2A2D3A", color: bizView === t ? "#fff" : "#8888AA", border: "none", borderRadius: 20, padding: "7px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>{label}</button>
            ))}
          </div>

          {bizView === "entry" && (() => {
            const giver = activeMembers.find(m => m.id === session.id) || session;
            const takers = activeMembers.filter(x => x.id !== giver.id).sort((a, b) => (a.slNo || 0) - (b.slNo || 0));
            const recipientMap = getRecipientMap(currentWeek, giver.id);
            const selectedTakerId = takerSelect[giver.id] || "";
            const inputKey = selectedTakerId ? `${currentWeek}_${giver.id}_${selectedTakerId}` : "";
            const typedVal = inputKey && bizAmountInput[inputKey] !== undefined ? bizAmountInput[inputKey] : "";
            const savedAmt = selectedTakerId ? recipientMap[selectedTakerId] : undefined;
            const loggedEntries = takers.filter(t => recipientMap[t.id] > 0);

            return (
              <>
                <Card style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <div style={{ fontSize: 13, color: "#8888AA", fontWeight: 600 }}>WEEK TOTAL</div>
                    {isSuperAdmin(session) && (
                      !showClearWeekConfirm ? (
                        <button onClick={() => setShowClearWeekConfirm(true)} style={{ background: "#EF444422", border: "none", color: "#EF4444", borderRadius: 8, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>🗑 Clear This Week</button>
                      ) : (
                        <div style={{ display: "flex", gap: 6 }}>
                          <button onClick={() => { clearWeekBusiness(currentWeek); setShowClearWeekConfirm(false); }} style={{ background: "#EF4444", border: "none", color: "#fff", borderRadius: 8, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>Confirm</button>
                          <button onClick={() => setShowClearWeekConfirm(false)} style={{ background: "#2A2D3A", border: "none", color: "#8888AA", borderRadius: 8, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>Cancel</button>
                        </div>
                      )
                    )}
                  </div>
                  <div style={{ fontSize: 30, fontWeight: 800, color: "#22C55E" }}>₹{weekBizTotal.toLocaleString("en-IN")}</div>
                  <div style={{ minHeight: 18, marginTop: 6 }}>
                    {(() => {
                      const amounts = Object.keys(weekBiz).flatMap(gid => getGiverEntries(business, currentWeek, gid).map(e => e.amount || 0)).filter(a => a > 0);
                      return amounts.length > 0 ? (
                        <div style={{ fontSize: 11, color: "#8888AA", wordBreak: "break-word" }}>
                          {amounts.map(a => a.toLocaleString("en-IN")).join(" + ")}
                        </div>
                      ) : (
                        <div style={{ fontSize: 11, color: "#3A3D4A" }}>No contributions logged yet</div>
                      );
                    })()}
                  </div>
                  <div style={{ fontSize: 11, color: "#8888AA", marginTop: 8 }}>Grand total (all meetings): <b style={{ color: "#F0F0F5" }}>₹{grandBizTotal.toLocaleString("en-IN")}</b></div>
                </Card>

                <Card style={{ padding: 14, marginBottom: 14 }}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 11, color: "#8888AA", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".5px" }}>Giver</div>
                    <div style={{ fontSize: 18, fontWeight: 800 }}>{giver.name}</div>
                    <div style={{ fontSize: 11, color: roleColor(giver.role), fontWeight: 600 }}>{roleLabel(giver.role)}</div>
                  </div>
                </Card>

                <Card style={{ padding: 14, marginBottom: 14 }}>
                  {(() => {
                    const { spanWeekKeys, spanLabel } = computeMeetingSpan(currentWeek, meetingWeeks, meetingDates, weekOffset);
                    const giverSpanTotal = spanWeekKeys.reduce((s, w) => s + getGiverEntries(business, w, giver.id).reduce((a, e) => a + (e.amount || 0), 0), 0);
                    return (
                      <div style={{ fontSize: 13, color: "#8888AA", fontWeight: 600, marginBottom: 12 }}>
                        Total Contribution Made&nbsp;: <span style={{ color: "#22C55E", fontWeight: 800 }}>₹{giverSpanTotal.toLocaleString("en-IN")}</span>
                        <span style={{ fontSize: 11, color: "#8888AA", fontWeight: 400 }}> &nbsp;({spanLabel})</span>
                      </div>
                    );
                  })()}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <Label>Taker (recipient)</Label>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, color: showReceiversOnly ? "#6C63FF" : "#8888AA", fontWeight: 600 }}>
                      <input type="checkbox" checked={showReceiversOnly} onChange={e => setShowReceiversOnly(e.target.checked)}
                        style={{ accentColor: "#6C63FF", width: 14, height: 14 }} />
                      Receivers
                    </label>
                  </div>
                  <select value={selectedTakerId} onChange={e => setTakerSelect(f => ({ ...f, [giver.id]: e.target.value }))}
                    style={{ ...inputStyle, marginBottom: 12 }}>
                    <option value="">— Select taker —</option>
                    {(showReceiversOnly ? takers.filter(t => recipientMap[t.id] > 0) : takers).map(t => <option key={t.id} value={t.id}>{t.name}{recipientMap[t.id] > 0 ? ` (₹${recipientMap[t.id].toLocaleString("en-IN")})` : ""}</option>)}
                  </select>
                  {showReceiversOnly && takers.filter(t => recipientMap[t.id] > 0).length === 0 && (
                    <div style={{ fontSize: 12, color: "#8888AA", marginBottom: 12 }}>No entries logged for {giver.name.split(" ")[0]} yet this week.</div>
                  )}

                  {selectedTakerId && (
                    <>
                      {savedAmt > 0 && (
                        <div style={{ marginBottom: 8, fontSize: 12, color: "#22C55E", fontWeight: 800 }}>✓ Currently saved: ₹{savedAmt.toLocaleString("en-IN")}</div>
                      )}
                      <div style={{ display: "flex", gap: 8 }}>
                        <input type="text" inputMode="decimal" value={typedVal}
                          onChange={e => setBizAmountInput(f => ({ ...f, [inputKey]: e.target.value.replace(/[^0-9]/g, "") }))}
                          placeholder={savedAmt > 0 ? `Update amount (₹${savedAmt.toLocaleString("en-IN")})` : "₹ Amount"}
                          style={{ ...inputStyle, flex: 1, fontSize: 13, padding: "10px 10px" }} />
                        <button onClick={() => saveRecipientAmount(currentWeek, giver.id, selectedTakerId, typedVal)}
                          style={{ background: "#6C63FF", border: "none", color: "#fff", borderRadius: 10, padding: "0 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>💾 Save</button>
                      </div>
                    </>
                  )}
                </Card>

                {loggedEntries.length > 0 && (
                  <Card>
                    <div style={{ fontSize: 12, color: "#8888AA", fontWeight: 600, marginBottom: 10 }}>LOGGED THIS WEEK</div>
                    {loggedEntries.map(t => (
                      <div key={t.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #2A2D3A" }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{giver.name.split(" ")[0]} → {t.name}</div>
                        <span style={{ fontSize: 13, color: "#22C55E", fontWeight: 800 }}>₹{recipientMap[t.id].toLocaleString("en-IN")}</span>
                      </div>
                    ))}
                  </Card>
                )}
              </>
            );
          })()}

          {bizView === "matrix" && (() => {
            const sortedMembers = [...activeMembers].sort((a, b) => (a.slNo || 0) - (b.slNo || 0));
            const { prevMeetingWeek, spanWeekKeys, spanLabel } = computeMeetingSpan(currentWeek, meetingWeeks, meetingDates, weekOffset);

            const getTotalGivenTo = (giverId, recipientId) => {
              let total = 0;
              const weeksToScan = reportScope === "week" ? spanWeekKeys : Object.keys(business);
              weeksToScan.forEach(w => {
                getGiverEntries(business, w, giverId).forEach(e => { if (e.to === recipientId) total += (e.amount || 0); });
              });
              return total;
            };

            const rowTotals = sortedMembers.map(giver =>
              sortedMembers.reduce((s, rec) => s + (giver.id === rec.id ? 0 : getTotalGivenTo(giver.id, rec.id)), 0)
            );
            const colTotals = sortedMembers.map(rec =>
              sortedMembers.reduce((s, giver) => s + (giver.id === rec.id ? 0 : getTotalGivenTo(giver.id, rec.id)), 0)
            );
            const grand = rowTotals.reduce((s, v) => s + v, 0);

            const exportWeekPDF = () => {
              const weekGivenTo = (giverId, recipientId) => {
                let total = 0;
                spanWeekKeys.forEach(w => getGiverEntries(business, w, giverId).forEach(e => { if (e.to === recipientId) total += (e.amount || 0); }));
                return total;
              };
              const weekRowTotals = sortedMembers.map(giver =>
                sortedMembers.reduce((s, rec) => s + (giver.id === rec.id ? 0 : weekGivenTo(giver.id, rec.id)), 0)
              );
              const weekColTotals = sortedMembers.map(rec =>
                sortedMembers.reduce((s, giver) => s + (giver.id === rec.id ? 0 : weekGivenTo(giver.id, rec.id)), 0)
              );
              const weekGrand = weekRowTotals.reduce((s, v) => s + v, 0);

              if (weekGrand === 0) return showToast("No contributions to export for this week", "#F59E0B");

              // Inserts an explicit line break right after each thousand-separator comma,
              // so PDF cell wrapping (when the number doesn't fit on one line) always
              // breaks at "35," / "000" rather than an arbitrary mid-digit split like "35,00" / "0".
              const fmt = (v) => v ? v.toLocaleString("en-IN").replace(/,/g, ",\n") : "";

              const head = [["Giver \\ Recipient", ...sortedMembers.map(r => r.name), "Total (Given)"]];
              const body = sortedMembers.map((giver, ri) => [
                giver.name,
                ...sortedMembers.map(rec => giver.id === rec.id ? "" : fmt(weekGivenTo(giver.id, rec.id))),
                fmt(weekRowTotals[ri]),
              ]);
              const foot = [["Total (Received)", ...weekColTotals.map(fmt), fmt(weekGrand)]];

              const docPdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
              const pageWidth = docPdf.internal.pageSize.getWidth();

              docPdf.setFontSize(14);
              docPdf.setFont(undefined, "bold");
              docPdf.text("JEN Team, inter-Business Contribution", pageWidth / 2, 32, { align: "center" });
              docPdf.setFontSize(11);
              docPdf.setFont(undefined, "normal");
              docPdf.text(`Last week (${spanLabel})`, pageWidth / 2, 50, { align: "center" });

              const nameColCount = sortedMembers.length; // recipient name columns, excluding first (Giver) and last (Total) columns

              autoTable(docPdf, {
                head, body, foot,
                startY: 74,
                theme: "grid",
                styles: { fontSize: 8, cellPadding: 4, halign: "center", overflow: "linebreak" },
                headStyles: { fillColor: [108, 99, 255], textColor: 255, fontStyle: "bold", minCellHeight: 60, valign: "middle" },
                footStyles: { fillColor: [42, 45, 58], textColor: 255, fontStyle: "bold" },
                columnStyles: {
                  0: { halign: "left", fontStyle: "bold", cellWidth: 90, overflow: "linebreak" }, // Giver column: word-wrap only, no mid-word breaks
                },
                didParseCell: (data) => {
                  // Recipient name header cells (skip first "Giver \ Recipient" col and last "Total" col)
                  if (data.section === "head" && data.column.index > 0 && data.column.index <= nameColCount) {
                    data.cell.text = []; // suppress default horizontal text; we draw it rotated ourselves
                  }
                },
                didDrawCell: (data) => {
                  if (data.section === "head" && data.column.index > 0 && data.column.index <= nameColCount) {
                    const label = head[0][data.column.index];
                    const { x, y, width, height } = data.cell;
                    docPdf.setFont(undefined, "bold");
                    docPdf.setFontSize(8);
                    docPdf.setTextColor(255, 255, 255);
                    docPdf.text(label, x + width / 2, y + height - 6, { angle: 90, align: "left" });
                  }
                },
              });

              const finalY = docPdf.lastAutoTable.finalY || 74;
              docPdf.setFontSize(9);
              docPdf.setFont(undefined, "italic");
              docPdf.setTextColor(0, 0, 0);
              docPdf.text("Note: Any late arrivals are considered only for the upcoming weeks as accepted", 40, finalY + 24);

              docPdf.save(`contribution_matrix_${currentWeek}.pdf`);
              showToast("Exported contribution matrix PDF", "#22C55E");
            };

            const exportWeekCSV = () => {
              const weekGivenTo = (giverId, recipientId) => {
                let total = 0;
                spanWeekKeys.forEach(w => getGiverEntries(business, w, giverId).forEach(e => { if (e.to === recipientId) total += (e.amount || 0); }));
                return total;
              };
              const weekRowTotals = sortedMembers.map(giver =>
                sortedMembers.reduce((s, rec) => s + (giver.id === rec.id ? 0 : weekGivenTo(giver.id, rec.id)), 0)
              );
              const weekColTotals = sortedMembers.map(rec =>
                sortedMembers.reduce((s, giver) => s + (giver.id === rec.id ? 0 : weekGivenTo(giver.id, rec.id)), 0)
              );
              const weekGrand = weekRowTotals.reduce((s, v) => s + v, 0);

              if (weekGrand === 0) return showToast("No contributions to export for this week", "#F59E0B");

              const rows = [];
              rows.push([`JEN Team, inter-Business Contribution — Last week (${spanLabel})`]);
              rows.push([]);
              rows.push(["Giver \\ Recipient", ...sortedMembers.map(r => r.name), "Total (Given)"]);
              sortedMembers.forEach((giver, ri) => {
                const row = [giver.name];
                sortedMembers.forEach(rec => {
                  row.push(giver.id === rec.id ? "" : (weekGivenTo(giver.id, rec.id) || ""));
                });
                row.push(weekRowTotals[ri] || 0);
                rows.push(row);
              });
              rows.push(["Total (Received)", ...weekColTotals, weekGrand]);
              rows.push([]);
              rows.push(["Note: Any late arrivals are considered only for the upcoming weeks as accepted"]);

              const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
              const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `contribution_matrix_${currentWeek}.csv`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
              showToast("Exported contribution matrix CSV", "#22C55E");
            };

            return (
              <>
                <Card style={{ marginBottom: 14, textAlign: "center" }}>
                  <div style={{ fontSize: 13, color: "#8888AA", fontWeight: 600 }}>CONTRIBUTION GRAND TOTAL</div>
                  <div style={{ fontSize: 30, fontWeight: 800, color: "#22C55E" }}>₹{grand.toLocaleString("en-IN")}</div>
                  <div style={{ fontSize: 11, color: "#8888AA", marginTop: 6 }}>
                    {reportScope === "week"
                      ? (meetingDates[currentWeek]
                          ? `Meeting date: ${new Date(meetingDates[currentWeek] + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}`
                          : `Meeting week: ${getWeekLabel(weekOffset)}`)
                      : "All meeting weeks combined"}
                  </div>
                </Card>

                <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                  {[["week","Meeting Week"],["all","All Time"]].map(([t, label]) => (
                    <button key={t} onClick={() => setReportScope(t)} style={{ background: reportScope === t ? "#6C63FF" : "#2A2D3A", color: reportScope === t ? "#fff" : "#8888AA", border: "none", borderRadius: 20, padding: "7px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>{label}</button>
                  ))}
                </div>

                <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                  <button onClick={exportWeekCSV} style={{ flex: 1, background: "#6C63FF22", border: "none", color: "#6C63FF", borderRadius: 8, padding: "8px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>⬇ Export as CSV</button>
                  <button onClick={exportWeekPDF} style={{ flex: 1, background: "#6C63FF22", border: "none", color: "#6C63FF", borderRadius: 8, padding: "8px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>⬇ Export as PDF</button>
                </div>

                <Card style={{ padding: 12 }}>
                  <div style={{ fontSize: 14, color: "#8888AA", fontWeight: 600, marginBottom: 4 }}>REPORT</div>
                  <div style={{ fontSize: 11, color: "#8888AA", marginBottom: 10 }}>Rows = giver, Columns = recipient. Row total = given, Column total = received.</div>

                  <div style={{ overflow: "auto", maxWidth: "100%", maxHeight: "55vh", border: "1px solid #2A2D3A", borderRadius: 8 }}>
                    <table style={{ borderCollapse: "collapse", fontSize: 11, whiteSpace: "nowrap" }}>
                      <thead>
                        <tr>
                          <th style={{ position: "sticky", top: 0, left: 0, zIndex: 3, background: "#242838", color: "#F0F0F5", padding: "8px 10px", textAlign: "left", borderBottom: "2px solid #6C63FF", borderRight: "1px solid #2A2D3A", boxShadow: "0 2px 4px #0006" }}>Giver ↓ / Recipient →</th>
                          {sortedMembers.map((rec, ci) => (
                            <th key={rec.id} title={rec.name} style={{ position: "sticky", top: 0, zIndex: 2, background: "#242838", color: "#F0F0F5", padding: "8px 4px", borderBottom: "2px solid #6C63FF", textAlign: "center", minWidth: 34, maxWidth: 34, boxShadow: "0 2px 4px #0006" }}>
                              <div style={{ writingMode: "vertical-rl", transform: "rotate(180deg)", whiteSpace: "nowrap", fontSize: 10, fontWeight: 700, margin: "0 auto", maxHeight: 100, overflow: "hidden" }}>{rec.name}</div>
                            </th>
                          ))}
                          <th style={{ position: "sticky", top: 0, zIndex: 2, background: "#242838", color: "#6C63FF", padding: "8px 10px", borderBottom: "2px solid #6C63FF", textAlign: "right", boxShadow: "0 2px 4px #0006" }}>Given</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedMembers.map((giver, ri) => (
                          <tr key={giver.id}>
                            <td title={giver.name} style={{ position: "sticky", left: 0, zIndex: 1, background: "#1A1D27", padding: "6px 10px", borderBottom: "1px solid #2A2D3A", borderRight: "2px solid #6C63FF", fontWeight: 600, color: "#F0F0F5", boxShadow: "2px 0 4px #0006" }}>{giver.slNo || (ri + 1)}. {giver.name}</td>
                            {sortedMembers.map(rec => {
                              const isSelf = giver.id === rec.id;
                              const amt = isSelf ? 0 : getTotalGivenTo(giver.id, rec.id);
                              return (
                                <td key={rec.id} title={isSelf ? "" : `${giver.name} → ${rec.name}`} style={{ padding: "6px 8px", borderBottom: "1px solid #2A2D3A", textAlign: "center", background: isSelf ? "#0F1117" : "transparent", color: amt > 0 ? "#22C55E" : "#3A3D4A" }}>
                                  {isSelf ? "" : (amt > 0 ? amt.toLocaleString("en-IN") : "—")}
                                </td>
                              );
                            })}
                            <td style={{ padding: "6px 10px", borderBottom: "1px solid #2A2D3A", textAlign: "right", fontWeight: 700, color: rowTotals[ri] > 0 ? "#22C55E" : "#8888AA" }}>{rowTotals[ri] > 0 ? "₹" + rowTotals[ri].toLocaleString("en-IN") : "—"}</td>
                          </tr>
                        ))}
                        <tr>
                          <td style={{ position: "sticky", left: 0, zIndex: 1, background: "#1A1D27", padding: "8px 10px", borderRight: "1px solid #2A2D3A", fontWeight: 800, color: "#F0F0F5" }}>Received</td>
                          {colTotals.map((t, i) => (
                            <td key={i} style={{ padding: "8px 8px", textAlign: "center", fontWeight: 700, color: t > 0 ? "#F0F0F5" : "#3A3D4A" }}>{t > 0 ? t.toLocaleString("en-IN") : "—"}</td>
                          ))}
                          <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 800, color: "#22C55E", fontSize: 13 }}>₹{grand.toLocaleString("en-IN")}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <div style={{ fontSize: 11, color: "#8888AA", marginTop: 10 }}>Columns numbered 1–{sortedMembers.length} correspond to members in the same order as rows. Scroll to see all — row and column headers stay locked in place.</div>
                </Card>
              </>
            );
          })()}
        </div>
        <Nav screen={screen} session={session} setScreen={setScreen} setSession={setSession} />
      </div>
    );
  }

  // ── PROFILE ──
  if (screen === "profile") return (
    <div style={S}>
      {toast && <Toast t={toast} />}
      <EditModal editUser={editUser} editFields={editFields} setEditFields={setEditFields} setEditUser={setEditUser} saveEdit={saveEdit} sessionRole={session.role} sessionId={session.id} sessionIsSuperAdmin={isSuperAdmin(session)} departments={departments} />
      <div style={{ padding: "28px 20px 16px" }}>
        <H1>👤 My Profile</H1>
        <div style={{ color: "#8888AA", fontSize: 13 }}>View and edit your details</div>
      </div>
      <div style={{ padding: "0 20px" }}>
        <Card>
          {[["Name",session.name],["Role",roleLabel(session.role)],["Phone",session.phone||"—"],["Email",session.email||"—"],["Category",session.department||"—"],["Address",session.address||"—"],["Pincode",session.pincode||"—"],["Business",session.business||"—"]].map(([k,v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "9px 0", borderBottom: "1px solid #2A2D3A" }}>
              <span style={{ color: "#8888AA", fontSize: 13 }}>{k}</span>
              <span style={{ fontWeight: 600, fontSize: 14 }}>{v}</span>
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: "1px solid #2A2D3A" }}>
            <span style={{ color: "#8888AA", fontSize: 13 }}>Business Location</span>
            {session.location ? (
              <a href={session.location} target="_blank" rel="noopener noreferrer" style={{ color: "#6C63FF", fontSize: 13, fontWeight: 700, textDecoration: "none" }}>📍 View on Map</a>
            ) : (
              <span style={{ fontWeight: 600, fontSize: 14 }}>—</span>
            )}
          </div>
          <div style={{ height: 16 }} />
          <Btn onClick={() => openEdit(session)}>✏️ Edit My Profile</Btn>
        </Card>
      </div>
      <Nav screen={screen} session={session} setScreen={setScreen} setSession={setSession} />
    </div>
  );

  // ── HISTORY (member only) ──
  if (screen === "history" && !isPrivileged(session.role)) return (
    <div style={S}>
      {toast && <Toast t={toast} />}
      <div style={{ padding: "16px 20px 8px" }}><H1>📅 History</H1></div>
      <div style={{ padding: "0 20px" }}>
        <Card style={{ padding: "14px 16px" }}>
          <div style={{ fontSize: 12, color: "#8888AA", fontWeight: 600, marginBottom: 10 }}>MY ATTENDANCE HISTORY</div>
          {meetingWeeks.length === 0 ? (
            <div style={{ color: "#8888AA", fontSize: 13, padding: "8px 0" }}>No meeting weeks have been set yet.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", color: "#8888AA", fontWeight: 600, padding: "6px 0", borderBottom: "1px solid #2A2D3A", fontSize: 11 }}>WEEK</th>
                  <th style={{ textAlign: "right", color: "#8888AA", fontWeight: 600, padding: "6px 0", borderBottom: "1px solid #2A2D3A", fontSize: 11 }}>STATUS</th>
                </tr>
              </thead>
              <tbody>
                {[...meetingWeeks].sort().reverse().map(w => {
                  const isCurrent = w === getWeekKey(0);
                  const v = (records[w] || {})[session.id];
                  return (
                    <tr key={w}>
                      <td style={{ padding: "8px 0", borderBottom: "1px solid #2A2D3A", color: isCurrent ? "#6C63FF" : "#F0F0F5", fontWeight: isCurrent ? 700 : 400 }}>
                        {getWeekLabel(weekKeyToOffset(w))}
                        {isCurrent && <span style={{ fontSize: 10, marginLeft: 6, color: "#6C63FF" }}>← This week</span>}
                      </td>
                      <td style={{ padding: "8px 0", borderBottom: "1px solid #2A2D3A", textAlign: "right" }}>
                        {v === undefined ? <span style={{ background: "#2A2D3A", color: "#8888AA", borderRadius: 20, padding: "3px 11px", fontSize: 12, fontWeight: 700 }}>—</span> : <Tag present={v} />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      </div>
      <Nav screen={screen} session={session} setScreen={setScreen} setSession={setSession} />
    </div>
  );

  // ── ADMIN ──
  if (screen === "admin" && session.role === "admin") return (
    <div style={S}>
      {toast && <Toast t={toast} />}
      <EditModal editUser={editUser} editFields={editFields} setEditFields={setEditFields} setEditUser={setEditUser} saveEdit={saveEdit} sessionRole={session.role} sessionId={session.id} sessionIsSuperAdmin={isSuperAdmin(session)} departments={departments} />
      <ViewDetailsModal viewUser={viewUser} setViewUser={setViewUser} onEdit={openEdit} departments={departments} sessionRole={session.role} />
      <WeekNav weekOffset={weekOffset} setWeekOffset={setWeekOffset} meetingWeeks={meetingWeeks} meetingDates={meetingDates} />
      <div style={{ padding: "16px 20px 8px" }}><H1>⚙️ Manage</H1></div>

      {/* Sub-tabs */}
      <div style={{ display: "flex", gap: 8, padding: "0 20px 12px", overflowX: "auto" }}>
        {[["users","👥 Users"],["meetings","📅 Meeting Weeks"],["departments","🏢 Categories"]].map(([t, label]) => (
          <button key={t} onClick={() => setManageTab(t)} style={{ background: manageTab === t ? "#6C63FF" : "#2A2D3A", color: manageTab === t ? "#fff" : "#8888AA", border: "none", borderRadius: 20, padding: "8px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>{label}</button>
        ))}
      </div>

      <div style={{ padding: "0 20px" }}>
        {manageTab === "users" && (
          <>
            <Card>
              <div style={{ fontSize: 13, color: "#8888AA", fontWeight: 600, marginBottom: 12 }}>WEEK SUMMARY</div>
              <div style={{ display: "flex", gap: 10 }}>
                {[["✅", presentCount, "#22C55E", "Present"],["❌", absentCount, "#EF4444", "Absent"],["⏳", unmarked, "#F59E0B", "Unmarked"]].map(([icon, val, color, label]) => (
                  <div key={label} style={{ flex: 1, textAlign: "center", background: "#0F1117", borderRadius: 10, padding: "10px 4px" }}>
                    <div style={{ fontSize: 20 }}>{icon}</div>
                    <div style={{ fontSize: 22, fontWeight: 800, color }}>{val}</div>
                    <div style={{ fontSize: 10, color: "#8888AA" }}>{label}</div>
                  </div>
                ))}
              </div>
            </Card>
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontSize: 14, color: "#8888AA", fontWeight: 600 }}>ADD NEW MEMBER</div>
                <button onClick={() => { setShowAddForm(f => !f); if (showAddForm) resetForm(); }}
                  style={{ background: showAddForm ? "#EF444422" : "#6C63FF22", border: "none", color: showAddForm ? "#EF4444" : "#6C63FF", borderRadius: 8, padding: "6px 14px", fontSize: 13, cursor: "pointer", fontWeight: 700 }}>
                  {showAddForm ? "✕ Cancel" : "➕ Add Member"}
                </button>
              </div>
              {showAddForm && (
                <div style={{ marginTop: 16 }}>
                  <Label>Full Name</Label>
                  <Input value={newName} onChange={setNewName} placeholder="e.g. Jane Doe" />
                  <div style={{ height: 12 }} />
                  <Label>Member Photo (image URL)</Label>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12 }}>
                    {newPhotoUrl ? (
                      <img src={newPhotoUrl} alt="Member" style={{ width: 48, height: 48, borderRadius: "50%", objectFit: "cover", border: "1px solid #2A2D3A", flexShrink: 0 }} onError={e => { e.target.style.display = "none"; }} />
                    ) : (
                      <div style={{ width: 48, height: 48, borderRadius: "50%", background: "#0F1117", border: "1px solid #2A2D3A", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, color: "#3A3D4A", flexShrink: 0 }}>👤</div>
                    )}
                    <Input value={newPhotoUrl} onChange={setNewPhotoUrl} placeholder="Paste image URL" />
                  </div>
                  <Label>PIN (min 4 characters)</Label>
                  <Input value={newPin} onChange={setNewPin} type="text" placeholder="PIN" />
                  <div style={{ height: 12 }} />
                  <Label>Role & Status</Label>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                    <select value={newRole} onChange={e => setNewRole(e.target.value)} style={{ ...inputStyle, flex: 1 }}>
                      <option value="admin">👑 Admin</option>
                      <option value="head_table">🎖️ Head Table</option>
                      <option value="member">Member</option>
                    </select>
                    <Toggle checked={newActive} onChange={setNewActive} />
                  </div>
                  <Label>Phone</Label>
                  <Input value={newPhone} onChange={setNewPhone} placeholder="Phone number" />
                  <div style={{ height: 12 }} />
                  <Label>Email</Label>
                  <Input value={newEmail} onChange={setNewEmail} placeholder="Email address" />
                  <div style={{ height: 12 }} />
                  <Label>Category</Label>
                  <select value={newDepartment} onChange={e => setNewDepartment(e.target.value)} style={{ ...inputStyle, marginBottom: 0 }}>
                    <option value="">— Select Category —</option>
                    {departments.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
                  </select>
                  <div style={{ height: 12 }} />
                  <Label>Address</Label>
                  <Input value={newAddress} onChange={setNewAddress} placeholder="Address" />
                  <div style={{ height: 12 }} />
                  <Label>Pincode</Label>
                  <Input value={newPincode} onChange={setNewPincode} placeholder="Pincode" />
                  <div style={{ height: 12 }} />
                  <Label>Business</Label>
                  <Input value={newBusiness} onChange={setNewBusiness} placeholder="Business" />
                  <div style={{ height: 12 }} />
                  <Label>Business Location (Google Maps link)</Label>
                  <Input value={newLocation} onChange={setNewLocation} placeholder="Paste Google Maps link" />
                  <div style={{ height: 12 }} />
                  <Label>Business Photo (image URL)</Label>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12 }}>
                    {newBizPhotoUrl ? (
                      <img src={newBizPhotoUrl} alt="Business" style={{ width: 48, height: 48, borderRadius: 8, objectFit: "cover", border: "1px solid #2A2D3A", flexShrink: 0 }} onError={e => { e.target.style.display = "none"; }} />
                    ) : (
                      <div style={{ width: 48, height: 48, borderRadius: 8, background: "#0F1117", border: "1px solid #2A2D3A", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, color: "#3A3D4A", flexShrink: 0 }}>🏢</div>
                    )}
                    <Input value={newBizPhotoUrl} onChange={setNewBizPhotoUrl} placeholder="Paste image URL" />
                  </div>
                  <Btn onClick={addMember}>💾 Save Member</Btn>
                </div>
              )}
            </Card>
            {users.filter(u => u.id !== "u1").length === 0 && (
              <Card style={{ background: "#EF444422", border: "2px solid #EF4444" }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                  <span style={{ fontSize: 28 }}>🚨</span>
                  <div>
                    <div style={{ fontSize: 15, color: "#EF4444", fontWeight: 800, marginBottom: 4 }}>No members found!</div>
                    <div style={{ fontSize: 12, color: "#F0F0F5" }}>
                      Your team member list appears to be empty. If this is unexpected (you had members before), <b>do not add new members yet</b> — restore from your backup collection first to avoid losing historical attendance/contribution links. Contact your super admin immediately.
                    </div>
                  </div>
                </div>
              </Card>
            )}
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                <div style={{ fontSize: 14, color: "#8888AA", fontWeight: 600 }}>
                  TEAM MEMBERS &nbsp;
                  <span style={{ fontSize: 12, color: "#22C55E", fontWeight: 600 }}>Active {users.filter(u => u.id !== "u1" && u.active !== false).length}</span>
                  <span style={{ color: "#8888AA" }}> / </span>
                  <span style={{ fontSize: 12, color: "#EF4444", fontWeight: 600 }}>Inactive {users.filter(u => u.id !== "u1" && u.active === false).length}</span>
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, color: showInactive ? "#EF4444" : "#8888AA", fontWeight: 600 }}>
                  <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)}
                    style={{ accentColor: "#EF4444", width: 14, height: 14 }} />
                  Inactive only
                </label>
              </div>
              <input value={userSearch} onChange={e => setUserSearch(e.target.value)}
                placeholder="🔍 Search members..." style={{ ...inputStyle, marginBottom: 12 }} />
              {[...users]
                .filter(u => u.id !== "u1")
                .filter(u => showInactive ? u.active === false : true)
                .filter(u => u.name.toLowerCase().includes(userSearch.toLowerCase()) || (u.department||"").toLowerCase().includes(userSearch.toLowerCase()) || roleLabel(u.role).toLowerCase().includes(userSearch.toLowerCase()))
                .sort((a, b) => (a.slNo || 0) - (b.slNo || 0))
                .map(u => (
                <div key={u.id} style={{ padding: "12px 0", borderBottom: "1px solid #2A2D3A" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 11, color: "#8888AA", fontWeight: 700 }}>#{u.slNo || "—"}</span>
                        <div style={{ fontWeight: 700 }}>{u.name}</div>
                        {u.active === false && <span style={{ background: "#EF444422", color: "#EF4444", borderRadius: 10, padding: "2px 8px", fontSize: 10, fontWeight: 700 }}>DISABLED</span>}
                      </div>
                      <div style={{ fontSize: 12, color: roleColor(u.role), marginTop: 2 }}>{roleLabel(u.role)}</div>
                      {u.location && (
                        <a href={u.location} target="_blank" rel="noopener noreferrer"
                          style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "#6C63FF", marginTop: 4, textDecoration: "none", fontWeight: 600 }}>
                          📍 View on Map
                        </a>
                      )}
                      {u.phone && <div style={{ fontSize: 11, color: "#8888AA", marginTop: 4 }}>📞 {u.phone}</div>}
                      {u.email && <div style={{ fontSize: 11, color: "#8888AA" }}>✉️ {u.email}</div>}
                      {u.department && <div style={{ fontSize: 11, color: "#8888AA" }}>🏢 {u.department}</div>}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginLeft: 8, minWidth: 110 }}>
                      {confirmUserAction && confirmUserAction.uid === u.id ? (
                        <>
                          <div style={{ fontSize: 11, color: confirmUserAction.type === "remove" ? "#EF4444" : "#F59E0B", fontWeight: 700, textAlign: "right", marginBottom: 2 }}>
                            {confirmUserAction.type === "remove" ? "Remove this member?" : "Disable this member?"}
                          </div>
                          <button onClick={() => { confirmUserAction.type === "remove" ? deleteMember(u.id) : toggleActive(u.id); setConfirmUserAction(null); }}
                            style={{ background: confirmUserAction.type === "remove" ? "#EF4444" : "#F59E0B", color: "#fff", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 12, cursor: "pointer", fontWeight: 700 }}>
                            {confirmUserAction.type === "remove" ? "Yes, Remove" : "Yes, Disable"}
                          </button>
                          <button onClick={() => setConfirmUserAction(null)} style={{ background: "#2A2D3A", color: "#8888AA", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>Cancel</button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => setViewUser(u)} style={{ background: "#6C63FF22", color: "#6C63FF", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>👁️ View Details</button>
                          <button
                            onClick={() => u.active === false ? toggleActive(u.id) : setConfirmUserAction({ uid: u.id, type: "disable" })}
                            style={{ background: u.active === false ? "#22C55E22" : "#F59E0B22", color: u.active === false ? "#22C55E" : "#F59E0B", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>
                            {u.active === false ? "✓ Enable" : "⊘ Disable"}
                          </button>
                          <button onClick={() => setConfirmUserAction({ uid: u.id, type: "remove" })} style={{ background: "#EF444420", color: "#EF4444", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>🗑 Remove</button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </Card>
          </>
        )}

        {manageTab === "meetings" && (() => {
          // Generate last 26 weeks + next 4 weeks
          const allWeeks = Array.from({ length: 30 }, (_, i) => {
            const offset = i - 25;
            return { key: getWeekKey(offset), label: getWeekLabel(offset), offset, isCurrent: offset === 0 };
          }).reverse();
          return (
            <>
              <Card>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <div style={{ fontSize: 13, color: "#8888AA", fontWeight: 600 }}>SELECT MEETING WEEKS</div>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, color: showSelectedOnly ? "#22C55E" : "#8888AA", fontWeight: 600 }}>
                    <input type="checkbox" checked={showSelectedOnly} onChange={e => setShowSelectedOnly(e.target.checked)}
                      style={{ accentColor: "#22C55E", width: 14, height: 14 }} />
                    Selected only
                  </label>
                </div>
                <div style={{ fontSize: 12, color: "#8888AA", marginBottom: 14 }}>
                  Tap a week to toggle it as a meeting week. Selected weeks will be available for attendance marking.
                </div>
                <div style={{ fontSize: 13, color: "#6C63FF", fontWeight: 700, marginBottom: 10 }}>
                  {meetingWeeks.length} meeting week{meetingWeeks.length !== 1 ? "s" : ""} selected
                </div>
                {(() => {
                  const latestWeek = meetingWeeks.length ? [...meetingWeeks].sort().slice(-1)[0] : null;
                  return allWeeks.filter(w => showSelectedOnly ? meetingWeeks.includes(w.key) : true).map(w => {
                    const isSelected = meetingWeeks.includes(w.key);
                    const isFrozen = isSelected && w.key !== latestWeek;
                    const locked = isFrozen && !isSuperAdmin(session);
                    return (
                      <div key={w.key} style={{ borderBottom: "1px solid #2A2D3A" }}>
                        <div onClick={() => !locked && toggleMeetingWeek(w.key)}
                          style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", cursor: locked ? "not-allowed" : "pointer", opacity: locked ? 0.6 : 1 }}>
                          <div>
                            <div style={{ fontWeight: isSelected ? 700 : 400, color: isSelected ? "#F0F0F5" : "#8888AA", fontSize: 14 }}>
                              {w.label}
                              {w.isCurrent && <span style={{ fontSize: 10, color: "#6C63FF", marginLeft: 8, fontWeight: 700 }}>← This week</span>}
                              {isFrozen && <span style={{ fontSize: 10, color: "#F59E0B", marginLeft: 8, fontWeight: 700 }}>🔒 Frozen</span>}
                            </div>
                            <div style={{ fontSize: 11, color: "#8888AA" }}>{w.key}</div>
                          </div>
                          <div style={{
                            width: 24, height: 24, borderRadius: "50%",
                            background: isSelected ? "#22C55E" : "#2A2D3A",
                            border: `2px solid ${isSelected ? "#22C55E" : "#3A3D4A"}`,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontSize: 14, color: "#fff", flexShrink: 0,
                          }}>
                            {locked ? "🔒" : isSelected ? "✓" : ""}
                          </div>
                        </div>
                        {isSelected && meetingDates[w.key] && (
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: 10 }}>
                            <div style={{ fontSize: 12, color: "#6C63FF", fontWeight: 600 }}>
                              Meeting date: ({new Date(meetingDates[w.key] + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })})
                            </div>
                            {!locked && (
                              <button onClick={() => { setPendingDate(meetingDates[w.key]); setDatePickerFor(w.key); }}
                                style={{ background: "#6C63FF22", border: "none", color: "#6C63FF", borderRadius: 6, padding: "2px 8px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>✏️ Change</button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  });
                })()}
              </Card>

              <MeetingDateModal
                weekKey={datePickerFor}
                pendingDate={pendingDate}
                setPendingDate={setPendingDate}
                onConfirm={confirmMeetingDate}
                onCancel={() => { setDatePickerFor(null); setPendingDate(""); }}
              />
            </>
          );
        })()}

        {manageTab === "departments" && (
          <>
            <div ref={deptFormRef}>
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontSize: 14, color: "#8888AA", fontWeight: 600 }}>{editDeptId ? "EDIT CATEGORY" : "ADD CATEGORY"}</div>
                <button onClick={() => { if (showAddDeptForm) { cancelEditDept(); } else { setShowAddDeptForm(true); } }}
                  style={{ background: showAddDeptForm ? "#EF444422" : "#6C63FF22", border: "none", color: showAddDeptForm ? "#EF4444" : "#6C63FF", borderRadius: 8, padding: "6px 14px", fontSize: 13, cursor: "pointer", fontWeight: 700 }}>
                  {showAddDeptForm ? "✕ Cancel" : "➕ Add Category"}
                </button>
              </div>
              {showAddDeptForm && (
                <div style={{ marginTop: 16 }}>
                  <Label>Name</Label>
                  <input value={newDept.name} onChange={e => setNewDept(f => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. Sales" style={{ ...inputStyle, marginBottom: 12 }} />
                  <Label>Description</Label>
                  <input value={newDept.description} onChange={e => setNewDept(f => ({ ...f, description: e.target.value }))}
                    placeholder="Brief description" style={{ ...inputStyle, marginBottom: 12 }} />
                  <Label>Comments</Label>
                  <input value={newDept.comments} onChange={e => setNewDept(f => ({ ...f, comments: e.target.value }))}
                    placeholder="Any additional notes" style={{ ...inputStyle, marginBottom: 16 }} />
                  <Btn onClick={addDept}>{editDeptId ? "💾 Save Changes" : "➕ Add Category"}</Btn>
                </div>
              )}
            </Card>
            </div>
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div style={{ fontSize: 14, color: "#8888AA", fontWeight: 600 }}>
                  ALL CATEGORIES ({departments.length})
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, color: showUnassigned ? "#F59E0B" : "#8888AA", fontWeight: 600 }}>
                  <input type="checkbox" checked={showUnassigned} onChange={e => setShowUnassigned(e.target.checked)}
                    style={{ accentColor: "#F59E0B", width: 14, height: 14 }} />
                  Unassigned only
                </label>
              </div>
              <input value={deptSearch} onChange={e => setDeptSearch(e.target.value)}
                placeholder="🔍 Search categories..." style={{ ...inputStyle, marginBottom: 12 }} />
              {departments.length === 0 && <div style={{ color: "#8888AA", fontSize: 14 }}>No categories yet.</div>}
              {departments
                .filter(d => d.name.toLowerCase().includes(deptSearch.toLowerCase()) || (d.description||"").toLowerCase().includes(deptSearch.toLowerCase()))
                .filter(d => showUnassigned ? users.filter(u => u.department === d.name).length === 0 : true)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(d => (
                <div key={d.id} style={{ padding: "12px 0", borderBottom: "1px solid #2A2D3A" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: 15 }}>🏢 {d.name}</div>
                      {d.description && <div style={{ fontSize: 12, color: "#8888AA", marginTop: 2 }}>{d.description}</div>}
                      {d.comments && <div style={{ fontSize: 12, color: "#F59E0B", marginTop: 2 }}>💬 {d.comments}</div>}
                      <div style={{ fontSize: 11, color: "#8888AA", marginTop: 4 }}>
                        {users.filter(u => u.department === d.name).length} member{users.filter(u => u.department === d.name).length !== 1 ? "s" : ""}
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginLeft: 8 }}>
                      <button onClick={() => openEditDept(d)} style={{ background: "#6C63FF22", color: "#6C63FF", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>✏️ Edit</button>
                      <button onClick={() => deleteDept(d.id)} style={{ background: "#EF444420", color: "#EF4444", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>🗑 Remove</button>
                    </div>
                  </div>
                </div>
              ))}
            </Card>
          </>
        )}
      </div>
      <Nav screen={screen} session={session} setScreen={setScreen} setSession={setSession} />
    </div>
  );

  return null;
}
