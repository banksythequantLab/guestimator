// Run:  node worker/tests/ebaycare_test.mjs
// eBay after-sale care with Post-Order and Message API stubbed at fetch(). Proves: only disputes on
// Guestimator listings/orders are watched, the seller is emailed once per new dispute and again
// only when it needs them, and buyer messages are relayed once. NOT proven: eBay's real field
// names for a non-empty result (the live probe returned 0 open returns/inquiries/cases).
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as C from "../ebaycare.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got) : ""}`)); };

// ---------- pure ----------
const ret = C.disputeOf("return", { returnId: 5001, orderId: "O-1", creationInfo: { item: { itemId: "L1" }, reason: "Doesn't fit" }, buyerLoginName: "bob",
  state: "RETURN_REQUESTED", sellerResponseDue: { activityDue: "SELLER_APPROVE_REQUEST", respondByDate: { value: "2026-10-05T07:00:00.000Z" } } });
ok("return normalised", ret.ext_id === "5001" && ret.item_id === "L1" && ret.respond_by === "2026-10-05T07:00:00.000Z" && ret.reason === "Doesn't fit" && C.needsSeller(ret), ret);
ok("closed with no deadline doesn't need the seller", !C.needsSeller({ state: "CLOSED", respond_by: null }));

// ---------- stubs ----------
const calls = [], mails = [];
let returns = [], inquiries = [], cases = [], convos = [], msgStatus = 200;
const jr = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
globalThis.fetch = async (u, init = {}) => {
  const url = String(u); calls.push({ url, auth: init.headers?.authorization });
  if (url.includes("/post-order/") && !String(init.headers?.authorization).startsWith("IAF ")) return jr({ errors: [{ errorId: 1001 }] }, 401);
  if (url.includes("/post-order/v2/return/search")) return jr({ members: returns });
  if (url.includes("/post-order/v2/inquiry/search")) return jr({ members: inquiries });
  if (url.includes("/post-order/v2/casemanagement/search")) return jr({ members: cases });
  if (url.includes("/commerce/message/v1/conversation")) return msgStatus === 200 ? jr({ total: convos.length, conversations: convos }) : jr({ errors: [{ errorId: 1100 }] }, msgStatus);
  return jr({ error: "unstubbed " + url }, 404);
};
const db = d1(join(here, "..", "migrations"));
const env = { DB: db, EMAIL: { send: async m => { mails.push(m); return { messageId: "m" }; } } };
const now = new Date().toISOString();
db.raw.prepare("INSERT INTO items (id,sale_id,name,price_cents,created_at,ai_title) VALUES ('i1','s1','ram',0,?,'Intel Optane 280GB')").run(now);
db.raw.prepare("INSERT INTO ebay_listings (id,item_id,user_id,sku,status,listing_id,created_at,updated_at) VALUES ('el1','i1','u1','GUESS-1','published','L1',?,?)").run(now, now);
db.raw.prepare("INSERT INTO ebay_orders (id,order_id,line_item_id,user_id,item_id,title,status,ordered_at,created_at,updated_at) VALUES ('O-2:1','O-2','1','u1','i1','Optane','FULFILLED',?,?,?)").run(now, now, now);

// ---------- disputes ----------
returns = [{ returnId: 5001, orderId: "O-1", creationInfo: { item: { itemId: "L1" }, reason: "Doesn't fit" }, state: "RETURN_REQUESTED",
             sellerResponseDue: { respondByDate: { value: "2026-10-05T07:00:00.000Z" } } },
           { returnId: 5002, orderId: "O-9", creationInfo: { item: { itemId: "NOT-OURS" } }, state: "RETURN_REQUESTED" }];
inquiries = [{ inquiryId: 7001, itemId: "L1", inquiryStatusEnum: "WAITING_SELLER_RESPONSE", respondByDate: { value: "2026-10-04T00:00:00.000Z" } }];
let r = await C.checkDisputes(env, db, "u1", "seller@example.com", "TOK", "https://g.test");
ok("ours only: return + inquiry recorded, other seller's listing ignored", r.new === 2 && db.raw.prepare("SELECT COUNT(*) n FROM ebay_disputes").get().n === 2, r);
ok("Post-Order called with IAF token", calls.filter(c => c.url.includes("/post-order/")).every(c => c.auth === "IAF TOK"));
ok("seller emailed for each, with deadline and Seller Hub link", mails.length === 2 && mails.some(m => /^Return request: Intel Optane 280GB/.test(m.subject) && m.text.includes("Respond by 2026-10-05") && m.text.includes(C.SELLER_HUB)) &&
   mails.some(m => /^Item not received/.test(m.subject)), mails.map(m => m.subject));
r = await C.checkDisputes(env, db, "u1", "seller@example.com", "TOK", "https://g.test");
ok("nothing new -> no email", r.new === 0 && mails.length === 2);
returns[0].state = "RETURN_ESCALATED"; returns[0].sellerResponseDue = { respondByDate: { value: "2026-10-08T07:00:00.000Z" } };
inquiries[0].inquiryStatusEnum = "CLOSED"; delete inquiries[0].respondByDate;
r = await C.checkDisputes(env, db, "u1", "seller@example.com", "TOK", "https://g.test");
ok("escalation emails again; a close doesn't", r.changed === 2 && mails.length === 3 && /Update on a return request/.test(mails[2].text), mails.map(m => m.subject));
cases = [{ caseId: 9001, itemId: "L1", caseStatusEnum: "OPEN", caseType: "SNAD" }];
await C.checkDisputes(env, db, "u1", "seller@example.com", "TOK", "https://g.test");
ok("new case emailed", mails.length === 4 && /^eBay case/.test(mails[3].subject));

// ---------- messages ----------
mails.length = 0;
const since = new Date(Date.now() - 3600e3).toISOString(), fresh = new Date().toISOString();
convos = [
  { conversationId: "c1", unreadCount: 1, referenceId: "L1", referenceType: "LISTING", latestMessage: { messageBody: "Is this   still available?\nThanks", senderUsername: "bob", createdDate: fresh } },
  { conversationId: "c2", unreadCount: 1, referenceId: "OTHER", referenceType: "LISTING", latestMessage: { messageBody: "not ours", senderUsername: "x", createdDate: fresh } },
  { conversationId: "c3", unreadCount: 1, referenceId: "L1", latestMessage: { messageBody: "old", senderUsername: "y", createdDate: "2020-01-01T00:00:00.000Z" } },
  { conversationId: "c4", unreadCount: 0, referenceId: "L1", latestMessage: { messageBody: "read already", senderUsername: "z", createdDate: fresh } }];
r = await C.checkMessages(env, db, "u1", "seller@example.com", "TOK", since, "https://g.test");
ok("one email: unread, new, about our listing", r.sent === 1 && mails.length === 1 && /eBay message from bob about Intel Optane/.test(mails[0].subject) && mails[0].text.includes('"Is this still available? Thanks"'), { r, m: mails.map(x => x.subject) });
const mc = calls.filter(c => c.url.includes("/commerce/message/")).pop().url;
ok("asks for unread member conversations since the last check", mc.includes("conversation_type=FROM_MEMBERS") && mc.includes("conversation_status=UNREAD") && mc.includes("start_time="));
msgStatus = 403;
r = await C.checkMessages(env, db, "u1", "seller@example.com", "TOK", since, "https://g.test");
ok("no scope -> flagged, nothing sent", r.scope_missing === true && r.sent === 0);
ok("messages off unless EBAY_MESSAGE_SCOPE=on", !C.messagesOn({}) && C.messagesOn({ EBAY_MESSAGE_SCOPE: "on" }));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
