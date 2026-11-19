// Spanish price pages (2026-11-19): /es/price/<slug>-<id> and /es/prices. Same data as the English
// page (guideOf), Spanish page text, a Spanish title from guide_es, and hreflang links both ways.
// "cuánto vale" searches for the same games and consoles have almost no competition. The
// comparables keep their English eBay titles - they are the listings, not our words.
import { esc, dollars, day, slugify, shell, hubOf, hubPath, relatedGuides, pagePath, hubsWith } from "./priceguide.js";
import { epn } from "./epn.js";
import { cfg, textJson } from "./appraiser.js";

export const esPath = g => `/es/price/${slugify(g.es && g.es.title)}-${g.listing_id}`;
export const hasEs = g => !!(g && g.es && g.es.title);

export const HUB_ES = { "trading-cards": "Cartas coleccionables", "video-games": "Videojuegos y consolas", "film-cameras": "Cámaras analógicas",
  "vintage-audio": "Audio vintage", "sewing-machines": "Máquinas de coser", kitchen: "Cocina", watches: "Relojes", "computer-parts": "Componentes de PC y electrónica", more: "Más hallazgos" };
const hubNameEs = h => HUB_ES[h.slug] || h.name;

const fecha = s => { const d = day(s); if (!d) return ""; const [y, m, dd] = d.split("-"); const M = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]; return `${Number(dd)} de ${M[Number(m) - 1] || m} de ${y}`; };

export function itemFaqEs(g) {
  const out = [], r = g.range, t = g.es.title;
  const basis = g.sold ? `, según ${g.sold.count} ventas recientes en eBay con una mediana de ${dollars(g.sold.median)}`
    : g.market ? `, según ${g.market.count} anuncios comparables en eBay` : "";
  out.push({ q: `¿Cuánto vale un ${t}?`,
    a: `Entre ${dollars(r.low)} y ${dollars(r.high)} al ${fecha(g.estimated_at)}${basis}.` +
       (g.market && g.market.count ? ` Ahora mismo hay ejemplares a la venta entre ${dollars(g.market.low)} y ${dollars(g.market.high)}, pero los precios pedidos suelen ser más altos que los de venta real.` : "") +
       (g.thin ? " Se encontraron pocas ventas reales, así que tómalo como una estimación aproximada." : "") });
  const sold = (g.comps || []).filter(c => c.sold).slice(0, 4);
  if (sold.length >= 2)
    out.push({ q: `¿Por cuánto se ha vendido un ${t} últimamente?`,
      a: `Ventas recientes en eBay: ${sold.map(c => `${dollars(c.price)} (${c.title.length > 70 ? c.title.slice(0, 70).replace(/\s+\S*$/, "") + "…" : c.title})`).join("; ")}.` });
  out.push({ q: "¿Qué hace que valga más o menos?",
    a: "El estado lo es casi todo: completo con caja y manual vale mucho más que suelto, y un ejemplar probado y funcionando vale más que uno sin probar. Los precios son de ventas reales en eBay en Estados Unidos, en dólares." });
  return out;
}

const FOOT_ES = "Los Guestimates son estimaciones de mercado a partir de datos públicos de eBay en la fecha indicada, no tasaciones certificadas. Los precios cambian; compruébalos antes de comprar o vender. Como socio de eBay (eBay Partner Network), Guestimator puede recibir una comisión por las compras hechas a través de los enlaces de esta página.";

export function guidePageEs(g, origin, more = []) {
  const t = g.es.title, url = origin + esPath(g), r = g.range;
  const name = t.length > 48 ? t.slice(0, 48).replace(/[\s,;:–-]+\S*$/, "") + "…" : t;
  const title = `${name}: precio ${dollars(r.low)}–${dollars(r.high)}`;
  const desc = `Un ${t} vale entre ${dollars(r.low)} y ${dollars(r.high)} según ${g.sold ? `${g.sold.count} ventas recientes en eBay` : g.market ? `${g.market.count} anuncios comparables en eBay` : "los anuncios actuales de eBay"} (${day(g.estimated_at)}). Consigue un Guestimate del tuyo.`;
  const about = [g.about.maker && `Fabricante: ${g.about.maker}`, (g.es.category || g.about.category) && `Categoría: ${g.es.category || g.about.category}`, g.about.period && `Época: ${g.about.period}`].filter(Boolean);
  const offers = g.live ? { "@type": "Offer", price: g.live.price.toFixed(2), priceCurrency: "USD", availability: "https://schema.org/InStock", url: g.live.url }
    : g.market && g.market.low > 0 && g.market.high > 0 ? { "@type": "AggregateOffer", lowPrice: Number(g.market.low).toFixed(2), highPrice: Number(g.market.high).toFixed(2), offerCount: g.market.count, priceCurrency: "USD" } : null;
  const jsonld = offers ? { "@context": "https://schema.org", "@type": "Product", name: t, ...(g.about.maker ? { brand: { "@type": "Brand", name: g.about.maker } } : {}), offers } : null;
  const hub = hubOf(g);
  const crumbs = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Guía de precios", item: origin + "/es/prices" },
    { "@type": "ListItem", position: 2, name: hubNameEs(hub), item: origin + hubPath(hub) }, { "@type": "ListItem", position: 3, name: t, item: url }] };
  const faq = itemFaqEs(g);
  const rel = relatedGuides(g, more, 6);
  const per = g.lot && !g.lot.whole_set;
  const body = `<div class="m"><a href="/es/prices">Guía de precios</a> › <a href="${esc(hubPath(hub))}">${esc(hubNameEs(hub))}</a></div><h1>${esc(t)}: cuánto vale</h1><div class="m">Guestimado el ${esc(fecha(g.estimated_at))} · <a href="${esc(pagePath(g))}" hreflang="en">English</a></div>
<div class="card"><div class="m">${g.thin ? "Guestimate · estimación aproximada" : "Guestimate"}${g.lot ? ` · por las ${g.lot.count} piezas` : ""}</div><div class="big">${dollars(r.low)} – ${dollars(r.high)}</div>
${g.lot && g.lot.unit_low && g.lot.unit_high ? `<div class="m" style="margin-top:4px">Unos ${dollars(g.lot.unit_low)}–${dollars(g.lot.unit_high)} por pieza${g.lot.whole_set ? ", a partir de ventas del juego completo" : `; las ventas y comparables de abajo son de piezas sueltas, y el total del juego es ${g.lot.count} veces eso`}.</div>` : ""}
${g.thin ? `<div class="m" style="margin-top:4px">Pocas ventas reales con las que comparar (${g.comps.length ? "un anuncio comparable" : "ninguna encontrada"}), así que toma este rango como una estimación aproximada.</div>` : ""}
${g.sold ? `<div style="margin-top:6px"><b>Vendidos recientemente en eBay${per ? " (por pieza)" : ""}:</b> mediana ${dollars(g.sold.median)} en ${g.sold.count} ventas <span class="m">(comprobado el ${esc(day(g.sold.as_of))})</span></div>` : ""}
${g.market ? `<div style="margin-top:4px"><b>En venta ahora${per ? " (por pieza)" : ""}:</b> ${dollars(g.market.low)}–${dollars(g.market.high)} en ${g.market.count} anuncios comparables, mediana ${dollars(g.market.median)}</div>` : ""}</div>
${g.live ? `<div class="card"><b>Este está a la venta:</b> ${dollars(g.live.price)} en eBay. <a href="${esc(epn(g.live.url, "gs-guide-es"))}" rel="sponsored nofollow noopener" target="_blank">Ver el anuncio ↗</a></div>` : ""}
${about.length ? `<h2>Sobre el artículo</h2><div>${about.map(esc).join(" · ")}</div>` : ""}
${g.comps.length ? `<h2>Anuncios comparables con los que se fijó el precio${per ? " (piezas sueltas)" : ""}</h2><table><thead><tr><th>Anuncio</th><th>Estado</th><th class="r">Precio</th></tr></thead><tbody>
${g.comps.map(c => `<tr><td>${c.url ? `<a href="${esc(epn(c.url, "gs-guide-es-comp"))}" rel="sponsored nofollow noopener" target="_blank">${esc(c.title)}</a>` : esc(c.title)}${c.sold ? " <b>(vendido)</b>" : ""}</td><td>${esc(c.condition || "")}</td><td class="r">${dollars(c.price)}</td></tr>`).join("")}</tbody></table><p class="m">Los títulos de los anuncios aparecen tal como se publicaron en eBay, en inglés. Precios en dólares estadounidenses.</p>` : ""}
${faq.length ? `<h2>Preguntas frecuentes</h2>${faq.map(q => `<h3 style="font-size:1rem;margin:14px 0 4px">${esc(q.q)}</h3><p style="margin:0">${esc(q.a)}</p>`).join("")}` : ""}
<div class="card" style="margin-top:22px"><h2 style="margin-top:0">¿Tienes uno para vender?</h2><p>Haz 2–4 fotos y Guestimator pone precio al tuyo según lo que se está vendiendo ahora, y lo publica en tu propia cuenta de eBay. Tú revisas cada palabra antes.</p>
<a class="cta" href="/?utm_source=price_guide_es">Guestimar el mío</a></div>
${rel.length ? `<h2>Precios relacionados</h2><ul class="l">${rel.map(o => `<li><a href="${esc(hasEs(o) ? esPath(o) : pagePath(o))}"${hasEs(o) ? "" : ' hreflang="en"'}>${esc(hasEs(o) ? o.es.title : o.title)}</a><div class="m">${dollars(o.range.low)}–${dollars(o.range.high)}</div></li>`).join("")}</ul>` : ""}`;
  const faqLd = faq.length ? { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map(q => ({ "@type": "Question", name: q.q, acceptedAnswer: { "@type": "Answer", text: q.a } })) } : null;
  return shell(title, desc, url, body, [jsonld, crumbs, faqLd].filter(Boolean),
    { lang: "es", header: { href: "/es/prices", text: "Guía de precios Guestimator" }, footer: FOOT_ES,
      alternates: [{ hreflang: "en", href: origin + pagePath(g) }, { hreflang: "es", href: url }, { hreflang: "x-default", href: origin + pagePath(g) }] });
}

export function indexPageEs(guides, origin) {
  const es = guides.filter(hasEs);
  const groups = hubsWith(es);
  const li = g => `<li><a href="${esc(esPath(g))}"><b>${esc(g.es.title)}</b></a><div class="m">${dollars(g.range.low)}–${dollars(g.range.high)} · ${esc(day(g.estimated_at))}</div></li>`;
  const body = `<h1>¿Cuánto vale? Guía de precios</h1><p class="m">Artículos reales con precio de Guestimator a partir de datos actuales de eBay. ${es.length} artículo${es.length === 1 ? "" : "s"} en español hasta ahora · <a href="/prices" hreflang="en">Ver la guía completa en inglés</a>.</p>
${groups.map(x => `<h2>${esc(hubNameEs(x.hub))}</h2><ul class="l">${x.guides.map(li).join("")}</ul>`).join("") || `<ul class="l"><li class="m">Todavía no hay nada aquí.</li></ul>`}
<div class="card" style="margin-top:22px"><h2 style="margin-top:0">¿Tienes algo para vender?</h2><p>Haz unas fotos y Guestimator le pone precio según lo que se está vendiendo ahora.</p><a class="cta" href="/?utm_source=price_guide_es">Guestimar el mío</a></div>`;
  return shell("¿Cuánto vale? Guía de precios | Guestimator", "Precios reales de videojuegos, consolas, cámaras, relojes y más, a partir de ventas recientes en eBay.", origin + "/es/prices", body, null,
    { lang: "es", header: { href: "/es/prices", text: "Guía de precios Guestimator" }, footer: FOOT_ES,
      alternates: [{ hreflang: "en", href: origin + "/prices" }, { hreflang: "es", href: origin + "/es/prices" }, { hreflang: "x-default", href: origin + "/prices" }] });
}

// ---------- translation sweep (owner) ----------
// The game and console titles are templated ("<name> <platform> cartridge"), and the model's batch
// translations of them came back word-swapped in English order ("Sega Saturn consola", "Zelda:
// Majora's Mask N64 cartucho") about half the time (2026-11-19). A rule gives every templated
// title the same grammatical shape; the model is only asked about titles no rule fits.
const PLATFORM = "(?:Nintendo 64|N64|SNES|Super Nintendo|NES|GBA|Game Boy Advance|Game Boy Color|Game Boy|Nintendo DS|DS|3DS|Sega Genesis|Genesis|GameCube|Wii U|Wii|PS1|PS2|PS3|PlayStation 2|PlayStation|Xbox 360|Xbox|Dreamcast|Saturn)";
const PLAT_ES = { N64: "Nintendo 64", GBA: "Game Boy Advance", PS2: "PlayStation 2", PS1: "PlayStation", DS: "Nintendo DS" };
const plat = p => PLAT_ES[p] || p;
export function titleEsRule(title) {
  const t = String(title || "").trim();
  let m;
  if ((m = t.match(new RegExp(`^(.+?)\\s+${PLATFORM}\\s+cartridge$`, "i")))) return `Cartucho de ${m[1]} para ${plat(t.match(new RegExp(`\\s(${PLATFORM})\\s+cartridge$`, "i"))[1])}`;
  if ((m = t.match(new RegExp(`^(.+?)\\s+(${PLATFORM})\\s+game$`, "i")))) return `Juego ${m[1]} para ${plat(m[2])}`;
  if ((m = t.match(/^(.+?)\s+handheld(?:\s+gam(?:e|ing))?\s+console(.*)$/i))) return `Consola portátil ${m[1]}${m[2]}`;
  if ((m = t.match(/^(.+?)\s+console(.*)$/i))) return `Consola ${m[1]}${m[2]}`;
  if ((m = t.match(/^(.+?)\s+Wireless\s+(.+?)\s+Controller$/i))) return `Control inalámbrico ${m[1]} para ${m[2]}`;
  if ((m = t.match(/^(.+?)\s+Controller$/i))) return `Control ${m[1]}`;
  if ((m = t.match(/^Original\s+(.+)$/i))) return `${m[1]} original`;
  if (/^Game Boy (?:Advance SP|Color|Advance|Pocket)\b/i.test(t)) return t.replace(/\bbacklit\b/i, "retroiluminada");
  return null;
}
const TRANSLATE_SYSTEM = `You translate short product titles from English to Spanish for a price guide read by Spanish speakers in the United States.
Rules: keep brand names, model numbers, platform names (GameCube, Nintendo 64, Game Boy Advance, SNES, NES, PlayStation 2, Wii, DS) and card numbers exactly as written;
translate the generic words (cartridge -> cartucho, game -> juego, console -> consola, film camera body -> cuerpo de cámara analógica, watch -> reloj, mixing bowl set -> juego de boles,
cast iron skillet -> sartén de hierro fundido, stereo receiver -> receptor estéreo, sewing machine -> máquina de coser, holo card -> carta holo). Natural, the way someone would type it into eBay.
Return ONLY JSON: {"items":[{"id":"...","title_es":"...","category_es":"..."}]} with one entry per input item, same ids.`;

/** Translate the titles of the given item ids with the model and store them. Returns what was written. */
export async function translateSweep(env, db, ids) {
  const want = [...new Set((ids || []).map(String).filter(Boolean))].slice(0, 60);
  if (!want.length) return { written: [], skipped: [] };
  const marks = want.map(() => "?").join(",");
  const rows = (await db.prepare(`SELECT i.id, COALESCE(NULLIF(i.guide_title,''), i.ai_title, i.name) AS title,
      (SELECT json_extract(a.result_json,'$.identification.category') FROM appraisals a WHERE a.item_id=i.id AND a.status='done' ORDER BY a.created_at DESC LIMIT 1) AS category
    FROM items i WHERE i.id IN (${marks}) AND COALESCE(i.guide_public,0)=1`).bind(...want).all()).results || [];
  const written = [];
  const put = async (id, title, category) => {
    await db.prepare("INSERT INTO guide_es (item_id,title_es,category_es,created_at) VALUES (?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET title_es=excluded.title_es, category_es=excluded.category_es")
      .bind(id, title, category || null, new Date().toISOString()).run();
  };
  const CAT_ES = { "video game": "Videojuego", "video games": "Videojuego", console: "Consola", "game console": "Consola", "handheld console": "Consola portátil", accessory: "Accesorio", controller: "Control" };
  const ruled = [];
  for (const r of rows) {
    const es = titleEsRule(r.title);
    if (!es) continue;
    const cat = CAT_ES[String(r.category || "").toLowerCase()] || (/\bgame\b/i.test(r.category || "") ? "Videojuego" : /console/i.test(r.category || "") ? "Consola" : null);
    await put(r.id, es, cat); written.push({ id: r.id, title_es: es, from: r.title, how: "rule" }); ruled.push(r.id);
  }
  const rest = rows.filter(r => !ruled.includes(r.id));
  const c = cfg(env);
  for (let i = 0; i < rest.length; i += 12) {
    const batch = rest.slice(i, i + 12).map(r => ({ id: r.id, title: r.title, category: r.category || "" }));
    let out;
    try { out = await textJson(c, TRANSLATE_SYSTEM, JSON.stringify({ items: batch }), 1500, { chat_template_kwargs: { enable_thinking: false } }); }
    catch (e) { console.log("translate batch failed", String(e && e.message || e)); continue; }
    for (const it of (out && out.items) || []) {
      const src = batch.find(b => b.id === it.id);
      const title = String((it && it.title_es) || "").trim();
      if (!src || !title || title.length > 160) continue;
      await put(src.id, title, String(it.category_es || "").trim().slice(0, 80));
      written.push({ id: src.id, title_es: title, from: src.title, how: "model" });
    }
  }
  return { written, skipped: want.filter(id => !written.some(w => w.id === id)) };
}
