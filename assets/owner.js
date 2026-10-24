// Zenith Owner (/owner/): the owner's own home-screen app. Opens public Zenith or the Family page,
// shares any app by QR code or the phone's share sheet, and shows download counts. Uses the same
// Google sign-in as the Family page (kept in this browser), and only works for an owner account.
(() => {
  const root = document.getElementById('owner');
  if (!root) return;
  const SB = root.dataset.supabase, KEY = root.dataset.key, REPO = root.dataset.repo;
  const FN = SB + '/functions/v1/family', HOME = location.origin + '/owner/', STORE = 'zg-family-session';
  const data = JSON.parse(document.getElementById('owner-data').textContent);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const load = () => { try { return JSON.parse(localStorage.getItem(STORE)); } catch { return null; } };
  const save = s => { try { s ? localStorage.setItem(STORE, JSON.stringify(s)) : localStorage.removeItem(STORE); } catch { /* ignore */ } };
  let session = load();

  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('access_token')) {
    session = { access_token: h.get('access_token'), refresh_token: h.get('refresh_token'), expires_at: Date.now() / 1000 + Number(h.get('expires_in') || 3600) };
    save(session);
    history.replaceState(null, '', location.pathname);
  }
  async function token() {
    if (!session) return null;
    if (session.expires_at - 60 > Date.now() / 1000) return session.access_token;
    const res = await fetch(`${SB}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: session.refresh_token }) }).catch(() => null);
    if (!res || !res.ok) { session = null; save(null); return null; }
    const t = await res.json();
    session = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() / 1000 + (t.expires_in || 3600) };
    save(session);
    return session.access_token;
  }
  const signIn = () => { location.href = `${SB}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(HOME)}`; };

  async function share(name, url) {
    const text = `${name}: ${url}`;
    try {
      if (navigator.share) await navigator.share({ title: name, url });
      else { await navigator.clipboard.writeText(url); toast('Link copied'); }
    } catch { /* share sheet closed */ }
    return text;
  }
  function toast(t) { const p = document.createElement('p'); p.className = 'owner-toast'; p.textContent = t; document.body.append(p); setTimeout(() => p.remove(), 1800); }
  function showQr(item) {
    const box = document.createElement('div');
    box.className = 'lightbox owner-qr';
    box.setAttribute('role', 'dialog');
    box.innerHTML = `<div class="owner-qr-card">${item.qr}<b>${esc(item.name)}</b><span class="small">${esc(item.url.replace('https://', ''))}</span><span class="small muted">Tap anywhere to close</span></div>`;
    box.addEventListener('click', () => box.remove());
    document.body.append(box);
  }
  const find = id => data.tiles.find(t => t.id === id) || data.rows.find(r => r.id === id);

  async function counts() {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) return;
      const n = {};
      for (const r of await res.json()) for (const a of r.assets) n[a.browser_download_url] = a.download_count;
      for (const row of data.rows) {
        const el = root.querySelector(`[data-count="${row.id}"]`);
        if (!el || !row.files.length) continue;
        const total = row.files.reduce((t, u) => t + Math.max(0, (n[u] || 0) - (row.self[u] || 0)), 0);
        el.textContent = `${total} download${total === 1 ? '' : 's'} by others`;
      }
    } catch { /* offline */ }
  }

  function view(email) {
    root.innerHTML = `<section class="owner-head"><h1>Zenith Owner</h1><p class="small muted">${esc(email)} · <button type="button" class="linkish" data-act="out">Sign out</button></p></section>
<div class="owner-tiles">${data.tiles.map(t => `<div class="card owner-tile">
<a class="owner-open" href="${esc(t.url)}"><b>${esc(t.name)}</b><span class="small muted">${esc(t.url.replace('https://', ''))}</span></a>
<div class="btns"><button type="button" class="btn btn-iri" data-act="qr" data-id="${t.id}">Show QR</button><button type="button" class="btn btn-ghost" data-act="share" data-id="${t.id}">Share</button></div>
${t.id === 'family' ? '<p class="small"><a href="/family/">Invite or remove people →</a></p>' : ''}</div>`).join('')}</div>
<h2 class="sec">Apps</h2>
<ul class="owner-apps">${data.rows.map(r => `<li class="card">
${r.icon ? `<img class="icon" src="${esc(r.icon)}" alt="" width="48" height="48">` : '<span class="icon owner-noicon" aria-hidden="true">🔒</span>'}
<div class="owner-app"><a href="${esc(r.url)}"><b>${esc(r.name)}</b></a><span class="small muted">${esc(r.group)}${r.version ? ' · v' + esc(r.version) : ''}</span><span class="small muted" data-count="${r.id}"></span></div>
<div class="owner-acts"><button type="button" class="linkish" data-act="qr" data-id="${r.id}">QR</button><button type="button" class="linkish" data-act="share" data-id="${r.id}">Share</button></div></li>`).join('')}</ul>
<p class="small muted">Install this page on your phone: Chrome menu ⋮ › <b>Add to Home screen</b> (or <b>Install app</b>). It's only useful to you: other people can't sign in to it.</p>`;
    counts();
    familyIcons();
  }
  // Family apps' icons live in the private repository; the Family server gives them to owners.
  async function familyIcons() {
    const t = await token();
    for (const el of root.querySelectorAll('.owner-noicon')) {
      const id = el.closest('li').querySelector('[data-count]')?.dataset.count;
      try {
        const r = await fetch(`${FN}?action=file&app=${encodeURIComponent(id)}&path=icon`, { headers: { Authorization: `Bearer ${t}`, apikey: KEY } });
        if (!r.ok) continue;
        const img = document.createElement('img'); img.className = 'icon'; img.width = img.height = 48; img.alt = '';
        img.src = URL.createObjectURL(await r.blob()); el.replaceWith(img);
      } catch { /* keep the lock */ }
    }
  }

  root.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'in') signIn();
    if (b.dataset.act === 'out') { session = null; save(null); start(); }
    if (b.dataset.act === 'qr') showQr(find(b.dataset.id));
    if (b.dataset.act === 'share') { const it = find(b.dataset.id); share(it.name, it.url); }
  });

  async function start() {
    const t = await token();
    if (!t) {
      root.innerHTML = `<div class="card family-signin"><h1>Zenith Owner</h1><p>For the owner of Zenith Gen Orbit. Sign in with your owner Google account.</p>
<button type="button" class="btn btn-iri" data-act="in">Sign in with Google</button></div>`;
      return;
    }
    try {
      const res = await fetch(`${FN}?action=catalog`, { headers: { Authorization: `Bearer ${t}`, apikey: KEY } });
      const j = await res.json();
      if (!j.owner) { root.innerHTML = `<div class="card family-signin"><p>This page is only for the owner. You're signed in as <b>${esc(j.email || '')}</b>.</p><p><a href="/">Go to Zenith Gen Orbit</a></p><button type="button" class="btn btn-ghost" data-act="out">Sign out</button></div>`; return; }
      view(j.email);
    } catch {
      root.innerHTML = '<p class="family-notice">Couldn\'t reach the server. Check your connection and try again.</p>';
    }
  }
  start();
})();
