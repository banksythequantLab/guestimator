// eBay after-sale care: tell the seller by email when a buyer opens a return, an "item not
// received" inquiry or a case, and (when the Message API scope is on) when a buyer sends a
// message. Slow answers hurt seller ratings and can auto-close a dispute in the buyer's favour.
//
// Returns / inquiries / cases: Post-Order API v2 (search, role SELLER), read with the seller's
// existing OAuth token. Messages: Message API (commerce/message/v1), which needs the
// commerce.message scope - only asked for when EBAY_MESSAGE_SCOPE="on", because adding a scope
// the app keyset hasn't been granted would break eBay sign-in for everyone.

import * as ebay from "./ebay.js";
import { sendAlert } from "./notify.js";

export const MESSAGE_SCOPE = "https://api.ebay.com/oauth/api_scope/commerce.message";
export const messagesOn = env => env.EBAY_MESSAGE_SCOPE === "on";
const API = "https://api.ebay.com";
const nowIso = (ms = Date.now()) => new Date(ms).toISOString();

// Post-Order takes the OAuth user token as "IAF <token>" (checked live 2026-10-02: Bearer gets
// 401, IAF gets 200). Bearer stays as the fallback in case eBay moves it to the standard scheme.
export async function postOrder(token, path, fetchImpl = fetch) {
  let last = null;
  for (const scheme of ["IAF", "Bearer"]) {
    const r = await fetchImpl(API + path, { headers: { authorization: `${scheme} ${token}`, accept: "application/json", "content-type": "application/json", "x-ebay-c-marketplace-id": "EBAY_US" } });
    const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    last = { ok: r.ok, status: r.status, json, scheme };
    if (r.status !== 401) return last;
  }
  return last;
}

const val = d => (d && (d.value || d.formattedValue)) || null;

/** Normalise one dispute from any of the three searches into one shape. */
export function disputeOf(kind, m) {
  if (kind === "return") return { kind, ext_id: String(m.returnId), order_id: m.orderId || null, item_id: m.creationInfo?.item?.itemId || null,
    state: m.state || m.status || null, reason: m.creationInfo?.reason || m.creationInfo?.reasonType || null, buyer: m.buyerLoginName || null,
    respond_by: val(m.sellerResponseDue?.respondByDate), action: m.sellerResponseDue?.activityDue || null };
  if (kind === "inquiry") return { kind, ext_id: String(m.inquiryId), order_id: null, item_id: m.itemId != null ? String(m.itemId) : null,
    state: m.inquiryStatusEnum || m.status || null, reason: "Item not received", buyer: m.buyer || null, respond_by: val(m.respondByDate), action: null };
  return { kind, ext_id: String(m.caseId), order_id: null, item_id: m.itemId != null ? String(m.itemId) : null,
    state: m.caseStatusEnum || m.status || null, reason: m.caseType || "Case", buyer: m.buyer || null, respond_by: val(m.respondByDate), action: null };
}

export const needsSeller = d => !!d.respond_by || /WAITING_SELLER|SELLER|REQUEST|ESCALAT/i.test(String(d.state || ""));

export const SEARCHES = [
  ["return", "/post-order/v2/return/search?role=SELLER&return_state=ALL_OPEN&limit=50", j => j.members || []],
  ["inquiry", "/post-order/v2/inquiry/search?limit=50", j => j.members || j.inquiries || []],
  ["case", "/post-order/v2/casemanagement/search?limit=50", j => j.members || j.cases || []],
];
const LABEL = { return: "Return request", inquiry: "Item not received", case: "eBay case" };
export const SELLER_HUB = "https://www.ebay.com/sh/ord";
export const MESSAGES_URL = "https://mesg.ebay.com/mesgweb/ViewMessages/0";

/** Is this dispute about something listed through Guestimator? (We don't watch the rest.) */
async function ours(db, userId, d) {
  if (d.item_id && await db.prepare("SELECT 1 FROM ebay_listings WHERE user_id=? AND listing_id=?").bind(userId, d.item_id).first()) return true;
  if (d.order_id && await db.prepare("SELECT 1 FROM ebay_orders WHERE user_id=? AND order_id=?").bind(userId, d.order_id).first()) return true;
  return false;
}

/** Reads open returns / inquiries / cases for one seller; emails on new ones and state changes. */
export async function checkDisputes(env, db, userId, email, token, origin, ms = Date.now(), fetchImpl = fetch) {
  const out = { new: 0, changed: 0, errors: [] };
  for (const [kind, path, pick] of SEARCHES) {
    const r = await postOrder(token, path, fetchImpl);
    if (!r.ok) { out.errors.push(`${kind} ${r.status}`); continue; }
    for (const m of pick(r.json || {})) {
      const d = disputeOf(kind, m);
      if (!d.ext_id || d.ext_id === "undefined" || !(await ours(db, userId, d))) continue;
      const id = `${kind}:${d.ext_id}`;
      const had = await db.prepare("SELECT * FROM ebay_disputes WHERE id=?").bind(id).first();
      if (!had) {
        await db.prepare("INSERT INTO ebay_disputes (id,user_id,kind,ext_id,order_id,item_id,state,reason,buyer,respond_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
          .bind(id, userId, kind, d.ext_id, d.order_id, d.item_id, d.state, d.reason, d.buyer, d.respond_by, nowIso(ms), nowIso(ms)).run();
        out.new++;
      } else if (had.state !== d.state || had.respond_by !== d.respond_by) {
        await db.prepare("UPDATE ebay_disputes SET state=?, respond_by=?, updated_at=? WHERE id=?").bind(d.state, d.respond_by, nowIso(ms), id).run();
        out.changed++;
      }
      const alertKey = `${d.state}|${d.respond_by || ""}`;
      if ((!had || had.alerted_state !== alertKey) && (!had || needsSeller(d))) {
        const title = await db.prepare("SELECT COALESCE(i.ai_title, i.name) t FROM ebay_listings l JOIN items i ON i.id=l.item_id WHERE l.user_id=? AND l.listing_id=?").bind(userId, d.item_id || "").first();
        const what = title?.t || "an item you sold";
        const due = d.respond_by ? ` Respond by ${String(d.respond_by).slice(0, 10)}.` : "";
        await sendAlert(env, { to: email, subject: `${LABEL[kind]}: ${what}`,
          text: `${had ? "Update on a" : "A buyer opened a"} ${LABEL[kind].toLowerCase()} on eBay for ${what}.\n\n` +
            `Status: ${String(d.state || "open").replace(/_/g, " ").toLowerCase()}${d.reason ? `\nReason: ${d.reason}` : ""}${d.buyer ? `\nBuyer: ${d.buyer}` : ""}\n${due}\n` +
            `Answer it in eBay Seller Hub (it can close in the buyer's favour if you don't):\n${SELLER_HUB}\n\nYour Guestimator orders: ${origin}/#ebay-orders` });
        await db.prepare("UPDATE ebay_disputes SET alerted_state=? WHERE id=?").bind(alertKey, id).run();
      }
    }
  }
  return out;
}

/**
 * New buyer messages about our listings/orders since the last check (Message API). Returns
 * { sent, scope_missing }. Unread conversations only; one email per conversation per new message.
 */
export async function checkMessages(env, db, userId, email, token, sinceIso, origin, ms = Date.now()) {
  const q = new URLSearchParams({ conversation_type: "FROM_MEMBERS", conversation_status: "UNREAD", limit: "10" });
  if (sinceIso) q.set("start_time", sinceIso);
  const r = await ebay.call(env, token, "GET", `/commerce/message/v1/conversation?${q}`);
  if (!r.ok) return { sent: 0, scope_missing: r.status === 403, status: r.status };
  let sent = 0;
  for (const c of (r.json && r.json.conversations) || []) {
    const m = c.latestMessage || {};
    if (!c.unreadCount || (sinceIso && m.createdDate && m.createdDate <= sinceIso)) continue;
    const ref = String(c.referenceId || "");
    const mine = ref && (await db.prepare("SELECT 1 FROM ebay_listings WHERE user_id=? AND listing_id=?").bind(userId, ref).first()
                      || await db.prepare("SELECT 1 FROM ebay_orders WHERE user_id=? AND order_id=?").bind(userId, ref).first());
    if (!mine) continue;
    const title = await db.prepare("SELECT COALESCE(i.ai_title, i.name) t FROM ebay_listings l JOIN items i ON i.id=l.item_id WHERE l.user_id=? AND l.listing_id=?").bind(userId, ref).first();
    const body = String(m.messageBody || (m.messageMedia && m.messageMedia.length ? "(sent a photo)" : "")).replace(/\s+/g, " ").trim().slice(0, 400);
    await sendAlert(env, { to: email, subject: `eBay message from ${m.senderUsername || "a buyer"}${title?.t ? ` about ${title.t}` : ""}`,
      text: `${m.senderUsername || "A buyer"} wrote:\n\n"${body}"\n\nReply on eBay (quick answers win sales and keep your rating up):\n${MESSAGES_URL}\n\nGuestimator: ${origin}/` });
    sent++;
  }
  return { sent, scope_missing: false };
}

export const CARE_EVERY_MIN = 55;

/** Cron: up to 15 sellers with Guestimator listings or orders, each about once an hour. */
export async function careSweep(env, db, origin, ms = Date.now()) {
  const due = nowIso(ms - CARE_EVERY_MIN * 60e3), recent = nowIso(ms - 120 * 86400e3);
  const { results } = await db.prepare(
    `SELECT a.user_id, a.care_checked_at, a.messages_checked_at, a.messages_ok, u.email FROM ebay_accounts a JOIN users u ON u.id=a.user_id
      WHERE (a.care_checked_at IS NULL OR a.care_checked_at<?) AND (EXISTS (SELECT 1 FROM ebay_listings l WHERE l.user_id=a.user_id AND l.status='published')
         OR EXISTS (SELECT 1 FROM ebay_orders o WHERE o.user_id=a.user_id AND o.ordered_at>=?))
      ORDER BY a.care_checked_at LIMIT 15`).bind(due, recent).all();
  const out = [];
  for (const a of results || []) {
    await db.prepare("UPDATE ebay_accounts SET care_checked_at=? WHERE user_id=?").bind(nowIso(ms), a.user_id).run();
    const t = await ebay.userToken(env, db, a.user_id);
    if (!t) { out.push({ user: a.user_id, skipped: "no token" }); continue; }
    const res = { user: a.user_id };
    try {
      res.disputes = await checkDisputes(env, db, a.user_id, a.email, t.token, origin, ms);
      await db.prepare("UPDATE ebay_accounts SET care_error=? WHERE user_id=?").bind(res.disputes.errors.join(", ") || null, a.user_id).run();
    } catch (e) { res.disputes_error = String(e.message || e); }
    if (messagesOn(env) && a.messages_ok !== 0) {
      try {
        const since = a.messages_checked_at || nowIso(ms - 60 * 60e3);
        res.messages = await checkMessages(env, db, a.user_id, a.email, t.token, since, origin, ms);
        await db.prepare("UPDATE ebay_accounts SET messages_checked_at=?, messages_ok=? WHERE user_id=?").bind(nowIso(ms), res.messages.scope_missing ? 0 : 1, a.user_id).run();
      } catch (e) { res.messages_error = String(e.message || e); }
    }
    out.push(res);
  }
  return out;
}
