// Inventory reports (2026-11-19). A flat-priced, printable contents inventory with a market estimate
// per item and the sales behind each one: for an insurance claim, a marital-property schedule, or an
// estate / probate inventory. Buying a report grants its item allowance as ordinary credits, so the
// estimates run through the metered appraise path like everything else; the report page only
// collects items, kicks off their Guestimates, and prints. The wording everywhere keeps it a market
// estimate from public eBay data: not an appraisal, not a certified valuation, not legal advice.

export const TIERS = {
  small:  { label: "Up to 25 items",  cap: 25,   cents: 4900 },
  medium: { label: "Up to 100 items", cap: 100,  cents: 14900 },
  large:  { label: "Up to 400 items", cap: 400,  cents: 29900 },
};
export const PURPOSES = {
  insurance: { label: "Insurance claim or household inventory", heading: "Contents inventory" },
  divorce:   { label: "Marital property (divorce or separation)", heading: "Personal property schedule" },
  estate:    { label: "Estate or probate inventory", heading: "Estate inventory" },
  other:     { label: "Something else", heading: "Inventory" },
};
const CHECKOUT_MINUTES = 30;
const nowIso = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = c => "$" + (Number(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dollars = n => "$" + Math.round(Number(n)).toLocaleString("en-US");

export async function createReport(db, userId, b) {
  const tier = TIERS[b.tier] ? b.tier : "small", purpose = PURPOSES[b.purpose] ? b.purpose : "other";
  const title = String(b.title || "").trim().slice(0, 120) || `${PURPOSES[purpose].heading} ${nowIso().slice(0, 10)}`;
  const id = uid(), at = nowIso();
  await db.prepare("INSERT INTO inventory_reports (id,user_id,title,purpose,tier,items_cap,price_cents,status,owner_name,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'draft',?,?,?,?)")
    .bind(id, userId, title, purpose, tier, TIERS[tier].cap, TIERS[tier].cents, String(b.owner_name || "").trim().slice(0, 120) || null, String(b.notes || "").trim().slice(0, 2000) || null, at, at).run();
  return getReport(db, userId, id);
}

export async function listReports(db, userId) {
  const { results } = await db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM report_items ri WHERE ri.report_id=r.id) AS item_count
    FROM inventory_reports r WHERE r.user_id=? ORDER BY r.created_at DESC`).bind(userId).all();
  return results || [];
}

/** The report with its items and each item's latest finished estimate (what the page and the print view show). */
export async function getReport(db, userId, id) {
  const r = await db.prepare("SELECT * FROM inventory_reports WHERE id=? AND user_id=?").bind(String(id || ""), userId).first();
  if (!r) return null;
  const { results } = await db.prepare(`SELECT i.id, i.name, i.ai_title, i.description, i.markings, ri.added_at,
      (SELECT r2_key FROM photos p WHERE p.item_id=i.id ORDER BY p.sort, p.created_at LIMIT 1) AS thumb_key,
      (SELECT a.result_json FROM appraisals a WHERE a.item_id=i.id AND a.status='done' ORDER BY a.created_at DESC LIMIT 1) AS result_json,
      (SELECT a.status FROM appraisals a WHERE a.item_id=i.id ORDER BY a.created_at DESC LIMIT 1) AS last_status,
      (SELECT a.completed_at FROM appraisals a WHERE a.item_id=i.id AND a.status='done' ORDER BY a.created_at DESC LIMIT 1) AS estimated_at
    FROM report_items ri JOIN items i ON i.id=ri.item_id WHERE ri.report_id=? ORDER BY ri.added_at`).bind(r.id).all();
  const items = (results || []).map(row => {
    let res = null; try { res = JSON.parse(row.result_json || "null"); } catch {}
    const pr = res && res.price_range, sm = res && res.sold_market;
    return { id: row.id, name: row.name, title: (res && res.identification && res.identification.name) || row.ai_title || row.name, description: row.description, markings: row.markings,
      photo: row.thumb_key ? `/p/${row.thumb_key}` : null, status: res ? "done" : row.last_status || "none", estimated_at: row.estimated_at,
      low: pr && pr.low > 0 ? Math.round(pr.low) : null, high: pr && pr.high > 0 ? Math.round(pr.high) : null, retail: pr && pr.suggested_retail > 0 ? Math.round(pr.suggested_retail) : null,
      confidence: res && Number(res.confidence) > 0 ? Number(res.confidence) : null, thin: !!(res && res.thin_evidence),
      sold: sm && sm.count ? { count: sm.count, low: sm.low, median: sm.median, high: sm.high, as_of: sm.as_of } : null,
      comps: ((res && res.comparables) || []).filter(c => c && c.title && Number(c.price) > 0).slice(0, 4).map(c => ({ title: String(c.title).slice(0, 120), price: Number(c.price), sold: !!c.sold || /\(sold\)/i.test(String(c.source || "")), url: /^https:\/\/(www\.)?ebay\.com\/itm\//i.test(String(c.url || "")) ? String(c.url).split("?")[0] : null })),
      warnings: ((res && res.warnings) || []).filter(w => !/no photos/.test(w)).slice(0, 3) };
  });
  const done = items.filter(i => i.low !== null);
  const total = { low: done.reduce((a, i) => a + i.low, 0), high: done.reduce((a, i) => a + i.high, 0), retail: done.reduce((a, i) => a + (i.retail || Math.round((i.low + i.high) / 2)), 0) };
  return { ...r, tier_label: TIERS[r.tier]?.label, purpose_label: PURPOSES[r.purpose]?.label, heading: PURPOSES[r.purpose]?.heading || "Inventory", items, counts: { items: items.length, estimated: done.length, cap: r.items_cap }, total };
}

export async function addItems(db, userId, id, itemIds) {
  const r = await db.prepare("SELECT * FROM inventory_reports WHERE id=? AND user_id=?").bind(String(id || ""), userId).first();
  if (!r) return { status: 404, error: "No such report." };
  const have = (await db.prepare("SELECT COUNT(*) AS n FROM report_items WHERE report_id=?").bind(r.id).first())?.n || 0;
  const want = [...new Set((itemIds || []).map(String).filter(Boolean))].slice(0, 500);
  let added = 0, over = 0;
  for (const iid of want) {
    const mine = await db.prepare("SELECT i.id FROM items i JOIN sales s ON s.id=i.sale_id WHERE i.id=? AND s.user_id=?").bind(iid, userId).first();
    if (!mine) continue;
    if (have + added >= r.items_cap) { over++; continue; }
    const ins = await db.prepare("INSERT OR IGNORE INTO report_items (report_id,item_id,added_at) VALUES (?,?,?)").bind(r.id, iid, nowIso()).run();
    if (ins.meta && ins.meta.changes) added++;
  }
  await db.prepare("UPDATE inventory_reports SET updated_at=? WHERE id=?").bind(nowIso(), r.id).run();
  return { status: 200, added, over, cap: r.items_cap };
}

export async function removeItem(db, userId, id, itemId) {
  const r = await db.prepare("SELECT id FROM inventory_reports WHERE id=? AND user_id=?").bind(String(id || ""), userId).first();
  if (!r) return { status: 404, error: "No such report." };
  await db.prepare("DELETE FROM report_items WHERE report_id=? AND item_id=?").bind(r.id, String(itemId || "")).run();
  return { status: 200 };
}

// ---------- paying for it ----------
/** Open a Stripe Checkout for the report's tier. `stripe` is garage.stripe. Returns { status, url } or { status, error }. */
export async function startCheckout(env, db, userId, id, origin, stripe, nowMs = Date.now()) {
  const r = await db.prepare("SELECT * FROM inventory_reports WHERE id=? AND user_id=?").bind(String(id || ""), userId).first();
  if (!r) return { status: 404, error: "No such report." };
  if (r.status === "paid") return { status: 409, error: "This report is already paid for." };
  const sid = uid();
  const back = `${origin}/report/${r.id}?paid=1`;
  const sess = await stripe(env, "POST", "/v1/checkout/sessions", {
    mode: "payment",
    success_url: back, cancel_url: `${origin}/report/${r.id}?cancelled=1`,
    expires_at: Math.floor(nowMs / 1000) + CHECKOUT_MINUTES * 60 + 60,
    client_reference_id: r.id,
    line_items: { 0: { quantity: 1, price_data: { currency: "usd", unit_amount: r.price_cents,
      product_data: { name: `Guestimator inventory report: ${TIERS[r.tier]?.label || r.tier}`.slice(0, 250),
                      description: `Market estimates for up to ${r.items_cap} items, with the eBay sales behind each, as a printable report. Not a certified appraisal.` } } } },
    payment_intent_data: { metadata: { inventory_report: r.id, user: userId } },
    metadata: { inventory_report: r.id, user: userId },
  });
  await db.prepare("UPDATE inventory_reports SET status='pending', session_id=?, updated_at=? WHERE id=?").bind(sess.id, nowIso(), r.id).run();
  return { status: 200, url: sess.url, id: r.id, session: sid };
}

/** After Stripe: if the checkout is paid, mark the report paid and grant its allowance as credits (once). Safe to repeat. */
export async function finishCheckout(env, db, userId, id, stripe) {
  const r = await db.prepare("SELECT * FROM inventory_reports WHERE id=? AND user_id=?").bind(String(id || ""), userId).first();
  if (!r) return { status: 404, error: "No such report." };
  if (r.status === "paid") return { status: 200, paid: true, already: true };
  if (r.status !== "pending" || !r.session_id) return { status: 402, error: "Not paid yet.", state: r.status };
  const s = await stripe(env, "GET", `/v1/checkout/sessions/${r.session_id}`);
  if (s.payment_status !== "paid") {
    if (s.status === "expired") { await db.prepare("UPDATE inventory_reports SET status='draft', session_id=NULL, updated_at=? WHERE id=?").bind(nowIso(), r.id).run(); return { status: 410, error: "That checkout expired. Start it again.", state: "expired" }; }
    return { status: 402, error: "Payment isn't finished yet.", state: "unpaid" };
  }
  // Claim it so the grant happens once, whatever race the return page and the cron get into.
  const claim = await db.prepare("UPDATE inventory_reports SET status='paid', payment_intent=?, paid_at=?, updated_at=? WHERE id=? AND status='pending'").bind(s.payment_intent || null, nowIso(), nowIso(), r.id).run();
  if (!claim.meta || claim.meta.changes !== 1) return { status: 200, paid: true, already: true };
  await db.prepare("UPDATE users SET credits=credits+? WHERE id=?").bind(r.items_cap, userId).run();
  await db.prepare("INSERT INTO billing_events (id,user_id,source,event_id,type,product_id,credits_delta,raw_json,created_at) VALUES (?,?,'report',?,'grant',?,?,?,?)")
    .bind(uid(), userId, `report:${r.id}`, `report_${r.tier}`, r.items_cap, JSON.stringify({ report: r.id, payment_intent: s.payment_intent, cents: r.price_cents }), nowIso()).run();
  return { status: 200, paid: true, credits: r.items_cap };
}

/** Cron: reports paid where the buyer never came back from Stripe. */
export async function sweep(env, db, stripe) {
  const { results } = await db.prepare("SELECT id, user_id FROM inventory_reports WHERE status='pending' AND session_id IS NOT NULL AND updated_at < ? LIMIT 20").bind(new Date(Date.now() - 2 * 60000).toISOString()).all();
  let done = 0;
  for (const r of results || []) { try { const f = await finishCheckout(env, db, r.user_id, r.id, stripe); if (f.paid && !f.already) done++; } catch (e) { console.log("report sweep", r.id, String(e.message || e)); } }
  return done;
}

// ---------- the printable report ----------
const PRINT_CSS = `*{box-sizing:border-box}body{margin:0;color:#111;font:12.5px/1.45 Georgia,"Times New Roman",serif;background:#fff}
.w{max-width:860px;margin:0 auto;padding:28px 32px}h1{font-size:22px;margin:0 0 2px}h2{font-size:14px;margin:22px 0 6px;border-bottom:1px solid #999;padding-bottom:3px;text-transform:uppercase;letter-spacing:.04em}
.m{color:#555;font-size:11.5px}.hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:14px}
table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:6px 6px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}th{font-size:10.5px;color:#444;text-transform:uppercase;letter-spacing:.03em}
.r{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.tot td{border-top:2px solid #111;border-bottom:none;font-weight:700}
.item{page-break-inside:avoid;border:1px solid #ddd;border-radius:6px;padding:10px 12px;margin:10px 0}.item h3{margin:0 0 4px;font-size:13.5px}
.item img{float:right;width:96px;height:96px;object-fit:cover;border-radius:4px;margin:0 0 6px 12px}.comps{font-size:11px;color:#333;margin:6px 0 0;padding-left:16px}
.box{border:1px solid #999;padding:10px 12px;font-size:11px;margin-top:22px}.sig{margin-top:30px;display:flex;gap:40px}.sig div{flex:1;border-top:1px solid #111;padding-top:4px;font-size:11px}
@media print{.noprint{display:none}.w{padding:0}}.noprint{background:#fff8e6;border:1px solid #e0c060;padding:8px 12px;border-radius:6px;margin-bottom:14px;font:13px system-ui}`;

export function printHtml(rep, origin) {
  const d = s => s ? String(s).slice(0, 10) : "";
  const est = rep.items.filter(i => i.low !== null), pending = rep.items.filter(i => i.low === null);
  const row = (i, n) => `<tr><td>${n}</td><td>${esc(i.title)}${i.description ? `<div class="m">${esc(String(i.description).slice(0, 140))}</div>` : ""}</td><td class="r">${i.low !== null ? `${dollars(i.low)} – ${dollars(i.high)}` : "<span class='m'>not estimated</span>"}</td><td class="r">${i.sold ? `${i.sold.count} · med. ${dollars(i.sold.median)}` : "<span class='m'>—</span>"}</td><td class="r">${i.confidence ? Math.round(i.confidence * 100) + "%" : ""}</td></tr>`;
  const detail = (i, n) => `<div class="item">${i.photo ? `<img src="${esc(i.photo)}" alt="">` : ""}<h3>${n}. ${esc(i.title)}</h3>
<div>${i.low !== null ? `<b>Estimated market range: ${dollars(i.low)} – ${dollars(i.high)}</b>${i.retail ? ` (point estimate ${dollars(i.retail)})` : ""}${i.estimated_at ? ` <span class="m">as of ${esc(d(i.estimated_at))}</span>` : ""}` : "<b>Not estimated</b>"}${i.thin ? ' <span class="m">· few comparable sales; treat as a rough guess</span>' : ""}</div>
${i.description ? `<div class="m">Described as: ${esc(i.description)}${i.markings ? ` · Marks: ${esc(i.markings)}` : ""}</div>` : ""}
${i.sold ? `<div class="m">Recent eBay sales of comparable items: ${i.sold.count}, from ${dollars(i.sold.low)} to ${dollars(i.sold.high)}, median ${dollars(i.sold.median)}${i.sold.as_of ? ` (checked ${esc(d(i.sold.as_of))})` : ""}.</div>` : ""}
${i.comps.length ? `<ol class="comps">${i.comps.map(c => `<li>${esc(c.title)} — ${dollars(c.price)}${c.sold ? " (sold)" : " (asking)"}${c.url ? ` <span class="m">${esc(c.url.replace(/^https:\/\/(www\.)?/, ""))}</span>` : ""}</li>`).join("")}</ol>` : ""}
${i.warnings.length ? `<div class="m" style="margin-top:4px">Notes: ${i.warnings.map(esc).join(" · ")}</div>` : ""}</div>`;
  const body = `<div class="noprint">This is the print view. Use your browser's Print and choose "Save as PDF". <a href="/report/${esc(rep.id)}">Back to the report</a>.</div>
<div class="hd"><div><h1>${esc(rep.heading)}: ${esc(rep.title)}</h1><div class="m">${esc(rep.purpose_label || "")}${rep.owner_name ? ` · Prepared for ${esc(rep.owner_name)}` : ""}</div></div>
<div class="m" style="text-align:right">Prepared ${esc(d(new Date().toISOString()))}<br>Guestimator · theguestimator.com<br>Report ${esc(rep.id.slice(0, 8))}</div></div>
<p>This report lists ${rep.items.length} item${rep.items.length === 1 ? "" : "s"} with a market estimate for each, drawn from recent completed sales and current listings of comparable items on eBay (United States, USD). Each estimate is a range: what a comparable item has been selling for between private parties, not a replacement cost and not a formal appraisal. The sales behind every figure are listed so they can be checked.</p>
${rep.notes ? `<p class="m">${esc(rep.notes)}</p>` : ""}
<h2>Summary</h2><table><thead><tr><th>#</th><th>Item</th><th class="r">Estimated range</th><th class="r">eBay sales</th><th class="r">Confidence</th></tr></thead><tbody>
${rep.items.map((i, k) => row(i, k + 1)).join("")}
<tr class="tot"><td></td><td>Total of ${est.length} estimated item${est.length === 1 ? "" : "s"}${pending.length ? ` <span class="m" style="font-weight:400">(${pending.length} not estimated, excluded)</span>` : ""}</td><td class="r">${dollars(rep.total.low)} – ${dollars(rep.total.high)}</td><td class="r"></td><td class="r"></td></tr></tbody></table>
<h2>Items and the sales behind each estimate</h2>${rep.items.map((i, k) => detail(i, k + 1)).join("")}
<div class="box"><b>Basis and limits.</b> Estimates were produced by Guestimator, a software service of Banksy AI LLC, from the descriptions and photographs supplied by the person who prepared this report and from publicly available eBay sold and active listings on the dates shown. They are market estimates of what comparable items have recently sold for between private parties on eBay. They are not an appraisal, not a certified or USPAP valuation, not a replacement-cost figure for insurance, and not legal, tax or financial advice. Guestimator did not inspect the items; authenticity, condition and completeness are as described by the preparer. Where few comparable sales were found, the range is marked as a rough guess. Prices change; figures should be re-checked before being relied on. Totals add the ranges of estimated items only.</div>
<div class="sig"><div>Prepared by (name)</div><div>Date</div><div>Signature</div></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(rep.heading)}: ${esc(rep.title)} | Guestimator</title><style>${PRINT_CSS}</style></head><body><div class="w">${body}</div></body></html>`;
}

// ---------- public landing page: /inventory-report ----------
const PAGE_CSS = `:root{--ink:#111;--mut:#5a5a5a;--line:#e5e5e5;--acc:#a55a42;--btn:#d97757}*{box-sizing:border-box}body{margin:0;color:var(--ink);font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;background:#fff}
.w{max-width:820px;margin:0 auto;padding:16px}header a{color:var(--btn);font-weight:800;text-decoration:none;font-family:Georgia,serif;font-size:1.2rem}h1{font:700 1.9rem/1.2 Georgia,serif;margin:18px 0 8px}h2{font-size:1.15rem;margin:26px 0 8px}
.m{color:var(--mut);font-size:.9rem}.card{border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin:12px 0}.cta{display:inline-block;background:var(--btn);color:#fff;font-weight:800;text-decoration:none;padding:12px 18px;border-radius:12px;border:0;font-size:1rem;cursor:pointer}
.tiers{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}.tier{border:1px solid var(--line);border-radius:14px;padding:14px 16px}.tier b{font-size:1.5rem;display:block}a{color:var(--acc)}
table{width:100%;border-collapse:collapse;font-size:.92rem}td,th{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:.75rem;color:var(--mut);text-transform:uppercase}.r{text-align:right;white-space:nowrap}
input,select,textarea{font:inherit;padding:9px 10px;border:1px solid #bbb;border-radius:10px;width:100%}label{display:block;font-size:.85rem;color:var(--mut);margin:10px 0 4px}.row{display:flex;gap:10px;flex-wrap:wrap}.row>*{flex:1;min-width:160px}
.btn{background:#fff;color:var(--ink);border:1px solid #bbb;border-radius:10px;padding:8px 12px;font:inherit;cursor:pointer}.btn.p{background:var(--btn);color:#fff;border-color:var(--btn);font-weight:700}.ok{color:#1b7f3b}.bad{color:#b3261e}
ul.l{list-style:none;padding:0;margin:0}ul.l li{padding:10px 0;border-bottom:1px solid var(--line);display:flex;gap:10px;align-items:flex-start}ul.l img{width:56px;height:56px;object-fit:cover;border-radius:8px}`;
const pageShell = (title, desc, canonical, body, { noindex = false } = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}">${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ""}${noindex ? '<meta name="robots" content="noindex,nofollow">' : ""}<link rel="icon" href="/icon.svg"><style>${PAGE_CSS}</style></head>
<body><div class="w"><header><a href="/">Guestimator</a> <span class="m">· <a href="/inventory-report">Inventory reports</a></span></header>${body}
<p class="m" style="margin-top:28px">Guestimator is a software service of Banksy AI LLC. Estimates are market estimates from public eBay data, not appraisals or certified valuations, and nothing here is legal, tax or insurance advice.</p></div></body></html>`;

export function landingHtml(origin) {
  const tiers = Object.entries(TIERS).map(([k, t]) => `<div class="tier"><b>${money(t.cents)}</b>${esc(t.label)}<div class="m">one report · every item estimated · printable</div></div>`).join("");
  const body = `<h1>A contents inventory with a market estimate on every line</h1>
<p>For an insurance claim, a marital-property schedule, or an estate inventory, you need a list of what there is and what each thing is worth, with something behind the numbers. Guestimator prices each item from recent eBay sales of comparable items and gives you a printable report that shows the sales it used. You add the items; the report does the looking up.</p>
<p><a class="cta" href="/report/new">Start a report</a> <span class="m" style="margin-left:10px">Free account. Pay only when you want the report.</span></p>
<h2>Who uses it</h2>
<div class="card"><b>Insurance claims and household inventories.</b> After a loss, adjusters ask for an itemised list with values. A room-by-room inventory with a market range per item and the comparable sales listed is a stronger starting point than a spreadsheet of guesses. Also useful before a loss: an inventory of what you own, with photos, is the document everyone wishes they had.</div>
<div class="card"><b>Divorce and separation.</b> Personal property gets listed and valued so it can be divided. Furniture, electronics, collections, tools, equipment: each item gets a defensible market range from what comparable items actually sold for, and both sides can see where the figures came from.</div>
<div class="card"><b>Estates and probate.</b> Executors and administrators have to inventory the contents of a home and put values on them. Most of it is ordinary household goods that no appraiser will visit for. The report gives each item a market range and keeps the evidence attached. Where an item appears to be worth a formal appraisal, the report says so.</div>
<h2>What it costs</h2><div class="tiers">${tiers}</div>
<p class="m">One flat price per report. Every item in the report gets a Guestimate; you can re-run any of them. The report prints to PDF from your browser.</p>
<h2>How it works</h2>
<table><tbody><tr><td>1</td><td>Start a report, pick what it is for, and give it a title (an address, a case caption, a decedent's name).</td></tr>
<tr><td>2</td><td>Add items: a photo or two and a line of description each. Add them from your phone as you walk through the rooms, or type them in from a list.</td></tr>
<tr><td>3</td><td>Guestimator prices each item from recent eBay sales of comparable items and shows the sales it used.</td></tr>
<tr><td>4</td><td>Print the report: a summary table with a total, then one section per item with its photo, range, the comparable sales, and a basis-and-limits statement.</td></tr></tbody></table>
<h2>What the report is, and is not</h2>
<p>It is a market estimate: what comparable items have recently sold for between private parties on eBay, in US dollars, as of the dates shown, with the sales listed. It is not an appraisal and not a certified or USPAP valuation; Guestimator does not inspect items, and nobody at Guestimator is a licensed appraiser. It is not a replacement-cost figure (what a new equivalent would cost), which is what some insurance policies pay on; the report says which figure it gives. And it is not legal advice: whether a court, an adjuster or a probate clerk will accept any particular document is a question for your lawyer or your insurer. Many will take an itemised inventory with sourced market ranges for ordinary household contents; for jewellery, fine art, vehicles and other high-value items they will usually want a formal appraisal, and the report flags items that look like candidates.</p>
<p><a class="cta" href="/report/new">Start a report</a></p>`;
  return pageShell("Inventory report with market estimates: insurance, divorce, estate | Guestimator", "A printable contents inventory with a market estimate for every item and the eBay sales behind each. For insurance claims, marital-property schedules and estate inventories. Flat price per report.", origin + "/inventory-report", body);
}

// ---------- the report page: /report/new and /report/<id> (the JS talks to /api/reports) ----------
export function reportPageHtml(id, origin) {
  const isNew = id === "new";
  const tierOpts = Object.entries(TIERS).map(([k, t]) => `<option value="${k}">${esc(t.label)} · ${money(t.cents)}</option>`).join("");
  const purposeOpts = Object.entries(PURPOSES).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join("");
  const body = isNew ? `<h1>Start an inventory report</h1>
<div class="card"><label>What is it for?</label><select id="purpose">${purposeOpts}</select>
<label>Title (an address, a case caption, a decedent's name)</label><input id="title" placeholder="Contents of 12 Elm Street">
<label>Prepared for (optional, as it should read on the report)</label><input id="owner">
<label>Size</label><select id="tier">${tierOpts}</select>
<label>Notes for the front page (optional)</label><textarea id="notes" rows="3"></textarea>
<p><button class="btn p" id="go">Create the report</button> <span class="m">Nothing is charged until you buy the report.</span></p><p id="msg" class="m"></p></div>
<p class="m"><a href="/inventory-report">What the report is and costs</a></p>`
  : `<div id="app"><p class="m">Loading…</p></div>`;
  const js = isNew ? `
const $ = s => document.querySelector(s);
$("#go").onclick = async () => {
  $("#msg").textContent = "Creating…";
  const r = await fetch("/api/reports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ purpose: $("#purpose").value, title: $("#title").value, owner_name: $("#owner").value, tier: $("#tier").value, notes: $("#notes").value }) });
  if (r.status === 401) { $("#msg").innerHTML = 'Please <a href="/?next=' + encodeURIComponent(location.pathname) + '">sign in or create a free account</a> first, then come back to this page.'; return; }
  const j = await r.json(); if (!r.ok) { $("#msg").textContent = j.error || "Something went wrong."; return; }
  location.href = "/report/" + j.id;
};`
  : `
const ID = ${JSON.stringify(id)}, $ = s => document.querySelector(s), esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dollars = n => "$" + Math.round(Number(n)).toLocaleString("en-US"), money = c => "$" + (c / 100).toFixed(2);
let rep = null, busy = false;
async function load() {
  const r = await fetch("/api/reports/" + ID);
  if (r.status === 401) { $("#app").innerHTML = '<h1>Inventory report</h1><p>Please <a href="/?next=' + encodeURIComponent(location.pathname) + '">sign in</a> to see this report.</p>'; return; }
  if (!r.ok) { $("#app").innerHTML = "<h1>Inventory report</h1><p>That report isn't here.</p>"; return; }
  rep = await r.json(); render();
}
function render() {
  const c = rep.counts, paid = rep.status === "paid", pending = rep.items.filter(i => i.status !== "done");
  const items = rep.items.map((i, k) => '<li>' + (i.photo ? '<img src="' + esc(i.photo) + '" alt="">' : '') + '<div style="flex:1"><b>' + (k + 1) + '. ' + esc(i.title) + '</b>' + (i.description ? '<div class="m">' + esc(i.description) + '</div>' : '') +
    '<div>' + (i.low !== null ? dollars(i.low) + ' – ' + dollars(i.high) + (i.sold ? ' <span class="m">· ' + i.sold.count + ' eBay sales</span>' : '') + (i.thin ? ' <span class="m">· rough guess</span>' : '') : (i.status === "pending" ? '<span class="m">Guestimating…</span>' : '<span class="m">not estimated yet</span>')) + '</div></div>' +
    '<div><a href="/#item/' + esc(i.id) + '" class="m">open</a> · <a href="#" class="m" data-rm="' + esc(i.id) + '">remove</a></div></li>').join("");
  $("#app").innerHTML = '<div class="m"><a href="/inventory-report">Inventory reports</a> › ' + esc(rep.heading) + '</div><h1>' + esc(rep.title) + '</h1>' +
    '<div class="m">' + esc(rep.purpose_label) + (rep.owner_name ? ' · for ' + esc(rep.owner_name) : '') + ' · ' + esc(rep.tier_label) + '</div>' +
    '<div class="card">' + (paid
      ? '<b class="ok">Paid.</b> ' + c.items + ' of ' + c.cap + ' items added, ' + c.estimated + ' estimated. ' + (pending.length ? '<button class="btn p" id="runall">Guestimate the ' + pending.length + ' waiting</button> ' : '') + (c.estimated ? '<a class="btn" href="/report/' + esc(rep.id) + '/print" target="_blank">Open the printable report</a>' : '') +
        (c.estimated ? '<div style="margin-top:8px">Total of estimated items: <b>' + dollars(rep.total.low) + ' – ' + dollars(rep.total.high) + '</b></div>' : '')
      : '<b>Not paid yet.</b> ' + c.items + ' of ' + c.cap + ' items added. Buying the report (' + money(rep.price_cents) + ') unlocks a Guestimate for every item and the printable report. <button class="btn p" id="buy">Buy the report · ' + money(rep.price_cents) + '</button>') +
    ' <span id="msg" class="m"></span></div>' +
    '<h2>Items (' + c.items + ')</h2><ul class="l" id="items">' + (items || '<li class="m">Nothing added yet.</li>') + '</ul>' +
    '<div class="card"><h2 style="margin-top:0">Add an item</h2><div class="row"><div><label>What is it?</label><input id="nm" placeholder="Kenmore sewing machine, model 158"></div></div>' +
    '<label>Describe it: maker, model, size, condition, anything written on it</label><textarea id="ds" rows="2"></textarea>' +
    '<label>Photos (optional, up to 4)</label><input id="ph" type="file" accept="image/*" multiple>' +
    '<p><button class="btn p" id="add">Add to the report</button> <span class="m">Tip: on a phone, photograph each item as you go through the rooms.</span></p></div>' +
    '<div class="card"><h2 style="margin-top:0">Add items you already have in Guestimator</h2><div id="mine" class="m">Loading…</div></div>';
  if ($("#buy")) $("#buy").onclick = buy;
  if ($("#runall")) $("#runall").onclick = runAll;
  $("#add").onclick = addItem;
  document.querySelectorAll("[data-rm]").forEach(a => a.onclick = async e => { e.preventDefault(); await fetch("/api/reports/" + ID + "/items/" + a.dataset.rm, { method: "DELETE" }); load(); });
  loadMine();
}
async function loadMine() {
  const r = await fetch("/api/items"); if (!r.ok) return; const all = await r.json(); const have = new Set(rep.items.map(i => i.id));
  const rest = all.filter(i => !have.has(i.id)).slice(0, 200);
  $("#mine").innerHTML = rest.length ? rest.map(i => '<label style="display:flex;gap:8px;align-items:center;margin:4px 0;font-size:.95rem;color:#111"><input type="checkbox" value="' + esc(i.id) + '" style="width:auto">' + esc(i.ai_title || i.name) + (i.est_low ? ' <span class="m">' + dollars(i.est_low) + '–' + dollars(i.est_high) + '</span>' : '') + '</label>').join("") + '<p><button class="btn" id="addmine">Add the ticked items</button></p>' : "Nothing else in your account yet.";
  if ($("#addmine")) $("#addmine").onclick = async () => { const ids = [...document.querySelectorAll("#mine input:checked")].map(x => x.value); if (!ids.length) return; const r = await fetch("/api/reports/" + ID + "/items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ item_ids: ids }) }); const j = await r.json(); if (j.over) alert(j.over + " item(s) didn't fit: this report holds " + j.cap + "."); load(); };
}
async function addItem() {
  if (busy) return; busy = true; const name = $("#nm").value.trim(), desc = $("#ds").value.trim(); if (!name) { busy = false; return; }
  const r = await fetch("/api/items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, description: desc, markings: "" }) }); const j = await r.json();
  if (!r.ok) { busy = false; alert(j.error || "Couldn't add it."); return; }
  const files = [...($("#ph").files || [])].slice(0, 4);
  if (files.length) { const fd = new FormData(); files.forEach(f => fd.append("photos", f)); await fetch("/api/items/" + j.id + "/photos", { method: "POST", body: fd }); }
  const a = await fetch("/api/reports/" + ID + "/items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ item_ids: [j.id] }) }); const aj = await a.json();
  if (aj.over) alert("This report holds " + aj.cap + " items; that one didn't fit.");
  else if (rep.status === "paid") await guestimate(j.id, files.length === 0, desc || name);
  busy = false; load();
}
async function guestimate(itemId, wordsOnly, desc) {
  const r = await fetch("/api/items/" + itemId + "/appraise", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(wordsOnly ? { words_only: true, dealer_description: desc } : { dealer_description: desc }) });
  if (r.status === 402) { $("#msg").textContent = "Out of Guestimates for this report."; return false; } return r.ok;
}
async function runAll() {
  const pending = rep.items.filter(i => i.status !== "done" && i.status !== "pending"); $("#msg").textContent = "Starting " + pending.length + "…";
  for (const i of pending) await guestimate(i.id, !i.photo, i.description || i.name);
  setTimeout(load, 1500); const t = setInterval(async () => { await load(); if (!rep.items.some(i => i.status === "pending")) clearInterval(t); }, 8000);
}
async function buy() {
  $("#msg").textContent = "Opening checkout…";
  const r = await fetch("/api/reports/" + ID + "/checkout", { method: "POST" }); const j = await r.json();
  if (!r.ok || !j.url) { $("#msg").textContent = j.error || "Checkout didn't open."; return; }
  location.href = j.url;
}
(async () => {
  if (new URLSearchParams(location.search).get("paid") === "1") { await fetch("/api/reports/" + ID + "/finish", { method: "POST" }); history.replaceState(null, "", location.pathname); }
  load();
})();`;
  return pageShell(isNew ? "Start an inventory report | Guestimator" : "Inventory report | Guestimator", "Inventory report with market estimates.", null, body + `<script>${js}</script>`, { noindex: true });
}
