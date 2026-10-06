// In-app feedback (2026-10-06). Signed-in users send an idea, a problem or anything else from the
// app; the owner gets an email (reply goes straight to the sender) and works the list on /owner,
// setting each one to planned / done / declined with an optional note. The sender sees that status
// and note under "Your feedback", and gets one email when theirs is planned or done, so people can
// see their suggestions turn into features.

import { sendAlert } from "./notify.js";
import { adminEmail } from "./shipops.js";

export const KINDS = { idea: "Idea", bug: "Problem", other: "Other" };
export const STATUSES = { new: "Received", planned: "Planned", done: "Done", declined: "Not now" };
const PER_DAY = 10;
const nowIso = () => new Date().toISOString();

export async function submit(env, db, userId, b, origin, ms = Date.now()) {
  const kind = KINDS[b.kind] ? b.kind : "other";
  const message = String(b.message || "").trim().slice(0, 2000);
  if (message.length < 3) return { status: 400, error: "Tell us a bit more." };
  const since = new Date(ms - 86400e3).toISOString();
  const n = await db.prepare("SELECT COUNT(*) n FROM feedback WHERE user_id=? AND created_at>?").bind(userId, since).first();
  if (n.n >= PER_DAY) return { status: 429, error: "That's a lot of feedback for one day. Thank you! Try again tomorrow." };
  const id = crypto.randomUUID(), t = new Date(ms).toISOString();
  await db.prepare("INSERT INTO feedback (id,user_id,kind,message,page,app_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'new',?,?)")
    .bind(id, userId, kind, message, String(b.page || "").slice(0, 60) || null, String(b.version || "").slice(0, 20) || null, t, t).run();
  const u = await db.prepare("SELECT email FROM users WHERE id=?").bind(userId).first();
  const to = adminEmail(env);
  const mail = to ? await sendAlert(env, { to, replyTo: u?.email || undefined,
    subject: `Guestimator feedback (${KINDS[kind]}): ${message.slice(0, 60)}`,
    text: `${KINDS[kind]} from ${u?.email || "a user"}${b.page ? ` (screen: ${b.page})` : ""}:\n\n${message}\n\nReply to this email to answer them. Mark it planned or done at ${origin}/owner` }) : { sent: false };
  return { status: 200, id, emailed: !!mail.sent };
}

export const mine = async (db, userId) => (await db.prepare(
  "SELECT id, kind, message, status, owner_note, created_at, updated_at FROM feedback WHERE user_id=? ORDER BY created_at DESC LIMIT 50").bind(userId).all()).results;

export const ownerList = async db => (await db.prepare(
  `SELECT f.id, f.kind, f.message, f.page, f.status, f.owner_note, f.created_at, u.email FROM feedback f LEFT JOIN users u ON u.id=f.user_id
    ORDER BY (f.status='new') DESC, f.created_at DESC LIMIT 100`).all()).results;

/** Owner sets the status (and an optional note the sender sees). Planned / done tells the sender once. */
export async function setStatus(env, db, id, status, note, origin) {
  if (!STATUSES[status]) return { status: 400, error: "bad status" };
  const f = await db.prepare("SELECT f.*, u.email FROM feedback f LEFT JOIN users u ON u.id=f.user_id WHERE f.id=?").bind(String(id || "")).first();
  if (!f) return { status: 404, error: "not found" };
  const n = note === undefined ? f.owner_note : (String(note || "").trim().slice(0, 500) || null);
  await db.prepare("UPDATE feedback SET status=?, owner_note=?, updated_at=? WHERE id=?").bind(status, n, nowIso(), f.id).run();
  let emailed = false;
  if (status !== f.status && (status === "planned" || status === "done") && f.email) {
    const head = status === "done" ? "Your suggestion is live in Guestimator" : "Your suggestion is on our list";
    const r = await sendAlert(env, { to: f.email, subject: head,
      text: `${head}.\n\nYou wrote: "${f.message.slice(0, 300)}"${n ? `\n\nFrom us: ${n}` : ""}\n\nThanks for helping make Guestimator better. ${origin}` });
    emailed = !!r.sent;
  }
  return { status: 200, ok: true, emailed };
}