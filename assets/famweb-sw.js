// Zenith family web apps: the service worker. Served at /family/web/sw.js (scope /family/web/).
//
// A family web app's files are never on the public site. Its gate page (/family/web/<id>/, assets/famweb.js) signs
// the person in, fetches the app from the Family server (only for people on that app's list), and puts its files in
// this browser's Cache Storage ("zgfw-<id>-<version>"). This worker then serves /family/web/<id>/app/... from there.
//
// Opening the app goes through the gate at least every 12 hours ("zgfw-pass" holds when the gate last let this
// browser in), so someone taken off the list loses the app within a day, and everyone picks up new versions.
const PASS_CACHE = 'zgfw-pass', PASS_HOURS = 12;
const APP = /^\/family\/web\/([a-z0-9-]+)\/app\/(.*)$/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

async function appCache(id) {
  const name = (await caches.keys()).find(k => k.startsWith(`zgfw-${id}-`));
  return name ? caches.open(name) : null;
}
async function passed(id) {
  const r = await (await caches.open(PASS_CACHE)).match(`/__pass/${id}`);
  return !!r && Date.now() - Number(await r.text()) < PASS_HOURS * 3600e3;
}
const gate = id => Response.redirect(`/family/web/${id}/`, 302);

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  const m = APP.exec(url.pathname);
  if (!m) return;                                                    // the gate page itself, sw.js: normal network
  const [, id, rel] = m;
  e.respondWith((async () => {
    const cache = await appCache(id);
    if (!cache) return gate(id);
    if (e.request.mode === 'navigate' && !(await passed(id))) return gate(id);
    const path = rel === '' || rel.endsWith('/') ? rel + 'index.html' : rel;
    const hit = await cache.match(`/family/web/${id}/app/${path}`);
    if (hit) return hit;
    if (e.request.mode === 'navigate') {                             // single-page apps: unknown paths open the app
      const index = await cache.match(`/family/web/${id}/app/index.html`);
      if (index) return index;
    }
    return new Response('Not found in this app.', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  })());
});
