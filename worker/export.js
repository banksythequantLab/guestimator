// A garage sale's items as a spreadsheet: CSV (opens in Excel, Google Sheets, Numbers) and a real
// .xlsx. The .xlsx is built by hand - five small XML parts in a ZIP with no compression ("stored"),
// which every spreadsheet program reads - so the Worker needs no library.

const enc = new TextEncoder();

/** The columns, in order. type: text | money (dollars, from cents) | date. */
export const COLUMNS = [
  { key: "name", header: "Item", width: 34 },
  { key: "description", header: "Description", width: 48 },
  { key: "price_cents", header: "Tag price", type: "money", width: 11 },
  { key: "online_price_cents", header: "Online price", type: "money", width: 12 },
  { key: "ship_cents", header: "Shipping", type: "money", width: 10 },
  { key: "status", header: "Status", width: 11 },
  { key: "sold_at", header: "Sold on", type: "date", width: 12 },
  { key: "guess_low_cents", header: "Guestimate low", type: "money", width: 15 },
  { key: "guess_high_cents", header: "Guestimate high", type: "money", width: 15 },
  { key: "item_url", header: "Item page", width: 40 },
  { key: "photo_url", header: "Photo", width: 40 },
];

// A cell that starts with = + - @ (or tab/CR) is run as a formula by Excel. Item names come from
// the seller, but a sale page item could be named anything, so text cells are defused.
const defuse = s => /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
// (Only CSV needs it: an .xlsx text cell is never read as a formula.)
const cellText = (c, v, csv = true) => {
  if (v === null || v === undefined || v === "") return "";
  if (c.type === "money") return (Number(v) / 100).toFixed(2);
  if (c.type === "date") return String(v).slice(0, 10);
  return csv ? defuse(String(v)) : String(v);
};

export function toCsv(rows, cols = COLUMNS) {
  const q = s => /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const lines = [cols.map(c => q(c.header)).join(",")];
  for (const r of rows) lines.push(cols.map(c => q(cellText(c, r[c.key]))).join(","));
  // The byte-order mark tells Excel the file is UTF-8 (accents, "½", "×" survive).
  return "﻿" + lines.join("\r\n") + "\r\n";
}

// ---------- .xlsx ----------
const xml = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
const colName = i => { let s = ""; for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };
const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RNS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";

function sheetXml(rows, cols) {
  const head = `<row r="1">${cols.map((c, i) => `<c r="${colName(i)}1" t="inlineStr" s="1"><is><t>${xml(c.header)}</t></is></c>`).join("")}</row>`;
  const body = rows.map((r, n) => {
    const rn = n + 2;
    return `<row r="${rn}">${cols.map((c, i) => {
      const v = r[c.key], ref = `${colName(i)}${rn}`;
      if (v === null || v === undefined || v === "") return "";
      if (c.type === "money" && Number.isFinite(Number(v))) return `<c r="${ref}" s="2"><v>${Number(v) / 100}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(cellText(c, v, false))}</t></is></c>`;
    }).join("")}</row>`;
  }).join("");
  const last = `${colName(cols.length - 1)}${rows.length + 1}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS}" xmlns:r="${RNS}">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<cols>${cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}" customWidth="1"/>`).join("")}</cols>` +
    `<sheetData>${head}${body}</sheetData><autoFilter ref="A1:${last}"/></worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="${NS}">` +
  `<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts>` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

const sheetName = s => (String(s || "Items").replace(/[\\/?*[\]:']/g, " ").trim() || "Items").slice(0, 31);

let CRC;
function crc32(bytes) {
  if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** A ZIP with every file stored uncompressed. files: [{ name, data: Uint8Array }]. */
export function zipStored(files, when = new Date()) {
  const dosTime = (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | (when.getUTCSeconds() >> 1);
  const dosDate = ((when.getUTCFullYear() - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate();
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    locals.push(new Uint8Array(lh.buffer), name, f.data);
    centrals.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + size;
  }
  const cdSize = centrals.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export function toXlsx(rows, { sheet = "Items", cols = COLUMNS, when } = {}) {
  const name = sheetName(sheet);
  const head = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;
  const files = [
    ["[Content_Types].xml", `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ["_rels/.rels", `${head}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${RNS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `${head}<workbook xmlns="${NS}" xmlns:r="${RNS}"><sheets><sheet name="${xml(name)}" sheetId="1" r:id="rId1"/></sheets>` +
      `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${xml(name)}'!$A$1:$${colName(cols.length - 1)}$${rows.length + 1}</definedName></definedNames></workbook>`],
    ["xl/_rels/workbook.xml.rels", `${head}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${RNS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${RNS}/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", STYLES],
    ["xl/worksheets/sheet1.xml", sheetXml(rows, cols)],
  ];
  return zipStored(files.map(([n, s]) => ({ name: n, data: enc.encode(s) })), when);
}

/** File name for a sale's export: "spring-yard-sale-2026-10-10-items.csv". */
export function exportName(sale, ext) {
  const slug = String(sale.title || "sale").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "sale";
  return `${slug}-${sale.starts_on || "items"}-items.${ext}`;
}
