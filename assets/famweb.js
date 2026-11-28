// Zenith family web apps: the gate page at /family/web/<id>/ (built for every family app that has a web version).
//
// The app's files are not on the public site. Here the person signs in with Google (the same Zenith sign-in as the
// Family page, and the same saved session), the Family server checks they're on that app's list and hands over the
// app as one bundle, and the bundle's files go into this browser's Cache Storage, where the service worker
// (/family/web/sw.js, assets/famweb-sw.js) serves them at /family/web/<id>/app/.
//
// Every open (and at least every 12 hours of use) comes through here: online, the server re-checks the list and
// says whether there's a newer version (only then is anything downloaded); offline, the copy already here opens.
// Removed from the list: this browser's copy is deleted.
(() => {
  const root = document.getElementById('famweb');
  if (!root) return;
  const ID = root.dataset.app, NAME = root.dataset.name, SB = root.dataset.supabase, KEY = root.dataset.key;
  const FN = SB + '/functions/v1/family', HERE = location.origin + `/family/web/${ID}/`, APP = `/family/web/${ID}/app/`;
  const STORE = 'zg-family-session', INSTALLED = `zgfw:${ID}`;   // the session is shared with the Family page
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const set = html => { root.innerHTML = html; };
  const get = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  const put = (k, v) => { try { v ? localStorage.setItem(k, JSON.stringify(v)) : localStorage.removeItem(k); } catch { /* private window */ } };
  let session = get(STORE);

  async function token() {
    if (!session) return null;
    if (session.expires_at - 60 > Date.now() / 1000) return session.access_token;
    const res = await fetch(`${SB}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: session.refresh_token }) });
    if (res.status >= 400 && res.status < 500) { session = null; put(STORE, null); return null; }
    if (!res.ok) throw new Error(`sign-in server ${res.status}`);
    const t = await res.json();
    session = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() / 1000 + (t.expires_in || 3600) };
    put(STORE, session);
    return session.access_token;
  }

  async function forget() {                                          // no longer allowed: remove this browser's copy
    for (const k of await caches.keys()) if (k.startsWith(`zgfw-${ID}-`)) await caches.delete(k);
    await (await caches.open('zgfw-pass')).delete(`/__pass/${ID}`);
    put(INSTALLED, null);
  }
  async function open() {
    await (await caches.open('zgfw-pass')).put(`/__pass/${ID}`, new Response(String(Date.now())));
    await navigator.serviceWorker.ready;
    location.replace(APP);
  }

  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  const TYPES = { html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css',
    json: 'application/json', webmanifest: 'application/manifest+json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    webp: 'image/webp', gif: 'image/gif', ico: 'image/x-icon', avif: 'image/avif', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm', wasm: 'application/wasm', txt: 'text/plain; charset=utf-8' };
  const typeOf = p => TYPES[(p.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
  // Added to the home screen, the app must start at this gate (so the list is checked and updates arrive), not
  // straight inside app/. So its pages get a manifest made here: the app's own one (name, colours, icons), with
  // the start address and scope changed to this gate.
  const MANIFEST = APP + '__zenith.webmanifest';
  const HEADS = `<link rel="manifest" href="${MANIFEST}">`;
  function manifestFor(files) {
    const own = Object.keys(files).find(p => /(^|\/)(manifest\.webmanifest|manifest\.json|site\.webmanifest)$/i.test(p));
    let m = {};
    try { if (own) m = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(files[own]), c => c.charCodeAt(0)))); } catch { m = {}; }
    const base = location.origin + APP + (own && own.includes('/') ? own.slice(0, own.lastIndexOf('/') + 1) : '');
    const icons = (Array.isArray(m.icons) ? m.icons : []).map(i => ({ ...i, src: new URL(i.src, base).pathname }));
    return { ...m, name: m.name || NAME, short_name: m.short_name || NAME, id: `/family/web/${ID}/`, start_url: `/family/web/${ID}/`, scope: `/family/web/${ID}/`,
      display: m.display || 'standalone', icons: icons.length ? icons : [{ src: '/assets/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }] };
  }

  async function install(res) {
    const want = res.headers.get('X-Sha256'), version = res.headers.get('X-Version');
    const buf = await res.arrayBuffer();
    if (hex(await crypto.subtle.digest('SHA-256', buf)) !== want) throw new Error('the download was damaged; try again');
    const text = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    const bundle = JSON.parse(text);
    const name = `zgfw-${ID}-${version}`, cache = await caches.open(name);
    for (const [p, b64] of Object.entries(bundle.files)) {
      let body = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      if (/\.html?$/i.test(p)) body = new TextDecoder().decode(body).replace(/<head([^>]*)>/i, m => m + HEADS);
      await cache.put(APP + p, new Response(body, { headers: { 'Content-Type': typeOf(p), 'Cache-Control': 'no-cache' } }));
    }
    await cache.put(MANIFEST, new Response(JSON.stringify(manifestFor(bundle.files)), { headers: { 'Content-Type': 'application/manifest+json' } }));
    for (const k of await caches.keys()) if (k.startsWith(`zgfw-${ID}-`) && k !== name) await caches.delete(k);
    put(INSTALLED, { version, sha256: want });
  }

  function signedOut(note = '') {
    set(`${note ? `<p class="family-notice">${esc(note)}</p>` : ''}<p>${esc(NAME)} is shared with family and friends. Sign in with the Google account you were invited with to open it.</p>
<p><button type="button" class="btn btn-iri" data-act="in"><span>Sign in with Google</span></button></p>`);
  }
  function blocked(email) {
    set(`<p class="family-notice">You're signed in as <b>${esc(email)}</b>, which isn't on ${esc(NAME)}'s list. If you were invited with another Google account, sign out and use that one.</p>
<p><button type="button" class="btn btn-ghost" data-act="out"><span>Sign out</span></button> <a class="btn btn-ghost" href="/family/"><span>Family page</span></a></p>`);
  }
  root.addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'in') window.zgGoogle.start(HERE);
    if (act === 'out') { session = null; put(STORE, null); signedOut(); }
  });

  async function start() {
    if (!('serviceWorker' in navigator) || !('caches' in window) || !('DecompressionStream' in window))
      return set('<p class="family-notice">This browser is too old for web apps. Please update it (on iPhone: Settings › General › Software Update), or use Chrome, Edge or Safari.</p>');
    navigator.serviceWorker.register('/family/web/sw.js', { scope: '/family/web/' }).catch(() => {});
    const got = await window.zgGoogle.finish(SB, KEY).catch(() => null);
    if (got?.session) { session = got.session; put(STORE, session); }
    if (got?.error && !session) return signedOut(got.error);
    const have = get(INSTALLED);
    set(`<p class="muted">Opening ${esc(NAME)}…</p>`);
    let t;
    try { t = await token(); } catch { return have ? open() : set('<p class="family-notice">Can\'t reach Zenith right now. Check your connection and try again.</p>'); }
    if (!t) return signedOut();
    let res;
    try {
      res = await fetch(`${FN}?${new URLSearchParams({ action: 'webapp', app: ID, have: have?.sha256 || '' })}`, { headers: { Authorization: `Bearer ${t}`, apikey: KEY } });
    } catch { return have ? open() : set('<p class="family-notice">Can\'t reach Zenith right now. Check your connection and try again.</p>'); }
    if (res.status === 401) { session = null; put(STORE, null); return signedOut(); }
    if (res.status === 403 || res.status === 404) {
      await forget();
      const j = await res.json().catch(() => ({}));
      return res.status === 403 ? blocked(j.email || '') : set(`<p class="family-notice">${esc(NAME)} isn't shared with you, or has no web version right now.</p><p><a href="/family/">Family page</a></p>`);
    }
    if (res.status === 204) return open();                         // allowed, and this browser has the newest version
    if (!res.ok) return have ? open() : set(`<p class="family-notice">Zenith couldn't open ${esc(NAME)} (${res.status}). Try again in a minute.</p>`);
    set(`<p class="muted">${have ? 'Updating' : 'Getting'} ${esc(NAME)}…</p>`);
    try { await install(res); } catch (err) { return have ? open() : set(`<p class="family-notice">Couldn't set up ${esc(NAME)}: ${esc(err.message)}.</p>`); }
    open();
  }
  window.zgAfterPaint ? window.zgAfterPaint(start) : start();
})();
