// Minimal service worker — enables install; network-first, caches app shell.
const CACHE = "gs-v56";
const SHELL = ["/", "/app.js", "/sales.js", "/orders.js", "/billing.js", "/rc-sdk.js", "/manifest.webmanifest", "/icon.svg"];
// Share target (manifest share_target): photos shared from the phone's gallery arrive as a POST
// to /share-target. They're parked in the "gs-share" cache and the app picks them up at /?shared=N.
const SHARE = "gs-share";
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== SHARE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
async function receiveShare(req) {
  const fd = await req.formData();
  const files = fd.getAll("photos").filter(f => f && f.size).slice(0, 8);
  const c = await caches.open(SHARE);
  for (const k of await c.keys()) await c.delete(k);
  await Promise.all(files.map((f, i) => c.put(`/shared/${i}`, new Response(f, { headers: { "content-type": f.type || "image/jpeg", "x-name": encodeURIComponent(f.name || `photo${i + 1}.jpg`) } }))));
  const text = [fd.get("title"), fd.get("text"), fd.get("url")].filter(Boolean).join(" ").trim().slice(0, 500);
  if (text) await c.put("/shared/text", new Response(text));
  return Response.redirect("/?shared=" + files.length, 303);
}
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method === "POST" && url.pathname === "/share-target") { e.respondWith(receiveShare(e.request)); return; }
  if (e.request.method !== "GET" || /^\/(api|p|sale|_capacitor_[a-z]+_)\//.test(url.pathname)) return; // never cache API, photos or live sale pages
  e.respondWith(
    fetch(e.request).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); return r; })
      .catch(() => caches.match(e.request).then(m => m || caches.match("/")))
  );
});
