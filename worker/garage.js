// Garage, yard and estate sales: the seller's API, the public sale pages, hold requests, printable
// tags, and remote buying through Stripe Connect.
//
// Money path (Stripe Connect, DIRECT charges): the seller is the merchant. Checkout runs on the
// seller's own connected Stripe account (Stripe-Account header), their name is on the receipt, and
// they own refunds and disputes. Guestimator takes an application fee. Accounts are created with
// Stripe liable for negative balances (losses.payments = stripe), so Guestimator never holds a
// seller's money and is not on the hook when a seller cannot cover a dispute.
// Sale pages are free. Estimates still cost credits; nothing here touches the credits ledger.

import { startingPrice } from "./ebay.js";
import { holdAlert, orderAlert, buyerOrderEmail, buyerShippedEmail } from "./notify.js";

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
export const esc = s => String(s ?? "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
const money = c => "$" + (Number(c || 0) / 100).toFixed(2).replace(/\.00$/, "");
const J = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
const H = (html, status = 200, cache = "no-store") =>
  new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": cache } });
async function readJson(req) { try { return await req.json(); } catch { return {}; } }

export const KINDS = { garage: "Garage sale", yard: "Yard sale", estate: "Estate sale", moving: "Moving sale" };
const STATES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" "));
const ONLINE_MIN_CENTS = 100;       // Stripe's floor is 50c; a $1 floor keeps the fee meaningful
const HOLD_LIMIT_PER_HOUR = 5;      // per shopper IP, across all sales
const CHECKOUT_MINUTES = 30;        // Stripe's minimum session lifetime; the item is reserved this long

// ---------------------------------------------------------------- pure helpers (tested directly)

/** YYYY-MM-DD for `date` in the IANA zone `tz` (falls back to New York for a bad zone). */
export function localDate(date, tz) {
  const f = z => new Intl.DateTimeFormat("en-CA", { timeZone: z, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  try { return f(tz || "America/New_York"); } catch { return f("America/New_York"); }
}

/** upcoming | open | ended, by the sale's own calendar. */
export function phase(sale, date = new Date()) {
  const today = localDate(date, sale.tz);
  if (today < sale.starts_on) return "upcoming";
  if (today > sale.ends_on) return "ended";
  return "open";
}

/** The street address is private until the first day of the sale (in the sale's time zone). */
export function addressVisible(sale, date = new Date()) {
  return !!sale.street && phase(sale, date) !== "upcoming";
}

/** What a remote buyer pays for the item itself. */
export const onlinePrice = row => (row.online_price_cents != null ? row.online_price_cents : row.price_cents);

/** Platform fee in cents on the whole charge; bps = basis points (300 = 3%). */
export function feeCents(totalCents, bps) {
  const b = Number.isFinite(Number(bps)) ? Math.max(0, Math.min(2000, Number(bps))) : 300;
  return Math.round((totalCents * b) / 10000);
}

/** Cents from a user-typed dollar amount; null for blank, NaN for garbage. */
export function cents(v) {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN;
}

/** Validates and normalises the editable fields of a sale. Returns { ok, value } or { ok:false, error }. */
export function cleanSale(b, { partial = false } = {}) {
  const v = {};
  const has = k => b[k] !== undefined;
  const str = (k, max) => String(b[k] ?? "").trim().slice(0, max);
  if (!partial || has("title")) { v.title = str("title", 90); if (!v.title) return { ok: false, error: "Give the sale a title" }; }
  if (!partial || has("kind")) { v.kind = KINDS[b.kind] ? b.kind : "garage"; }
  if (has("description")) v.description = str("description", 2000) || null;
  if (has("street")) v.street = str("street", 120) || null;
  if (!partial || has("city")) { v.city = str("city", 60); if (!v.city) return { ok: false, error: "Enter the city" }; }
  if (!partial || has("state")) {
    v.state = str("state", 2).toUpperCase();
    if (!STATES.has(v.state)) return { ok: false, error: "Enter the two-letter state, e.g. NJ" };
  }
  if (has("zip")) { v.zip = str("zip", 10) || null; if (v.zip && !/^\d{5}(-\d{4})?$/.test(v.zip)) return { ok: false, error: "Enter a 5-digit ZIP code" }; }
  const d = /^\d{4}-\d{2}-\d{2}$/;
  if (!partial || has("starts_on")) { v.starts_on = str("starts_on", 10); if (!d.test(v.starts_on)) return { ok: false, error: "Pick the first day of the sale" }; }
  if (!partial || has("ends_on")) { v.ends_on = str("ends_on", 10) || v.starts_on; if (!d.test(v.ends_on)) return { ok: false, error: "Pick the last day of the sale" }; }
  if (v.starts_on && v.ends_on && v.ends_on < v.starts_on) return { ok: false, error: "The last day can't be before the first day" };
  if (has("hours")) v.hours = str("hours", 80) || null;
  if (has("tz")) { const tz = str("tz", 60); try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); v.tz = tz; } catch { /* keep default */ } }
  if (has("contact_phone")) v.contact_phone = str("contact_phone", 30) || null;
  for (const k of ["pickup_ok", "ship_ok", "online_ok"]) if (has(k)) v[k] = b[k] ? 1 : 0;
  return { ok: true, value: v };
}

export function newSlug(title) {
  const base = String(title || "sale").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "sale";
  const r = new Uint8Array(3); crypto.getRandomValues(r);
  return `${base}-${hex(r)}`;
}

/** Flattens a nested object into Stripe's form encoding (a[b][0][c]=v). */
export function stripeForm(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, val] of Object.entries(obj)) {
    if (val === undefined || val === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof val === "object") stripeForm(val, key, out);
    else out.append(key, String(val));
  }
  return out;
}

// Direct charges happen on the sellers' accounts, so their checkout events arrive on the Connect
// webhook endpoint; the platform endpoint secret is optional.
export const stripeReady = env => !!(env.STRIPE_SECRET_KEY && (env.STRIPE_CONNECT_WEBHOOK_SECRET || env.STRIPE_WEBHOOK_SECRET));

// ---------------------------------------------------------------- Stripe (raw REST, no SDK)

async function stripe(env, method, path, params, account) {
  const init = { method, headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } };
  if (account) init.headers["stripe-account"] = account;
  let url = `https://api.stripe.com${path}`;
  if (params && method === "GET") url += "?" + stripeForm(params);
  else if (params) { init.headers["content-type"] = "application/x-www-form-urlencoded"; init.body = stripeForm(params); }
  const r = await fetch(url, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Stripe ${r.status}`);
  return j;
}

async function hmacHex(secret, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
function timingEq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

/** Verifies a Stripe-Signature header against any of the given endpoint secrets (5-minute tolerance). */
export async function verifyStripeSig(secrets, rawBody, header, nowSec = Math.floor(Date.now() / 1000)) {
  if (!header) return false;
  const kv = header.split(",").map(s => s.split("="));
  const t = (kv.find(([k]) => k === "t") || [])[1];
  const sigs = kv.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !sigs.length || Math.abs(nowSec - Number(t)) > 300) return false;
  for (const s of secrets.filter(Boolean).map(x => String(x).trim())) {
    const expected = await hmacHex(s, `${t}.${rawBody}`);
    if (sigs.some(v => timingEq(v, expected))) return true;
  }
  return false;
}

/** Whether a connected account can be the merchant on a direct charge, from a v1 Account object. */
export const accountReady = acct => !!(acct && acct.charges_enabled && acct.details_submitted && acct.capabilities?.card_payments === "active");

// ---------------------------------------------------------------- data access

const THUMB = "(SELECT r2_key FROM photos p WHERE p.item_id=i.id ORDER BY p.sort, p.created_at LIMIT 1)";

// A checkout that was abandoned leaves its item 'pending'. Stripe tells us via
// checkout.session.expired, but a missed webhook must not strand the item, so anything pending for
// longer than the session can live is released whenever the sale is read.
async function releaseStale(db, saleId) {
  const cutoff = new Date(Date.now() - (CHECKOUT_MINUTES + 2) * 60000).toISOString();
  await db.prepare(
    "UPDATE garage_orders SET status='cancelled', note=COALESCE(note,'checkout expired'), updated_at=? " +
    "WHERE sale_id=? AND status='pending' AND created_at<?").bind(now(), saleId, cutoff).run();
  await db.prepare(
    "UPDATE garage_sale_items SET status='available' WHERE sale_id=? AND status='pending' AND NOT EXISTS " +
    "(SELECT 1 FROM garage_orders o WHERE o.sale_id=garage_sale_items.sale_id AND o.item_id=garage_sale_items.item_id AND o.status='pending')")
    .bind(saleId).run();
}

async function saleItems(db, saleId) {
  return (await db.prepare(
    `SELECT gi.*, i.name, i.ai_title, i.ai_description, i.description AS item_description, ${THUMB} AS thumb_key
     FROM garage_sale_items gi JOIN items i ON i.id=gi.item_id WHERE gi.sale_id=? ORDER BY gi.sort, gi.added_at`).bind(saleId).all()).results;
}

async function sellerStripe(db, userId) {
  return db.prepare("SELECT connect_account_id, stripe_payouts_ready, email FROM users WHERE id=?").bind(userId).first();
}

/** Can this sale take a card payment right now? */
function buyable(env, sale, seller) {
  return !!(stripeReady(env) && sale.online_ok && (sale.pickup_ok || sale.ship_ok) && seller?.connect_account_id && seller.stripe_payouts_ready);
}

// ---------------------------------------------------------------- seller API (/api/garage/*)

export async function sellerApi(request, env, url, parts, userId, ctx) {
  const db = env.DB, m = request.method;
  const origin = env.PUBLIC_ORIGIN || url.origin;
  const own = async sid => db.prepare("SELECT * FROM garage_sales WHERE id=? AND user_id=?").bind(sid, userId).first();

  // ----- Stripe Connect onboarding
  if (parts[2] === "stripe") {
    if (!env.STRIPE_SECRET_KEY) return J({ error: "Online payments aren't switched on yet." }, 503);
    let u = await sellerStripe(db, userId);
    if (parts[3] === "status" && m === "GET") {
      if (!u?.connect_account_id) return J({ connected: false, ready: false });
      const acct = await stripe(env, "GET", `/v1/accounts/${u.connect_account_id}`);
      const ready = accountReady(acct) ? 1 : 0;
      if (ready !== u.stripe_payouts_ready) await db.prepare("UPDATE users SET stripe_payouts_ready=? WHERE id=?").bind(ready, userId).run();
      return J({ connected: true, ready: !!ready, details_submitted: !!acct.details_submitted, currently_due: acct.requirements?.currently_due || [] });
    }
    if (parts[3] === "connect" && m === "POST") {
      if (!u?.connect_account_id) {
        const acct = await stripe(env, "POST", "/v1/accounts", {
          country: "US", email: u?.email || undefined,
          controller: { stripe_dashboard: { type: "full" }, fees: { payer: "account" }, losses: { payments: "stripe" } },
          capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
          business_profile: { product_description: "Garage, yard and estate sale items sold through Guestimator" },
          metadata: { guestimator_user: userId },
        });
        await db.prepare("UPDATE users SET connect_account_id=?, stripe_payouts_ready=0 WHERE id=?").bind(acct.id, userId).run();
        u = { ...u, connect_account_id: acct.id };
      }
      const link = await stripe(env, "POST", "/v1/account_links", {
        account: u.connect_account_id, type: "account_onboarding",
        refresh_url: `${origin}/#stripe-refresh`, return_url: `${origin}/#stripe-return`,
      });
      return J({ url: link.url });
    }
    if (parts[3] === "dashboard" && m === "POST") {
      if (!u?.connect_account_id) return J({ error: "Connect Stripe first" }, 409);
      // Full-dashboard accounts sign in to Stripe themselves; login links are Express-only.
      return J({ url: "https://dashboard.stripe.com/" });
    }
    return J({ error: "not found" }, 404);
  }

  // ----- holds and orders (by id)
  if (parts[2] === "holds" && parts[3] && m === "PATCH") {
    const h = await db.prepare("SELECT h.* FROM garage_holds h JOIN garage_sales s ON s.id=h.sale_id WHERE h.id=? AND s.user_id=?").bind(parts[3], userId).first();
    if (!h) return J({ error: "not found" }, 404);
    const b = await readJson(request);
    if (!["accepted", "declined", "done"].includes(b.status)) return J({ error: "bad status" }, 400);
    const stmts = [db.prepare("UPDATE garage_holds SET status=?, updated_at=? WHERE id=?").bind(b.status, now(), h.id)];
    if (b.status === "accepted")
      stmts.push(db.prepare("UPDATE garage_sale_items SET status='held' WHERE sale_id=? AND item_id=? AND status='available'").bind(h.sale_id, h.item_id));
    else
      stmts.push(db.prepare("UPDATE garage_sale_items SET status='available' WHERE sale_id=? AND item_id=? AND status='held' AND NOT EXISTS " +
        "(SELECT 1 FROM garage_holds x WHERE x.sale_id=? AND x.item_id=? AND x.status='accepted' AND x.id<>?)").bind(h.sale_id, h.item_id, h.sale_id, h.item_id, h.id));
    await db.batch(stmts);
    return J({ ok: true });
  }
  if (parts[2] === "orders" && parts[3] && m === "PATCH") {
    const o = await db.prepare("SELECT o.* FROM garage_orders o JOIN garage_sales s ON s.id=o.sale_id WHERE o.id=? AND s.user_id=?").bind(parts[3], userId).first();
    if (!o) return J({ error: "not found" }, 404);
    const b = await readJson(request);
    if (b.status === "fulfilled") {
      if (o.status !== "paid") return J({ error: o.status === "refund_needed" ? "Refund this buyer in Stripe instead." : "Only a paid order can be marked done." }, 409);
      await db.prepare("UPDATE garage_orders SET status='fulfilled', tracking=?, updated_at=? WHERE id=?").bind(String(b.tracking || "").trim().slice(0, 80) || null, now(), o.id).run();
      // A shipped order tells the buyer it's on the way. A pickup marked done needs no email:
      // the buyer was standing there.
      if (o.fulfilment === "ship" && ctx && ctx.waitUntil)
        ctx.waitUntil(buyerShippedEmail(db, env, o.id, env.PUBLIC_ORIGIN || url.origin).catch(e => console.log("buyerShippedEmail", e)));
      return J({ ok: true });
    }
    return J({ error: "bad status" }, 400);
  }

  // ----- sales
  if (parts[2] === "sales" && parts.length === 3) {
    if (m === "GET") {
      const { results } = await db.prepare(
        "SELECT s.*, (SELECT COUNT(*) FROM garage_sale_items gi WHERE gi.sale_id=s.id) AS items, " +
        "(SELECT COUNT(*) FROM garage_holds h WHERE h.sale_id=s.id AND h.status='new') AS new_holds, " +
        "(SELECT COUNT(*) FROM garage_orders o WHERE o.sale_id=s.id AND o.status IN ('paid','refund_needed')) AS open_orders " +
        "FROM garage_sales s WHERE s.user_id=? ORDER BY s.starts_on DESC, s.created_at DESC").bind(userId).all();
      return J(results.map(s => ({ ...s, url: `${origin}/sale/${s.slug}`, phase: phase(s) })));
    }
    if (m === "POST") {
      const c = cleanSale(await readJson(request));
      if (!c.ok) return J({ error: c.error }, 400);
      const id = uid(), t = now(), v = c.value;
      await db.prepare(
        "INSERT INTO garage_sales (id,user_id,slug,kind,title,description,street,city,state,zip,starts_on,ends_on,hours,tz,status,pickup_ok,ship_ok,online_ok,contact_phone,created_at,updated_at) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?,?,?)")
        .bind(id, userId, newSlug(v.title), v.kind, v.title, v.description ?? null, v.street ?? null, v.city, v.state, v.zip ?? null,
              v.starts_on, v.ends_on, v.hours ?? null, v.tz || "America/New_York", v.pickup_ok ?? 1, v.ship_ok ?? 0, v.online_ok ?? 0,
              v.contact_phone ?? null, t, t).run();
      return J({ id });
    }
  }

  if (parts[2] === "sales" && parts[3]) {
    const sale = await own(parts[3]);
    if (!sale) return J({ error: "not found" }, 404);
    const sid = sale.id;

    if (parts.length === 4 && m === "GET") {
      await releaseStale(db, sid);
      const items = await saleItems(db, sid);
      const holds = (await db.prepare("SELECT * FROM garage_holds WHERE sale_id=? ORDER BY created_at DESC LIMIT 200").bind(sid).all()).results;
      const orders = (await db.prepare("SELECT * FROM garage_orders WHERE sale_id=? AND status<>'pending' ORDER BY created_at DESC LIMIT 200").bind(sid).all()).results;
      const seller = await sellerStripe(db, userId);
      return J({ sale: { ...sale, url: `${origin}/sale/${sale.slug}`, phase: phase(sale) },
                 items: items.map(i => ({ ...i, thumb: i.thumb_key ? `/p/${i.thumb_key}` : null })),
                 holds, orders,
                 payments: { platform_on: stripeReady(env), connected: !!seller?.connect_account_id, ready: !!seller?.stripe_payouts_ready,
                             fee_bps: Number(env.GARAGE_FEE_BPS ?? 300) } });
    }
    if (parts.length === 4 && m === "PATCH") {
      const b = await readJson(request);
      const c = cleanSale(b, { partial: true });
      if (!c.ok) return J({ error: c.error }, 400);
      const v = c.value;
      if (b.status !== undefined) {
        if (!["draft", "published", "ended"].includes(b.status)) return J({ error: "bad status" }, 400);
        if (b.status === "published") {
          const n = await db.prepare("SELECT COUNT(*) AS n FROM garage_sale_items WHERE sale_id=?").bind(sid).first();
          if (!n.n) return J({ error: "Add at least one item before publishing." }, 409);
        }
        v.status = b.status;
      }
      const keys = Object.keys(v);
      if (!keys.length) return J({ ok: true });
      await db.prepare(`UPDATE garage_sales SET ${keys.map(k => `${k}=?`).join(",")}, updated_at=? WHERE id=?`)
        .bind(...keys.map(k => v[k]), now(), sid).run();
      return J({ ok: true });
    }
    if (parts.length === 4 && m === "DELETE") {
      const paid = await db.prepare("SELECT COUNT(*) AS n FROM garage_orders WHERE sale_id=? AND status IN ('paid','fulfilled','refund_needed')").bind(sid).first();
      if (paid.n) return J({ error: "This sale has online orders, so it's kept as a record. Mark it ended instead." }, 409);
      await db.batch([
        db.prepare("DELETE FROM garage_sale_items WHERE sale_id=?").bind(sid),
        db.prepare("DELETE FROM garage_holds WHERE sale_id=?").bind(sid),
        db.prepare("DELETE FROM garage_orders WHERE sale_id=?").bind(sid),
        db.prepare("DELETE FROM garage_sales WHERE id=?").bind(sid),
      ]);
      return J({ deleted: 1 });
    }

    // items in the sale
    if (parts[4] === "items" && parts.length === 5 && m === "POST") {
      const b = await readJson(request);
      const item = await db.prepare("SELECT i.* FROM items i JOIN sales s ON s.id=i.sale_id WHERE i.id=? AND s.user_id=?").bind(b.item_id, userId).first();
      if (!item) return J({ error: "item not found" }, 404);
      let price = cents(b.price);
      if (Number.isNaN(price)) return J({ error: "Enter a price like 25 or 7.50" }, 400);
      if (price === null) {
        const ap = await db.prepare("SELECT result_json FROM appraisals WHERE item_id=? AND status='done' ORDER BY created_at DESC LIMIT 1").bind(item.id).first();
        const sp = ap?.result_json ? startingPrice(JSON.parse(ap.result_json)) : null;
        price = sp ? Math.round(sp * 100) : (item.price_cents || 0);
      }
      const online = cents(b.online_price), ship = cents(b.ship);
      if (Number.isNaN(online) || Number.isNaN(ship)) return J({ error: "Enter prices like 25 or 7.50" }, 400);
      const max = await db.prepare("SELECT COALESCE(MAX(sort),0) AS s FROM garage_sale_items WHERE sale_id=?").bind(sid).first();
      await db.prepare("INSERT OR IGNORE INTO garage_sale_items (sale_id,item_id,price_cents,online_price_cents,ship_cents,status,sort,added_at) VALUES (?,?,?,?,?,'available',?,?)")
        .bind(sid, item.id, price, online, ship, (max.s || 0) + 1, now()).run();
      return J({ ok: true, price_cents: price });
    }
    if (parts[4] === "items" && parts[5]) {
      const row = await db.prepare("SELECT * FROM garage_sale_items WHERE sale_id=? AND item_id=?").bind(sid, parts[5]).first();
      if (!row) return J({ error: "not found" }, 404);
      if (m === "PATCH") {
        const b = await readJson(request), set = {};
        for (const [k, col] of [["price", "price_cents"], ["online_price", "online_price_cents"], ["ship", "ship_cents"]]) {
          if (b[k] === undefined) continue;
          const c = cents(b[k]);
          if (Number.isNaN(c)) return J({ error: "Enter prices like 25 or 7.50" }, 400);
          if (col === "price_cents" && c === null) return J({ error: "The tag price can't be blank" }, 400);
          set[col] = c;
        }
        if (b.status !== undefined) {
          if (!["available", "sold"].includes(b.status)) return J({ error: "bad status" }, 400);
          if (row.status === "pending") return J({ error: "Someone is paying for this online right now. Try again in a few minutes." }, 409);
          set.status = b.status; set.sold_at = b.status === "sold" ? now() : null;
        }
        const keys = Object.keys(set);
        if (keys.length) await db.prepare(`UPDATE garage_sale_items SET ${keys.map(k => `${k}=?`).join(",")} WHERE sale_id=? AND item_id=?`)
          .bind(...keys.map(k => set[k]), sid, row.item_id).run();
        return J({ ok: true });
      }
      if (m === "DELETE") {
        if (row.status === "pending") return J({ error: "Someone is paying for this online right now." }, 409);
        await db.prepare("DELETE FROM garage_sale_items WHERE sale_id=? AND item_id=?").bind(sid, row.item_id).run();
        return J({ deleted: 1 });
      }
    }
  }
  return J({ error: "not found" }, 404);
}

// ---------------------------------------------------------------- public API (/api/public/garage/*)

async function ipHash(request, env) {
  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  return (await hmacHex(env.HOLD_SALT || "guestimator-holds", ip)).slice(0, 24);
}

export async function publicApi(request, env, url, parts, ctx) {
  const db = env.DB, m = request.method, origin = env.PUBLIC_ORIGIN || url.origin;
  const cors = { "access-control-allow-origin": "*" };

  // Feed for directory sites (EstateDirectory): published, not ended, city-level only - never the street.
  if (parts[3] === "sales" && m === "GET") {
    const state = String(url.searchParams.get("state") || "").toUpperCase().slice(0, 2);
    const city = String(url.searchParams.get("city") || "").trim().slice(0, 60);
    const today = localDate(new Date(), "America/New_York");
    // A day of slack either side of "today" covers every US zone; phase() then decides exactly.
    const yesterday = localDate(new Date(Date.now() - 86400e3), "America/New_York");
    let sql = `SELECT s.slug, s.kind, s.title, s.city, s.state, s.zip, s.starts_on, s.ends_on, s.hours, s.tz,
      (SELECT COUNT(*) FROM garage_sale_items gi WHERE gi.sale_id=s.id) AS items,
      (SELECT ${THUMB.replace("i.id", "gi.item_id")} FROM garage_sale_items gi WHERE gi.sale_id=s.id ORDER BY gi.sort LIMIT 1) AS thumb_key
      FROM garage_sales s WHERE s.status='published' AND s.ends_on>=?`;
    const args = [yesterday];
    if (state) { sql += " AND s.state=?"; args.push(state); }
    if (city) { sql += " AND lower(s.city)=lower(?)"; args.push(city); }
    sql += " ORDER BY s.starts_on LIMIT 50";
    const rows = (await db.prepare(sql).bind(...args).all()).results.filter(s => phase(s) !== "ended");
    return J({ today, sales: rows.map(s => ({
      url: `${origin}/sale/${s.slug}`, kind: KINDS[s.kind] || "Sale", title: s.title, city: s.city, state: s.state, zip: s.zip,
      starts_on: s.starts_on, ends_on: s.ends_on, hours: s.hours, items: s.items, phase: phase(s),
      photo: s.thumb_key ? `${origin}/p/${s.thumb_key}` : null })) }, 200, { ...cors, "cache-control": "public, max-age=300" });
  }

  if (parts[3] === "hold" && m === "POST") {
    const b = await readJson(request);
    const sale = await db.prepare("SELECT * FROM garage_sales WHERE slug=? AND status='published'").bind(String(b.sale || "")).first();
    if (!sale || phase(sale) === "ended") return J({ error: "This sale isn't taking holds." }, 404);
    const row = await db.prepare("SELECT * FROM garage_sale_items WHERE sale_id=? AND item_id=?").bind(sale.id, String(b.item || "")).first();
    if (!row) return J({ error: "Item not found" }, 404);
    if (row.status === "sold") return J({ error: "Sorry, that one has sold." }, 409);
    const name = String(b.name || "").trim().slice(0, 60), phone = String(b.phone || "").trim().slice(0, 30);
    if (!name || phone.replace(/\D/g, "").length < 7) return J({ error: "Enter your name and a phone number the seller can reach." }, 400);
    const ih = await ipHash(request, env);
    const since = new Date(Date.now() - 3600e3).toISOString();
    const recent = await db.prepare("SELECT COUNT(*) AS n FROM garage_holds WHERE ip_hash=? AND created_at>?").bind(ih, since).first();
    if (recent.n >= HOLD_LIMIT_PER_HOUR) return J({ error: "That's a lot of holds for one hour. Please call the seller." }, 429);
    const t = now(), holdId = uid();
    await db.prepare("INSERT INTO garage_holds (id,sale_id,item_id,name,phone,note,status,ip_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,'new',?,?,?)")
      .bind(holdId, sale.id, row.item_id, name, phone, String(b.note || "").trim().slice(0, 300) || null, ih, t, t).run();
    // Tell the seller now, after the response - an email hiccup must never lose the hold.
    if (ctx && ctx.waitUntil) ctx.waitUntil(holdAlert(db, env, holdId, origin).catch(e => console.log("holdAlert", e)));
    return J({ ok: true });
  }

  if (parts[3] === "checkout" && m === "POST") {
    const form = request.headers.get("content-type")?.includes("json") ? await readJson(request) : Object.fromEntries(await request.formData());
    const sale = await db.prepare("SELECT * FROM garage_sales WHERE slug=? AND status='published'").bind(String(form.sale || "")).first();
    if (!sale || phase(sale) === "ended") return H(msgPage("This sale has ended", "Online buying is closed for this sale."), 404);
    const seller = await sellerStripe(db, sale.user_id);
    if (!buyable(env, sale, seller)) return H(msgPage("Online buying is off", "This seller isn't taking online payments. You can still ask them to hold it."), 409);
    const fulfil = form.fulfilment === "ship" ? "ship" : "pickup";
    if ((fulfil === "ship" && !sale.ship_ok) || (fulfil === "pickup" && !sale.pickup_ok)) return H(msgPage("Not available", "That delivery option isn't offered for this sale."), 400);
    await releaseStale(db, sale.id);
    const row = (await saleItems(db, sale.id)).find(r => r.item_id === String(form.item || ""));
    if (!row) return H(msgPage("Not found", "That item isn't in this sale."), 404);
    if (fulfil === "ship" && row.ship_cents == null) return H(msgPage("Pickup only", "The seller hasn't set shipping for this item."), 400);
    const itemC = onlinePrice(row), shipC = fulfil === "ship" ? row.ship_cents : 0, total = itemC + shipC;
    if (itemC < ONLINE_MIN_CENTS) return H(msgPage("Buy it at the sale", "This item is priced too low to pay for online."), 400);
    // Reserve atomically: only one buyer at a time can be paying for an item.
    const res = await db.prepare("UPDATE garage_sale_items SET status='pending' WHERE sale_id=? AND item_id=? AND status='available'").bind(sale.id, row.item_id).run();
    if (!res.meta?.changes) return H(msgPage("Not available right now", row.status === "sold" ? "Sorry, that one has sold." : "Someone else is holding or buying this item. Check back soon."), 409);
    const fee = feeCents(total, env.GARAGE_FEE_BPS ?? 300);
    const orderId = uid(), t = now();
    const title = row.ai_title || row.name;
    const back = `${origin}/sale/${sale.slug}/item/${row.item_id}`;
    try {
      const params = {
        mode: "payment",
        success_url: `${back}?paid=${orderId}`, cancel_url: `${back}?cancelled=1`,
        expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_MINUTES * 60 + 60,
        client_reference_id: orderId,
        phone_number_collection: { enabled: true },
        line_items: { 0: { quantity: 1, price_data: { currency: "usd", unit_amount: itemC,
          product_data: { name: title.slice(0, 250), images: row.thumb_key ? { 0: `${origin}/p/${row.thumb_key}` } : undefined,
                          description: `${KINDS[sale.kind] || "Sale"}: ${sale.title} (${sale.city}, ${sale.state}) - ${fulfil === "ship" ? "shipped" : "local pickup"}`.slice(0, 500) } } } },
        payment_intent_data: { application_fee_amount: fee,
                               metadata: { order_id: orderId, sale: sale.slug, item: row.item_id } },
        metadata: { order_id: orderId, sale: sale.slug, item: row.item_id },
      };
      if (fulfil === "ship") {
        params.shipping_address_collection = { allowed_countries: { 0: "US" } };
        params.shipping_options = { 0: { shipping_rate_data: { type: "fixed_amount", display_name: "Shipping", fixed_amount: { amount: shipC, currency: "usd" } } } };
      }
      const sess = await stripe(env, "POST", "/v1/checkout/sessions", params, seller.connect_account_id);
      await db.prepare("INSERT INTO garage_orders (id,sale_id,item_id,seller_account,stripe_session_id,fulfilment,item_cents,ship_cents,fee_cents,total_cents,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)")
        .bind(orderId, sale.id, row.item_id, seller.connect_account_id, sess.id, fulfil, itemC, shipC, fee, total, t, t).run();
      return Response.redirect(sess.url, 303);
    } catch (e) {
      await db.prepare("UPDATE garage_sale_items SET status='available' WHERE sale_id=? AND item_id=? AND status='pending'").bind(sale.id, row.item_id).run();
      return H(msgPage("Checkout didn't open", "Stripe said: " + String(e.message || e)), 502);
    }
  }

  if (parts[3] === "stripe-webhook" && m === "POST") {
    const raw = await request.text();
    if (!(await verifyStripeSig([env.STRIPE_WEBHOOK_SECRET, env.STRIPE_CONNECT_WEBHOOK_SECRET], raw, request.headers.get("stripe-signature"))))
      return J({ error: "bad signature" }, 400);
    const ev = JSON.parse(raw);
    const outcome = await applyStripeEvent(db, ev);
    // Only on the transition to paid: a replayed event returns "dup" and sends nothing twice.
    if ((outcome === "paid" || outcome === "refund_needed") && ctx && ctx.waitUntil) {
      const o = await db.prepare("SELECT id FROM garage_orders WHERE stripe_session_id=?").bind(ev.data?.object?.id || "").first();
      if (o) {
        ctx.waitUntil(orderAlert(db, env, o.id, origin).catch(e => console.log("orderAlert", e)));
        if (outcome === "paid") ctx.waitUntil(buyerOrderEmail(db, env, o.id, origin).catch(e => console.log("buyerOrderEmail", e)));
      }
    }
    return J({ received: true });
  }
  return J({ error: "not found" }, 404, cors);
}

/** Applies one verified Stripe event. Idempotent: replays and out-of-order delivery are harmless. */
export async function applyStripeEvent(db, ev) {
  const o = ev.data?.object || {};
  if (ev.type === "account.updated") {
    await db.prepare("UPDATE users SET stripe_payouts_ready=? WHERE connect_account_id=?").bind(accountReady(o) ? 1 : 0, o.id).run();
    return "account";
  }
  if (!String(ev.type).startsWith("checkout.session.")) return "ignored";
  const order = await db.prepare("SELECT * FROM garage_orders WHERE stripe_session_id=?").bind(o.id).first();
  if (!order) return "unknown";
  const t = now();
  if ((ev.type === "checkout.session.completed" && o.payment_status === "paid") || ev.type === "checkout.session.async_payment_succeeded") {
    if (order.status !== "pending" && order.status !== "cancelled") return "dup";
    // If the seller sold it in person while this buyer was on the Stripe page, the money is real
    // but the item is gone: record that loudly rather than pretending it shipped.
    const it = await db.prepare("SELECT status FROM garage_sale_items WHERE sale_id=? AND item_id=?").bind(order.sale_id, order.item_id).first();
    const clash = !it || it.status === "sold";
    const cd = o.customer_details || {};
    const ship = o.collected_information?.shipping_details || o.shipping_details || null;
    await db.batch([
      db.prepare("UPDATE garage_orders SET status=?, payment_intent=?, buyer_name=?, buyer_email=?, ship_address=?, note=?, updated_at=? WHERE id=?")
        .bind(clash ? "refund_needed" : "paid", o.payment_intent || null, cd.name || null, cd.email || null,
              ship ? JSON.stringify({ ...ship, phone: cd.phone || null }) : (cd.phone ? JSON.stringify({ phone: cd.phone }) : null),
              clash ? "Paid, but the item had already sold at the sale. Refund this buyer in Stripe." : null, t, order.id),
      ...(clash ? [] : [db.prepare("UPDATE garage_sale_items SET status='sold', sold_at=? WHERE sale_id=? AND item_id=?").bind(t, order.sale_id, order.item_id)]),
    ]);
    return clash ? "refund_needed" : "paid";
  }
  if (ev.type === "checkout.session.expired" || ev.type === "checkout.session.async_payment_failed") {
    if (order.status !== "pending") return "dup";
    await db.batch([
      db.prepare("UPDATE garage_orders SET status='cancelled', note=?, updated_at=? WHERE id=?").bind(ev.type.endsWith("expired") ? "checkout expired" : "payment failed", t, order.id),
      db.prepare("UPDATE garage_sale_items SET status='available' WHERE sale_id=? AND item_id=? AND status='pending'").bind(order.sale_id, order.item_id),
    ]);
    return "cancelled";
  }
  return "ignored";
}

// ---------------------------------------------------------------- public pages (/sale/*)

const CSS = `*{box-sizing:border-box}body{margin:0;font:16px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;color:#1d2a26;background:#f6f2ea}
a{color:#0f6b59}.wrap{max-width:980px;margin:0 auto;padding:0 16px}header{background:#0f6b59;color:#fff;padding:18px 0 22px}
header a{color:#fff;text-decoration:none}.kind{text-transform:uppercase;letter-spacing:.08em;font-size:.78rem;opacity:.85}
h1{font:700 1.9rem/1.2 Georgia,serif;margin:4px 0 8px}.when{font-size:1.02rem}.where{margin-top:4px;opacity:.95}
.note{background:#fff7d6;border:1px solid #eadca0;border-radius:10px;padding:10px 12px;margin:14px 0;color:#5a4a10}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:14px;margin:18px 0 40px}
.card{background:#fff;border-radius:12px;overflow:hidden;text-decoration:none;color:inherit;box-shadow:0 1px 3px rgba(0,0,0,.08);display:flex;flex-direction:column}
.card img{width:100%;aspect-ratio:1;object-fit:cover;background:#e8e2d6}.card .b{padding:9px 11px 12px}.card .t{font-size:.92rem;line-height:1.3;max-height:2.6em;overflow:hidden}
.card .p{font-weight:700;font-size:1.1rem;margin-top:4px}.tag{display:inline-block;font-size:.72rem;font-weight:700;border-radius:6px;padding:2px 7px;margin-top:6px}
.sold{opacity:.55}.tag.s{background:#e9e4dc;color:#5d5a52}.tag.h{background:#fde7c7;color:#7a4b00}.tag.o{background:#dff1ea;color:#0f6b59}
.item{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:22px;margin:22px 0 40px}@media(max-width:720px){.item{grid-template-columns:1fr}}
.gal img{width:100%;border-radius:12px;background:#e8e2d6;margin-bottom:10px}.price{font:700 2rem Georgia,serif;margin:6px 0}
.box{background:#fff;border-radius:12px;padding:14px 16px;margin:14px 0;box-shadow:0 1px 3px rgba(0,0,0,.08)}
label{display:block;font-size:.85rem;margin:8px 0 3px;color:#4b5a55}input,textarea,select{width:100%;padding:10px;border:1px solid #cfc8bb;border-radius:9px;font:inherit;background:#fff}
.btn{display:inline-block;border:0;border-radius:10px;padding:12px 18px;font:600 1rem system-ui;cursor:pointer;background:#0f6b59;color:#fff;text-decoration:none;margin-top:10px;width:100%;text-align:center}
.btn.alt{background:#fff;color:#0f6b59;border:1.5px solid #0f6b59}.muted{color:#6b7772;font-size:.88rem}footer{padding:24px 0 40px;color:#6b7772;font-size:.85rem}
.ok{background:#dff1ea;border:1px solid #b5dccd;border-radius:10px;padding:10px 12px;margin:14px 0}`;

function page({ title, desc, body, image, canonical }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">${image ? `<meta property="og:image" content="${esc(image)}">` : ""}
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ""}<link rel="icon" href="/icon.svg"><style>${CSS}</style></head><body>${body}
<footer><div class="wrap">Prices set with <a href="https://theguestimator.com">Guestimator</a>, which prices things from live eBay listings. Make your own sale page for free.</div></footer></body></html>`;
}
function msgPage(title, text) {
  return page({ title, desc: text, body: `<div class="wrap"><h1 style="margin-top:30px">${esc(title)}</h1><p>${esc(text)}</p><p><a href="javascript:history.back()">Go back</a></p></div>` });
}
const fmtDay = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
export function whenText(s) {
  const days = s.starts_on === s.ends_on ? fmtDay(s.starts_on) : `${fmtDay(s.starts_on)} – ${fmtDay(s.ends_on)}`;
  return s.hours ? `${days} · ${s.hours}` : days;
}
function whereHtml(s, reveal) {
  if (reveal) {
    const full = `${s.street}, ${s.city}, ${s.state}${s.zip ? " " + s.zip : ""}`;
    return `${esc(full)} · <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(full)}" target="_blank" rel="noopener">Map</a>`;
  }
  return `${esc(s.city)}, ${esc(s.state)}${s.zip ? " " + esc(s.zip) : ""}${s.street ? ` <span style="opacity:.8">· street address shows on ${esc(fmtDay(s.starts_on))}</span>` : ""}`;
}
function statusTag(r) {
  if (r.status === "sold") return `<span class="tag s">Sold</span>`;
  if (r.status === "held") return `<span class="tag h">On hold</span>`;
  if (r.status === "pending") return `<span class="tag h">Being bought</span>`;
  return "";
}

// Buyer's address as Stripe Checkout collected it: {name, phone, address:{line1,...}}.
export function shipToLines(json) {
  let a = null; try { a = JSON.parse(json || "null"); } catch {}
  if (!a) return [];
  const x = a.address || {};
  return [a.name, x.line1, x.line2, [x.city, [x.state, x.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", "),
          x.country && x.country !== "US" ? x.country : "", a.phone ? `Phone ${a.phone}` : ""].map(s => String(s || "").trim()).filter(Boolean);
}

// One printable page per online order: a packing slip to drop in the box, or a receipt to hand
// over (and have signed) at pickup. Money shown is what the buyer paid; the platform fee is the
// seller's business and stays off a page the buyer sees.
export function slipHtml(sale, o, title, ship) {
  const isShip = o.fulfilment === "ship";
  const to = shipToLines(o.ship_address);
  const from = [sale.title, sale.street, [sale.city, [sale.state, sale.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean);
  const day = String(o.updated_at || o.created_at || "").slice(0, 10);
  const ref = String(o.id).slice(0, 8).toUpperCase();
  const row = (k, v) => `<tr><td>${esc(k)}</td><td class="r">${esc(v)}</td></tr>`;
  const box = isShip && ship && Array.isArray(ship.box_in)
    // In the on-screen bar only (hidden when printed): it's a note for the seller, not the buyer.
    ? `<div style="font-size:.85rem;margin-top:4px;opacity:.9">Estimated ${esc(ship.box_in.join(" × "))} in box, about ${esc(String(ship.packed_weight_lb))} lb packed${ship.fragile ? ", fragile" : ""}. Weigh it before buying a label.</div>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${isShip ? "Packing slip" : "Pickup receipt"} ${esc(ref)}</title>
<style>@page{size:letter;margin:.6in}body{font-family:system-ui,sans-serif;color:#1d2521;margin:0}.bar{padding:12px;background:#0f6b59;color:#fff}.bar button{font:600 1rem system-ui;padding:8px 14px;border-radius:8px;border:0;margin-left:8px}
.pg{max-width:7in;margin:0 auto;padding:.3in}h1{font:700 1.6rem Georgia,serif;margin:0}.cols{display:flex;gap:.4in;margin:.25in 0}.cols div{flex:1}.lb{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:#6b7772}
.addr{font-size:1.05rem;line-height:1.4}table{width:100%;border-collapse:collapse;margin:.15in 0}td{padding:6px 0;border-bottom:1px solid #ddd}.r{text-align:right}.tot td{font-weight:700;border-bottom:2px solid #1d2521}
.m{color:#6b7772;font-size:.85rem}.sig{margin-top:.5in;display:flex;gap:.4in}.sig div{flex:1;border-top:1px solid #1d2521;padding-top:4px;font-size:.8rem;color:#6b7772}@media print{.bar{display:none}}</style></head>
<body><div class="bar">${isShip ? "Packing slip — put it in the box." : "Pickup receipt — hand it over when they collect."}<button onclick="print()">Print</button>${box}</div><div class="pg">
<h1>${isShip ? "Packing slip" : "Pickup receipt"}</h1><div class="m">Order ${esc(ref)} · paid online ${esc(day)}${o.status === "refund_needed" ? " · <b>REFUND DUE: do not send</b>" : ""}</div>
<div class="cols"><div><div class="lb">From</div><div class="addr">${from.map(esc).join("<br>")}</div></div>
<div><div class="lb">${isShip ? "Ship to" : "Buyer"}</div><div class="addr">${(isShip ? to : [o.buyer_name, o.buyer_email].filter(Boolean)).map(esc).join("<br>") || "—"}</div></div></div>
<table>${row(title, money(o.item_cents))}${isShip ? row("Shipping", o.ship_cents ? money(o.ship_cents) : "Free") : ""}<tr class="tot"><td>Paid</td><td class="r">${esc(money(o.total_cents))}</td></tr></table>
${o.tracking ? `<p><b>Tracking:</b> ${esc(o.tracking)}</p>` : ""}
${isShip ? `<p class="m">Questions about this order? Reply to your order email and it reaches the seller.</p>`
  : `<p class="m">Paid in full online. Pickup at ${esc(from.slice(1).join(", ") || sale.city)} · ${esc(whenText(sale))}.</p><div class="sig"><div>Picked up by (signature)</div><div>Date</div></div>`}
</div></body></html>`;
}

export async function salePages(request, env, url, parts, viewer) {
  const db = env.DB, origin = env.PUBLIC_ORIGIN || url.origin;
  const sale = await db.prepare("SELECT * FROM garage_sales WHERE slug=?").bind(parts[1] || "").first();
  // Drafts are visible only to their owner (the app previews them with the session cookie).
  if (!sale || (sale.status === "draft" && viewer !== sale.user_id)) return H(msgPage("Sale not found", "This sale doesn't exist or hasn't been published yet."), 404);
  await releaseStale(db, sale.id);
  const rows = await saleItems(db, sale.id);
  const ph = phase(sale), reveal = addressVisible(sale);
  const seller = await sellerStripe(db, sale.user_id);
  const canBuy = buyable(env, sale, seller) && ph !== "ended" && sale.status === "published";
  const kind = KINDS[sale.kind] || "Sale";
  const header = `<header><div class="wrap"><div class="kind">${esc(kind)}${sale.status === "draft" ? " · DRAFT (only you can see this)" : ""}</div>
<h1><a href="/sale/${esc(sale.slug)}">${esc(sale.title)}</a></h1><div class="when">${esc(whenText(sale))}</div><div class="where">${whereHtml(sale, reveal)}</div></div></header>`;
  const endedNote = ph === "ended" ? `<div class="note">This sale has ended.</div>` : "";

  // ----- printable tags (owner only)
  if (parts[2] === "tags") {
    if (viewer !== sale.user_id) return H(msgPage("Sign in first", "Open this from the Guestimator app to print tags."), 403);
    const tags = rows.filter(r => r.status !== "sold").map(r => `<div class="tg"><div class="q" data-u="${esc(`${origin}/sale/${sale.slug}/item/${r.item_id}`)}"></div>
<div class="tx"><div class="tp">${esc(money(r.price_cents))}</div><div class="tt">${esc((r.ai_title || r.name).slice(0, 70))}</div></div></div>`).join("");
    return H(`<!doctype html><html><head><meta charset="utf-8"><title>Price tags · ${esc(sale.title)}</title><script src="/vendor/qrcode.js"></script>
<style>@page{size:letter;margin:.4in}body{font-family:system-ui,sans-serif;margin:0}.bar{padding:12px;background:#0f6b59;color:#fff}.bar button{font:600 1rem system-ui;padding:8px 14px;border-radius:8px;border:0}
.sheet{display:grid;grid-template-columns:repeat(3,1fr);gap:.12in;padding:.1in}.tg{border:1.5px dashed #999;border-radius:8px;padding:.1in;display:flex;gap:.1in;align-items:center;height:1.55in;break-inside:avoid}
.q svg,.q img{width:1.1in;height:1.1in}.tp{font:800 26px Georgia,serif}.tt{font-size:11px;line-height:1.25;margin-top:4px;max-height:4em;overflow:hidden}@media print{.bar{display:none}}</style></head>
<body><div class="bar">${rows.length} tags for ${esc(sale.title)}. Each QR opens that item's page. <button onclick="print()">Print</button></div><div class="sheet">${tags}</div>
<script>document.querySelectorAll('.q').forEach(function(el){var q=qrcode(0,'M');q.addData(el.dataset.u);q.make();el.innerHTML=q.createSvgTag({cellSize:3,margin:0});});</script></body></html>`);
  }

  // ----- packing slip / pickup receipt for one online order (owner only)
  if (parts[2] === "slip" && parts[3]) {
    if (viewer !== sale.user_id) return H(msgPage("Sign in first", "Open this from the Guestimator app to print a slip."), 403);
    const o = await db.prepare("SELECT * FROM garage_orders WHERE id=? AND sale_id=?").bind(parts[3], sale.id).first();
    if (!o || !["paid", "fulfilled", "refund_needed"].includes(o.status)) return H(msgPage("Order not found", "Only paid online orders have a slip."), 404);
    const r = rows.find(x => x.item_id === o.item_id);
    const it = r || await db.prepare("SELECT name, ai_title FROM items WHERE id=?").bind(o.item_id).first();
    const ap = await db.prepare("SELECT result_json FROM appraisals WHERE item_id=? AND status='done' ORDER BY created_at DESC LIMIT 1").bind(o.item_id).first();
    let ship = null; try { ship = ap?.result_json ? JSON.parse(ap.result_json).shipping : null; } catch {}
    return H(slipHtml(sale, o, (it && (it.ai_title || it.name)) || "Item", ship));
  }

  // ----- one item
  if (parts[2] === "item" && parts[3]) {
    const r = rows.find(x => x.item_id === parts[3]);
    if (!r) return H(msgPage("Item not found", "It may have been removed from this sale."), 404);
    const photos = (await db.prepare("SELECT r2_key FROM photos WHERE item_id=? ORDER BY sort, created_at").bind(r.item_id).all()).results;
    const title = r.ai_title || r.name;
    const desc = r.ai_description || r.item_description || "";
    const onP = onlinePrice(r);
    const open = r.status === "available" && ph !== "ended" && sale.status === "published";
    const paid = url.searchParams.get("paid");
    let banner = "";
    if (paid) {
      const o = await db.prepare("SELECT status, fulfilment FROM garage_orders WHERE id=? AND item_id=?").bind(paid, r.item_id).first();
      banner = o && (o.status === "paid" || o.status === "pending")
        ? `<div class="ok"><b>Thank you, your payment went through.</b> ${o.fulfilment === "ship" ? "The seller will ship it to the address you gave Stripe." :
            `Pick it up at the sale: ${esc(sale.street ? `${sale.street}, ` : "")}${esc(sale.city)}, ${esc(sale.state)} · ${esc(whenText(sale))}. Bring your Stripe receipt.`}</div>`
        : o?.status === "refund_needed" ? `<div class="note">Your payment went through, but this item sold at the sale a moment earlier. The seller will refund you.</div>` : "";
    }
    if (url.searchParams.get("cancelled")) banner = `<div class="note">Checkout was cancelled. Nothing was charged.</div>`;
    const buyBox = !canBuy || !open ? "" : `<div class="box"><b>Buy it now</b>
<form method="post" action="/api/public/garage/checkout"><input type="hidden" name="sale" value="${esc(sale.slug)}"><input type="hidden" name="item" value="${esc(r.item_id)}">
${sale.pickup_ok ? `<label><input type="radio" name="fulfilment" value="pickup" style="width:auto" ${sale.pickup_ok ? "checked" : ""}> Pick up at the sale · ${esc(money(onP))}</label>` : ""}
${sale.ship_ok && r.ship_cents != null ? `<label><input type="radio" name="fulfilment" value="ship" style="width:auto" ${!sale.pickup_ok ? "checked" : ""}> Ship to me · ${esc(money(onP))} + ${r.ship_cents ? esc(money(r.ship_cents)) + " shipping" : "free shipping"}</label>` : ""}
${!sale.pickup_ok && (r.ship_cents == null || !sale.ship_ok) ? `<p class="muted">This item can't be shipped.</p>` : `<button class="btn">Pay securely with Stripe</button>`}
</form><p class="muted">Payment goes to the seller through Stripe. The item is reserved for you for ${CHECKOUT_MINUTES} minutes while you pay.</p></div>`;
    const holdBox = !open ? "" : `<div class="box"><b>Ask the seller to hold it</b><form id="hold"><label>Your name</label><input name="name" required maxlength="60">
<label>Phone</label><input name="phone" type="tel" required maxlength="30"><label>Note (optional)</label><input name="note" maxlength="300" placeholder="e.g. I can come Saturday at 9">
<button class="btn alt">Send hold request</button></form><p class="muted" id="hmsg">The seller gets your name and number and decides. It isn't held until they say so.</p></div>
<script>document.getElementById('hold').onsubmit=async function(e){e.preventDefault();var f=new FormData(this),m=document.getElementById('hmsg');m.textContent='Sending...';
var r=await fetch('/api/public/garage/hold',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sale:${JSON.stringify(sale.slug)},item:${JSON.stringify(r.item_id)},name:f.get('name'),phone:f.get('phone'),note:f.get('note')})});
var j=await r.json().catch(function(){return{}});m.textContent=r.ok?'Sent. The seller will get back to you.':(j.error||'That did not go through.');if(r.ok)this.reset();};</script>`;
    const onlineLine = canBuy && onP !== r.price_cents ? `<div class="muted">At the sale: ${esc(money(r.price_cents))} · Online: ${esc(money(onP))}</div>` : "";
    const body = `${header}<div class="wrap">${banner}${endedNote}<p><a href="/sale/${esc(sale.slug)}">← All items in this sale</a></p><div class="item">
<div class="gal">${photos.map(p => `<img src="/p/${esc(p.r2_key)}" alt="${esc(title)}" loading="lazy">`).join("") || `<div class="muted">No photo</div>`}</div>
<div><h2 style="font:700 1.5rem/1.25 Georgia,serif;margin:0">${esc(title)}</h2><div class="price">${esc(money(r.price_cents))}</div>${onlineLine}${statusTag(r)}
${desc ? `<p style="white-space:pre-line">${esc(desc)}</p>` : ""}${buyBox}${holdBox}</div></div></div>`;
    return H(page({ title: `${title} · ${money(r.price_cents)} · ${sale.title}`, desc: `${kind} in ${sale.city}, ${sale.state}. ${whenText(sale)}.`,
      image: photos[0] ? `${origin}/p/${photos[0].r2_key}` : null, canonical: `${origin}/sale/${sale.slug}/item/${r.item_id}`, body }));
  }

  // ----- the sale
  const cards = rows.map(r => `<a class="card${r.status === "sold" ? " sold" : ""}" href="/sale/${esc(sale.slug)}/item/${esc(r.item_id)}">
<img src="${r.thumb_key ? "/p/" + esc(r.thumb_key) : ""}" alt="" loading="lazy"><div class="b"><div class="t">${esc(r.ai_title || r.name)}</div>
<div class="p">${esc(money(r.price_cents))}</div>${statusTag(r) || (canBuy && r.status === "available" ? `<span class="tag o">Buy online</span>` : "")}</div></a>`).join("");
  const firstThumb = rows.find(r => r.thumb_key);
  const body = `${header}<div class="wrap">${endedNote}${sale.description ? `<p style="white-space:pre-line;margin-top:16px">${esc(sale.description)}</p>` : ""}
${canBuy ? `<div class="note" style="background:#dff1ea;border-color:#b5dccd;color:#0f4a3e">Can't make it? Many items can be bought online${sale.ship_ok ? " and shipped" : " for pickup"}.</div>` : ""}
<div class="grid">${cards || `<p class="muted">No items listed yet.</p>`}</div></div>`;
  return H(page({ title: `${sale.title} · ${kind} in ${sale.city}, ${sale.state}`, desc: `${kind} in ${sale.city}, ${sale.state}. ${whenText(sale)}. ${rows.length} items with prices.`,
    image: firstThumb ? `${origin}/p/${firstThumb.thumb_key}` : null, canonical: `${origin}/sale/${sale.slug}`, body }));
}
