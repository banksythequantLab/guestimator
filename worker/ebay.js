// eBay listing for Guestimator: the user's OWN eBay account, reached through eBay's OAuth
// authorization-code grant, and the Sell Inventory API (inventory item -> offer -> publish).
//
// Everything that decides WHAT goes on a listing is a pure function at the top of this file and
// is tested without eBay (tests/ebay_test.mjs). Everything below the "eBay calls" line talks to
// eBay and is kept thin, so that a failure is eBay's own words passed through, not ours.

import { textJson, cfg, cleanForEbay } from "./appraiser.js";

export const MARKETPLACE = "EBAY_US";
export const CATEGORY_TREE_US = "0";
export const SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
  // Sale alerts: read orders for our listings and mark them shipped with tracking.
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
];
export const SIGNUP_URL = "https://signup.ebay.com/pa/crte";

// ---------- pure: what the listing says ----------

// eBay titles stop at 80 characters. Cut on a word, never mid-word, and never leave dangling
// punctuation - "Red Wing 3-Gallon Crock," reads like a mistake in search results.
export function ebayTitle(s) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (t.length <= 80) return t;
  let cut = t.slice(0, 81);
  const sp = cut.lastIndexOf(" ");
  cut = sp > 40 ? cut.slice(0, sp) : t.slice(0, 80);
  return cut.replace(/[\s,;:\-–—/(]+$/, "");
}

// The appraiser grades on its own scale; eBay's condition is per category. Each grade lists the
// eBay condition IDs it would accept, best fit first, and the category's own list decides. Most
// antiques and collectibles categories offer only 1000 New / 3000 Used, which is why 3000 is the
// last resort for every used grade.
const GRADE_PREFS = {
  "excellent": ["2990", "3000"],
  "very good": ["4000", "3000"],
  "good": ["5000", "3000"],
  "fair": ["3010", "6000", "3000"],
  "poor": ["6000", "3010", "3000"],
  "as-is": ["6000", "3010", "3000"],
};
export const CONDITION_ENUM = {
  "1000": "NEW", "1500": "NEW_OTHER", "1750": "NEW_WITH_DEFECTS", "2750": "LIKE_NEW",
  "2990": "PRE_OWNED_EXCELLENT", "3000": "USED_EXCELLENT", "3010": "PRE_OWNED_FAIR",
  "4000": "USED_VERY_GOOD", "5000": "USED_GOOD", "6000": "USED_ACCEPTABLE",
  "7000": "FOR_PARTS_OR_NOT_WORKING",
};
// allowed: the category's condition IDs as strings, or null when eBay did not say. Returns the
// ConditionEnum name the Inventory API wants, or null when nothing fits - never a guess that
// eBay will reject at publish time, which is the most expensive place to find out.
export function conditionFor(grade, allowed) {
  const prefs = GRADE_PREFS[String(grade || "").trim().toLowerCase()] || ["3000"];
  // eBay said nothing about this category: plain "Used" is the one condition nearly every
  // category takes. "As-is" is not "for parts" - a chipped crock still works as a crock.
  if (!allowed || !allowed.length) return "USED_EXCELLENT";
  const set = new Set(allowed.map(String));
  for (const id of prefs) if (set.has(id)) return CONDITION_ENUM[id];
  if (set.has("3000")) return "USED_EXCELLENT";
  const used = allowed.map(String).find(id => Number(id) >= 2750 && Number(id) < 7000 && CONDITION_ENUM[id]);
  return used ? CONDITION_ENUM[used] : null;
}

// conds: the category's conditions from the Metadata API, [] when eBay lists none for it, or
// null when the lookup failed. Only an explicit empty list means "this category has no condition";
// a failed lookup is not evidence of that.
export const conditionApplies = conds => !(Array.isArray(conds) && conds.length === 0);
// Whether a chosen ConditionEnum is one the category takes. Unknown (null) lists allow anything.
export function conditionAllowed(value, conds) {
  if (!Array.isArray(conds)) return Object.values(CONDITION_ENUM).includes(value);
  return conds.some(c => CONDITION_ENUM[typeof c === "object" ? c.id : String(c)] === value);
}

// The asking price to start from. The appraiser's suggested retail is the answer to exactly this
// question; the live market median is the fallback when it declined to give one. Zero is never a
// price - a zero here is how the phone showed an empty range - so it falls through, and null
// comes back rather than a $0 listing.
export function startingPrice(result) {
  const pr = result?.price_range || {};
  for (const v of [pr.suggested_retail, result?.market?.median, pr.high && pr.low ? (pr.low + pr.high) / 2 : 0])
    if (Number(v) > 0) return Math.round(Number(v) * 100) / 100;
  return null;
}

// SKUs are the seller's, visible in Seller Hub, and limited to 50 characters.
export function skuFor(itemId) {
  return ("GUESS-" + String(itemId).replace(/[^A-Za-z0-9]/g, "")).slice(0, 50);
}

// eBay fetches pictures itself, so they must be public HTTPS in a format it takes. HEIC off an
// iPhone is dropped rather than sent to fail the whole listing; the caller says how many went.
const EBAY_IMAGE_TYPES = /^(image\/(jpe?g|png|gif|webp|bmp|tiff))$/i;
export function imageUrls(photos, origin) {
  const ok = (photos || []).filter(p => EBAY_IMAGE_TYPES.test(p.content_type || "image/jpeg"));
  const front = ok.filter(p => p.kind === "front"), rest = ok.filter(p => p.kind !== "front");
  return [...front, ...rest].slice(0, 24).map(p => `${String(origin).replace(/\/+$/, "")}/p/${p.r2_key}`);
}

const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export function descriptionHtml(text) {
  const paras = String(text || "").split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  return paras.map(p => `<p>${escHtml(p).replace(/\n/g, "<br>")}</p>`).join("\n");
}

// Taxonomy's aspect list trimmed to what a person can review on a phone: every required aspect,
// then the recommended ones, capped. SELECTION_ONLY aspects carry their allowed values because
// eBay rejects anything else.
export function aspectSpec(aspects, maxRecommended = 8) {
  const out = [];
  let rec = 0;
  for (const a of aspects || []) {
    const c = a.aspectConstraint || {};
    const required = !!c.aspectRequired;
    const recommended = c.aspectUsage === "RECOMMENDED";
    if (!required && !(recommended && rec < maxRecommended)) continue;
    if (!required) rec++;
    out.push({
      name: a.localizedAspectName,
      required,
      selection_only: c.aspectMode === "SELECTION_ONLY",
      multi: c.itemToAspectCardinality === "MULTI",
      values: (a.aspectValues || []).slice(0, 60).map(v => v.localizedValue),
    });
  }
  return out;
}

// Whatever filled the aspects (the model, or the person editing them), this is the gate before
// eBay sees them: selection-only values must be eBay's own spelling, free text is capped at
// eBay's 65 characters, and empty values are dropped rather than sent as "".
export function cleanAspects(filled, spec) {
  const out = {};
  const byName = new Map((spec || []).map(s => [s.name.toLowerCase(), s]));
  for (const [k, v] of Object.entries(filled || {})) {
    const s = byName.get(String(k).toLowerCase());
    if (!s) continue;
    let vals = (Array.isArray(v) ? v : [v]).map(x => String(x ?? "").trim()).filter(Boolean);
    if (s.selection_only) {
      const allowed = new Map(s.values.map(x => [x.toLowerCase(), x]));
      vals = vals.map(x => allowed.get(x.toLowerCase())).filter(Boolean);
    } else vals = vals.map(x => x.slice(0, 65));
    if (!s.multi) vals = vals.slice(0, 1);
    if (vals.length) out[s.name] = vals;
  }
  return out;
}
export function missingRequired(aspects, spec) {
  return (spec || []).filter(s => s.required && !(aspects[s.name] && aspects[s.name].length)).map(s => s.name);
}

// Brand is required in a great many categories, and the appraiser's maker is the right answer
// when it has one. Filled here, not by the model, because the model will happily invent a brand.
export function seedAspects(spec, ident) {
  const out = {};
  const brand = (spec || []).find(s => s.name === "Brand");
  if (brand) {
    const maker = String(ident?.maker || "").trim();
    const known = maker && !/^(unknown|n\/?a|none|unmarked)$/i.test(maker);
    out.Brand = [known ? maker : "Unbranded"];
  }
  return out;
}

// eBay errors come back as a list; the first one's longMessage is usually the sentence a person
// can act on ("Please add at least one picture"). Keep the errorId so support has something.
export function ebayErrorText(json, status) {
  const e = (json && (json.errors || json.warnings) || [])[0];
  if (!e) return `eBay returned ${status}`;
  return `${e.longMessage || e.message || "eBay error"}${e.errorId ? ` (eBay ${e.errorId})` : ""}`;
}

// ======================= eBay calls =======================
const hosts = env => env.EBAY_ENV === "sandbox"
  ? { api: "https://api.sandbox.ebay.com", apiz: "https://apiz.sandbox.ebay.com", auth: "https://auth.sandbox.ebay.com/oauth2/authorize" }
  : { api: "https://api.ebay.com", apiz: "https://apiz.ebay.com", auth: "https://auth.ebay.com/oauth2/authorize" };

export const ebayConfigured = env => !!(env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET && env.EBAY_RUNAME && env.EBAY_TOKEN_KEY);

export function consentUrl(env, state) {
  const u = new URL(hosts(env).auth);
  u.searchParams.set("client_id", env.EBAY_CLIENT_ID);
  u.searchParams.set("redirect_uri", env.EBAY_RUNAME);   // the RuName, not a URL - eBay's rule
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPES.join(" "));
  u.searchParams.set("state", state);
  return u.toString();
}

// ---- refresh tokens live 18 months and act as the user on eBay: encrypted at rest ----
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function aesKey(env) {
  const raw = unb64(env.EBAY_TOKEN_KEY);
  if (raw.length !== 32) throw new Error("EBAY_TOKEN_KEY must be 32 bytes, base64");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), new TextEncoder().encode(text));
  const out = new Uint8Array(12 + ct.byteLength); out.set(iv); out.set(new Uint8Array(ct), 12);
  return b64(out);
}
export async function unseal(env, sealed) {
  const all = unb64(sealed);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, await aesKey(env), all.slice(12));
  return new TextDecoder().decode(pt);
}

async function tokenCall(env, form) {
  const r = await fetch(`${hosts(env).api}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded",
               authorization: "Basic " + btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`) },
    body: new URLSearchParams(form).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`eBay sign-in failed: ${j.error_description || j.error || r.status}`);
  return j;
}
export const exchangeCode = (env, code) =>
  tokenCall(env, { grant_type: "authorization_code", code, redirect_uri: env.EBAY_RUNAME });

let _app = { at: 0, token: null };
export async function appToken(env) {
  if (_app.token && Date.now() - _app.at < 6600e3) return _app.token;
  const j = await tokenCall(env, { grant_type: "client_credentials", scope: SCOPES[0] });
  _app = { at: Date.now(), token: j.access_token };
  return j.access_token;
}

// The user's access token, refreshed when it is within five minutes of expiring. A refresh
// token eBay no longer honours (revoked in My eBay, or expired) disconnects the account rather
// than failing every call after it with the same error.
export async function userToken(env, db, userId) {
  const a = await db.prepare("SELECT * FROM ebay_accounts WHERE user_id=?").bind(userId).first();
  if (!a) return null;
  if (a.access_token_enc && a.access_expires_at && Date.parse(a.access_expires_at) - Date.now() > 300e3)
    return { token: await unseal(env, a.access_token_enc), acct: a };
  let j;
  try {
    // No scope: eBay then grants what this account consented to. Asking for SCOPES would fail
    // (invalid_scope) for every account connected before a scope was added to the list.
    j = await tokenCall(env, { grant_type: "refresh_token", refresh_token: await unseal(env, a.refresh_token_enc) });
  } catch (e) {
    if (/invalid_grant/i.test(e.message)) {
      await db.prepare("DELETE FROM ebay_accounts WHERE user_id=?").bind(userId).run();
      return null;
    }
    throw e;
  }
  const exp = new Date(Date.now() + (j.expires_in || 7200) * 1000).toISOString();
  await db.prepare("UPDATE ebay_accounts SET access_token_enc=?, access_expires_at=?, updated_at=? WHERE user_id=?")
    .bind(await seal(env, j.access_token), exp, new Date().toISOString(), userId).run();
  return { token: j.access_token, acct: a };
}

export async function call(env, token, method, path, body, host = "api") {
  const r = await fetch(hosts(env)[host] + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "content-language": "en-US",
      "accept-language": "en-US",
      "x-ebay-c-marketplace-id": MARKETPLACE,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  // A failed eBay call is logged whole - method, path, status, eBay's errors (with parameters and
  // any detail they carry) - because the one-line longMessage alone ("Core Inventory Service
  // internal error", 25001) told us nothing about which field it choked on. The request body is
  // logged for Sell calls with the image URLs shortened; tokens are headers and are never logged.
  if (!r.ok) console.log("ebay call failed", JSON.stringify({
    method, path: path.split("?")[0], status: r.status, errors: json?.errors || text.slice(0, 1500),
    sent: path.startsWith("/sell/") && body !== undefined
      ? JSON.stringify(body, (k, v) => k === "imageUrls" ? v.map(u => String(u).slice(-30)) : v).slice(0, 2500) : undefined,
  }));
  return { ok: r.ok, status: r.status, json };
}
// eBay documents 25001 ("A system error has occurred") as a transient internal error: retry once.
const isSystemError = r => !r.ok && (r.json?.errors || []).some(e => e.errorId === 25001);
async function callRetry(env, token, method, path, body) {
  let r = await call(env, token, method, path, body);
  if (isSystemError(r)) { await new Promise(res => setTimeout(res, 1500)); r = await call(env, token, method, path, body); }
  return r;
}

export async function identity(env, token) {
  const r = await call(env, token, "GET", "/commerce/identity/v1/user/", undefined, "apiz");
  return r.ok ? { userId: r.json?.userId || null, username: r.json?.username || null } : { userId: null, username: null };
}

// ---- category, aspects, conditions (application token: nothing here is the user's) ----
export async function suggestCategories(env, q) {
  const tok = await appToken(env);
  const r = await call(env, tok, "GET",
    `/commerce/taxonomy/v1/category_tree/${CATEGORY_TREE_US}/get_category_suggestions?q=${encodeURIComponent(q)}`);
  if (!r.ok) return [];
  return (r.json?.categorySuggestions || []).slice(0, 6).map(s => ({
    id: s.category?.categoryId, name: s.category?.categoryName,
    path: [...(s.categoryTreeNodeAncestors || [])].reverse().map(a => a.categoryName).concat(s.category?.categoryName || "").join(" > "),
  })).filter(c => c.id);
}
export async function categoryAspects(env, categoryId) {
  const tok = await appToken(env);
  const r = await call(env, tok, "GET",
    `/commerce/taxonomy/v1/category_tree/${CATEGORY_TREE_US}/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`);
  return r.ok ? (r.json?.aspects || []) : [];
}
export async function categoryConditions(env, categoryId) {
  const tok = await appToken(env);
  const r = await call(env, tok, "GET",
    `/sell/metadata/v1/marketplace/${MARKETPLACE}/get_item_condition_policies?filter=${encodeURIComponent(`categoryIds:{${categoryId}}`)}`);
  if (!r.ok) return null;
  const p = (r.json?.itemConditionPolicies || [])[0];
  return p ? (p.itemConditions || []).map(c => ({ id: String(c.conditionId), label: c.conditionDescription || String(c.conditionId) })) : null;
}

// ---- the draft a person reviews before anything goes to eBay ----
const ASPECT_SYSTEM = `You fill in eBay "item specifics" for one listing.
Return JSON only: {"aspects": {"<aspect name>": ["<value>", ...]}}.
Rules:
- Use only facts present in the item details. Leave out any aspect the details do not support; an empty answer is better than a guess, because a wrong item specific misleads buyers.
- For an aspect marked CHOOSE FROM, answer with one of the listed values, spelled exactly as listed.
- Free-text values are short (under 65 characters): "Stoneware", "c. 1920", "United States".
- Never answer "Unknown", "N/A" or "Does not apply".`;
export async function modelAspects(env, spec, facts) {
  if (!env.NEBIUS_API_KEY || !spec.length) return {};
  const lines = spec.map(s => `- ${s.name}${s.required ? " (required)" : ""}` +
    (s.selection_only ? ` CHOOSE FROM: ${s.values.join(" | ")}` : s.values.length ? ` (examples: ${s.values.slice(0, 10).join(", ")})` : ""));
  const user = `ITEM DETAILS\n${facts}\n\nASPECTS TO FILL\n${lines.join("\n")}`;
  try {
    const j = await textJson(cfg(env), ASPECT_SYSTEM, user, 1200);
    return j && typeof j.aspects === "object" ? j.aspects : {};
  } catch (e) {
    console.log("aspect fill failed", String(e && e.message));
    return {};
  }
}

export async function buildDraft(env, { item, photos, result, origin, categoryId }) {
  const ident = result?.identification || {};
  const listing = result?.listing || {};
  const title = ebayTitle(listing.title || ident.name || item.name);
  const q = cleanForEbay(ident.name || listing.title || item.name) || title;
  let cats = await suggestCategories(env, q);
  if (!cats.length && q !== title) cats = await suggestCategories(env, title);
  // The person may pick a different suggested category; its aspects and conditions differ.
  const cat = (categoryId && cats.find(c => String(c.id) === String(categoryId))) || cats[0] || null;
  const [rawAspects, conds] = cat ? await Promise.all([categoryAspects(env, cat.id), categoryConditions(env, cat.id)]) : [[], null];
  const spec = aspectSpec(rawAspects);
  const facts = [
    `Title: ${title}`, ident.name && `Identified as: ${ident.name}`, ident.maker && `Maker: ${ident.maker}`,
    ident.period && `Period: ${ident.period}`, ident.origin && `Origin: ${ident.origin}`, ident.style && `Style: ${ident.style}`,
    ident.category && `Kind of object: ${ident.category}`, listing.condition_grade && `Condition: ${listing.condition_grade}`,
    item.markings && `Marks: ${item.markings}`, item.description && `Owner's description: ${item.description}`,
    (result?.transcribed_text || []).length && `Text on the item: ${result.transcribed_text.join(" / ")}`,
    listing.description && `Listing copy: ${listing.description}`,
  ].filter(Boolean).join("\n");
  const aspects = cleanAspects({ ...(await modelAspects(env, spec, facts)), ...seedAspects(spec, ident) }, spec);
  const allowedIds = conds ? conds.map(c => c.id) : null;
  const urls = imageUrls(photos, origin);
  return {
    title,
    description: listing.description || item.description || "",
    price: startingPrice(result),
    price_basis: result?.price_range?.suggested_retail > 0 ? "suggested retail from the estimate"
      : result?.market?.median > 0 ? "median of live eBay asking prices" : null,
    // Estimated packed weight and box, shown beside the shipping price so the seller has
    // something better than a guess to price shipping from.
    shipping: result?.shipping || null,
    category: cat, categories: cats,
    // Measured live 2026-09-27: Antiques > Silver > Silverplate > Flatware returns NO condition
    // policies at all. Such a category does not use item condition, so none is sent.
    condition_applies: conditionApplies(conds),
    condition: conditionApplies(conds) ? conditionFor(listing.condition_grade, allowedIds) : null,
    conditions: (conds || []).filter(c => CONDITION_ENUM[c.id]).map(c => ({ value: CONDITION_ENUM[c.id], label: c.label })),
    condition_note: listing.condition_grade ? `Condition: ${listing.condition_grade}.` : "",
    aspects, aspect_spec: spec, missing: missingRequired(aspects, spec),
    images: urls, images_skipped: (photos || []).length - urls.length,
  };
}

// ---- the seller's business policies ----
// Inventory API listings cannot publish without a payment, a return and a fulfillment policy.
// Someone who has sold on eBay before has them; someone who has not gets three sensible ones
// made for them, named "Guestimator ..." so they can find and change them in Seller Hub.
const ALL_CATS = [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }];
// What a return policy means to a buyer, in the words the listing preview shows. The preview used
// to say "30-day returns" whatever the policy was; Derek's live Tesla listing said "Seller does
// not accept returns" under a preview that had promised 30 days.
export function returnSummary(p) {
  if (!p || p.returnsAccepted === false) return "No returns";
  const per = p.returnPeriod && p.returnPeriod.value ? `${p.returnPeriod.value}-${String(p.returnPeriod.unit || "DAY").toLowerCase()} returns` : "Returns accepted";
  const who = p.returnShippingCostPayer === "SELLER" ? "free return shipping" : "buyer pays return shipping";
  return `${per}, ${who}`;
}
export const NEW_RETURNS_30 = "new30";
export async function listPolicies(env, token) {
  const get = async kind => {
    const r = await call(env, token, "GET", `/sell/account/v1/${kind}_policy?marketplace_id=${MARKETPLACE}`);
    return r;
  };
  const [f, p, rt] = await Promise.all([get("fulfillment"), get("payment"), get("return")]);
  // 20403-series: the account is not opted in to business policies yet.
  const notOptedIn = [f, p, rt].some(r => !r.ok && (r.json?.errors || []).some(e => /opt|eligib|business polic/i.test(e.message || "")));
  const pick = (r, key, idKey) => (r.ok ? (r.json?.[key] || []) : []).map(x => ({ id: x[idKey], name: x.name }));
  const bad = [f, p, rt].find(r => !r.ok);
  return {
    notOptedIn,
    fulfillment: pick(f, "fulfillmentPolicies", "fulfillmentPolicyId"),
    payment: pick(p, "paymentPolicies", "paymentPolicyId"),
    return: (rt.ok ? (rt.json?.returnPolicies || []) : []).map(x => ({ id: x.returnPolicyId, name: x.name, summary: returnSummary(x) })),
    error: bad && !notOptedIn ? ebayErrorText(bad.json, bad.status) : null,
  };
}
export async function optIn(env, token) {
  const r = await call(env, token, "POST", "/sell/account/v1/program/opt_in", { programType: "SELLING_POLICY_MANAGEMENT" });
  return r.ok || r.status === 409;
}

// Creating a policy whose name already exists is an error; finding it by that name is the fix.
async function createOrFind(env, token, kind, body, idKey) {
  const r = await call(env, token, "POST", `/sell/account/v1/${kind}_policy`, body);
  if (r.ok) return r.json?.[idKey];
  const byName = await call(env, token, "GET",
    `/sell/account/v1/${kind}_policy/get_by_policy_name?marketplace_id=${MARKETPLACE}&name=${encodeURIComponent(body.name)}`);
  if (byName.ok && byName.json?.[idKey]) return byName.json[idKey];
  throw new Error(`Could not set up your eBay ${kind} policy: ${ebayErrorText(r.json, r.status)}`);
}
export const createPaymentPolicy = (env, token) => createOrFind(env, token, "payment", {
  name: "Guestimator payments", marketplaceId: MARKETPLACE, categoryTypes: ALL_CATS, immediatePay: true,
}, "paymentPolicyId");
export const createReturnPolicy = (env, token) => createOrFind(env, token, "return", {
  name: "Guestimator 30-day returns", marketplaceId: MARKETPLACE, categoryTypes: ALL_CATS,
  returnsAccepted: true, returnPeriod: { value: 30, unit: "DAY" }, returnShippingCostPayer: "BUYER",
}, "returnPolicyId");
// Flat-rate USPS at the price the seller types. Ground Advantage by default: for the small, light
// things this app mostly lists it is about half the price of Priority (a 6 oz memory stick,
// Sep 2026: $6.07 vs $12.82 mid-country), and buyers see shipping before they see anything else.
// The codes are eBay's, read from GeteBayDetails (ShippingServiceDetails, ValidForSellingFlow)
// on 2026-09-30 - Ground Advantage is "USPSParcel". The obvious-looking "USPSGroundAdvantage" is
// not a selling code and fails.
export const SHIP_SERVICES = {
  ground: { code: "USPSParcel", name: "USPS Ground Advantage", short: "Ground Advantage" },
  priority: { code: "USPSPriority", name: "USPS Priority Mail", short: "Priority" },
};
export const shipService = s => (SHIP_SERVICES[s] ? s : "ground");
export function fulfillmentPolicyBody(shippingCost, handlingDays, service = "ground") {
  const cost = Math.max(0, Math.round(Number(shippingCost) * 100) / 100);
  const free = cost === 0;
  const svc = SHIP_SERVICES[shipService(service)];
  const days = Math.min(Math.max(Math.round(Number(handlingDays) || 3), 1), 10);
  return {
    // The name is how an existing policy is found again (createOrFind), so everything that makes
    // two policies different has to be in it - service and handling time as well as price.
    name: `Guestimator ${svc.short} ${free ? "free" : "$" + cost.toFixed(2)} ${days}d`,
    marketplaceId: MARKETPLACE, categoryTypes: ALL_CATS,
    handlingTime: { unit: "DAY", value: days },
    shippingOptions: [{
      optionType: "DOMESTIC", costType: "FLAT_RATE",
      shippingServices: [{
        sortOrder: 1, shippingCarrierCode: "USPS", shippingServiceCode: svc.code,
        freeShipping: free, shippingCost: { value: cost.toFixed(2), currency: "USD" },
      }],
    }],
  };
}
export const createFulfillmentPolicy = (env, token, cost, days, service) =>
  createOrFind(env, token, "fulfillment", fulfillmentPolicyBody(cost, days, service), "fulfillmentPolicyId");

// ---- where it ships from: eBay wants a postal code, not a street address ----
export async function ensureLocation(env, token, postalCode) {
  const zip = String(postalCode || "").trim();
  if (!/^\d{5}(-\d{4})?$/.test(zip)) throw new Error("Enter the 5-digit ZIP code you ship from");
  const key = `guestimator-${zip.slice(0, 5)}`;
  const r = await call(env, token, "POST", `/sell/inventory/v1/location/${key}`, {
    location: { address: { postalCode: zip.slice(0, 5), country: "US" } },
    name: `Ships from ${zip.slice(0, 5)}`, merchantLocationStatus: "ENABLED", locationTypes: ["WAREHOUSE"],
  });
  // 409 / errorId 25803: that location already exists, which is what we wanted.
  if (r.ok || r.status === 409 || (r.json?.errors || []).some(e => e.errorId === 25803)) return key;
  throw new Error(`Could not set your ship-from location on eBay: ${ebayErrorText(r.json, r.status)}`);
}

// ---- eBay's own fee calculator, for an offer that is saved but NOT published ----
// An unpublished offer is invisible to buyers and costs nothing; this asks eBay what publishing it
// would cost, so the person sees real fees before committing. Summed as amount - promo discount.
export function summarizeFees(json) {
  const fees = (json?.feeSummaries || []).flatMap(s => s.fees || []).map(f => {
    const amt = Number(f.amount?.value || 0), off = Number(f.promotionalDiscount?.value || 0);
    return { type: f.feeType || "Fee", amount: amt, discount: off, net: Math.max(0, Math.round((amt - off) * 100) / 100),
             currency: f.amount?.currency || "USD" };
  });
  const total = Math.round(fees.reduce((a, f) => a + f.net, 0) * 100) / 100;
  return { fees: fees.filter(f => f.amount > 0), total,
           warnings: (json?.feeSummaries || []).flatMap(s => (s.warnings || []).map(w => w.longMessage || w.message)).filter(Boolean) };
}
export async function listingFees(env, token, offerId) {
  const r = await callRetry(env, token, "POST", "/sell/inventory/v1/offer/get_listing_fees", { offers: [{ offerId }] });
  if (!r.ok) return { error: ebayErrorText(r.json, r.status) };
  return summarizeFees(r.json);
}

// Save item + offer on eBay without publishing (the preview step). Returns { offerId } or { stage, error }.
export async function prepareOffer(env, token, L) {
  const r = await publishListing(env, token, { ...L, dryRun: true });
  return r;
}

// ---- Best Offer: buyers can make an offer, and eBay answers most of them for the seller ----
// Offers at or above 90% of the price are accepted on the spot; offers under the item's floor
// (the lowest the estimate said to take) or under 70% of the price, whichever is higher, are
// declined on the spot. Everything in between waits for the seller. Under $10 haggling isn't
// worth anyone's time, so no offers.
const downNice = c => c >= 2000 ? Math.floor(c / 100) * 100 : Math.floor(c / 50) * 50;
export function bestOfferTerms(price, floorDollars) {
  const p = Math.round(Number(price) * 100);
  if (!(p >= 1000)) return null;
  const floor = Number(floorDollars) > 0 ? Math.round(Number(floorDollars) * 100) : 0;
  let accept = Math.max(downNice(p * 0.9), downNice(floor));
  if (accept >= p) accept = downNice(p - 1);          // floor at or above the price: accept just under it
  if (!(accept > 0) || accept >= p) return null;
  let decline = downNice(Math.max(p * 0.7, floor));
  if (decline >= accept) decline = accept - (accept >= 2000 ? 100 : 50);
  if (!(decline > 0)) decline = null;
  return { accept_cents: accept, decline_cents: decline };
}
const amt = c => ({ value: (c / 100).toFixed(2), currency: "USD" });
export const ebayBestOffer = t => t
  ? { bestOfferEnabled: true, autoAcceptPrice: amt(t.accept_cents), ...(t.decline_cents ? { autoDeclinePrice: amt(t.decline_cents) } : {}) }
  : { bestOfferEnabled: false };

// Change an existing offer's Best Offer settings (and optionally its price) in one update. The
// update replaces the whole offer, so it starts from eBay's own copy of it; on a published offer
// eBay revises the live listing.
export async function updateOfferTerms(env, token, offerId, terms, priceCents = null) {
  const g = await callRetry(env, token, "GET", `/sell/inventory/v1/offer/${offerId}`);
  if (!g.ok) return { error: ebayErrorText(g.json, g.status) };
  const { offerId: _o, status: _s, listing: _l, ...body } = g.json || {};
  body.listingPolicies = { ...(body.listingPolicies || {}), bestOfferTerms: ebayBestOffer(terms) };
  if (priceCents) body.pricingSummary = { ...(body.pricingSummary || {}), price: amt(priceCents) };
  const u = await callRetry(env, token, "PUT", `/sell/inventory/v1/offer/${offerId}`, body);
  if (!u.ok) return { error: ebayErrorText(u.json, u.status) };
  return { ok: true };
}

// ---- the listing itself: inventory item, then offer, then publish ----
export async function publishListing(env, token, L) {
  const inv = await callRetry(env, token, "PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(L.sku)}`, {
    availability: { shipToLocationAvailability: { quantity: 1 } },
    ...(L.condition ? { condition: L.condition } : {}),
    ...(L.condition && L.conditionDescription && L.condition !== "NEW" ? { conditionDescription: L.conditionDescription.slice(0, 1000) } : {}),
    product: { title: L.title, description: L.descriptionText.slice(0, 4000), aspects: L.aspects, imageUrls: L.imageUrls },
  });
  if (!inv.ok) return { stage: "item", error: ebayErrorText(inv.json, inv.status) };

  const offerBody = {
    sku: L.sku, marketplaceId: MARKETPLACE, format: "FIXED_PRICE", availableQuantity: 1,
    categoryId: String(L.categoryId), listingDescription: L.descriptionHtml, listingDuration: "GTC",
    listingPolicies: { fulfillmentPolicyId: L.fulfillmentPolicyId, paymentPolicyId: L.paymentPolicyId, returnPolicyId: L.returnPolicyId,
                       ...(L.bestOffer !== undefined ? { bestOfferTerms: ebayBestOffer(L.bestOffer) } : {}) },
    pricingSummary: { price: { value: Number(L.price).toFixed(2), currency: "USD" } },
    merchantLocationKey: L.locationKey,
  };
  let offerId = L.offerId || null;
  if (offerId) {
    const u = await callRetry(env, token, "PUT", `/sell/inventory/v1/offer/${offerId}`, offerBody);
    if (!u.ok && u.status !== 404) return { stage: "offer", offerId, error: ebayErrorText(u.json, u.status) };
    if (u.status === 404) offerId = null;
  }
  if (!offerId) {
    const o = await callRetry(env, token, "POST", "/sell/inventory/v1/offer", offerBody);
    if (o.ok) offerId = o.json?.offerId;
    else {
      // 25002: an offer already exists for this SKU - a retry after a publish that failed.
      const existing = (o.json?.errors || []).flatMap(e => e.parameters || []).find(p => p.name === "offerId");
      if (!existing) return { stage: "offer", error: ebayErrorText(o.json, o.status) };
      offerId = existing.value;
      const u = await callRetry(env, token, "PUT", `/sell/inventory/v1/offer/${offerId}`, offerBody);
      if (!u.ok) return { stage: "offer", offerId, error: ebayErrorText(u.json, u.status) };
    }
  }
  if (L.dryRun) return { offerId };   // preview: saved on eBay, unpublished, invisible to buyers
  const pub = await callRetry(env, token, "POST", `/sell/inventory/v1/offer/${offerId}/publish`, {});
  if (!pub.ok) return { stage: "publish", offerId, error: ebayErrorText(pub.json, pub.status) };
  const listingId = pub.json?.listingId;
  return { offerId, listingId, url: listingId ? `https://www.ebay.com/itm/${listingId}` : null,
           warnings: (pub.json?.warnings || []).map(w => w.longMessage || w.message).filter(Boolean) };
}
