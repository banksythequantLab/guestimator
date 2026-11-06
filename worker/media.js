// Byte ranges for video served from static assets (2026-11-06). Workers static assets answer a
// Range request with 200 and the whole file (Cloudflare docs, static-assets limitations), and Safari
// will not play an mp4 without 206 Partial Content. So these paths run through the Worker
// (run_worker_first in wrangler.jsonc) and get sliced here.
export const RANGED = new Set(["/how-it-works.mp4"]);

/** Parses one "bytes=" range against a size. null = no/unsupported header (send it all), false = unsatisfiable. */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start, end;
  if (m[1] === "") { const n = Number(m[2]); if (!(n > 0)) return false; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (!(start <= end) || start >= size) return false;
  return { start, end };
}

export async function rangedAsset(request, env, pathname) {
  const asset = await env.ASSETS.fetch(new Request(new URL(pathname, request.url), { method: "GET" }));
  if (!asset.ok) return asset;
  const buf = await asset.arrayBuffer(), size = buf.byteLength;
  const base = { "content-type": asset.headers.get("content-type") || "video/mp4", "accept-ranges": "bytes",
                 "cache-control": "public, max-age=86400" };
  const head = request.method === "HEAD";
  const r = parseRange(request.headers.get("range"), size);
  if (r === false) return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${size}` } });
  if (r === null) return new Response(head ? null : buf, { status: 200, headers: { ...base, "content-length": String(size) } });
  return new Response(head ? null : buf.slice(r.start, r.end + 1), { status: 206,
    headers: { ...base, "content-range": `bytes ${r.start}-${r.end}/${size}`, "content-length": String(r.end - r.start + 1) } });
}
