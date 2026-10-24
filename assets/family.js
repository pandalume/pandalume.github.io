// Family page: sign in with Google (Supabase Auth, no library), then show the apps this person is
// invited to, from the "family" edge function. The sign-in is kept in this browser until Sign out.
(() => {
  const root = document.getElementById('family');
  if (!root) return;
  const SB = root.dataset.supabase, KEY = root.dataset.key, CONTACT = root.dataset.contact;
  const FN = SB + '/functions/v1/family', HOME = location.origin + '/family/', STORE = 'zg-family-session';
  const KINDS = { apk: 'android', setup: 'windows', portable: 'windows' };
  const LABEL = { apk: 'Download for Android', setup: 'Windows installer', portable: 'Windows portable' };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mb = n => (n / 1e6).toFixed(1) + ' MB';
  const date = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const load = () => { try { return JSON.parse(localStorage.getItem(STORE)); } catch { return null; } };
  const save = s => { try { s ? localStorage.setItem(STORE, JSON.stringify(s)) : localStorage.removeItem(STORE); } catch { /* private window: sign-in lasts this visit only */ } };
  let session = load();
  const set = html => { root.innerHTML = html; };

  // Back from Google: the tokens arrive after "#". Anything else after "#" is an app id to jump to.
  const h = new URLSearchParams(location.hash.slice(1));
  let jump = '';
  if (h.get('access_token')) {
    session = { access_token: h.get('access_token'), refresh_token: h.get('refresh_token'), expires_at: Date.now() / 1000 + Number(h.get('expires_in') || 3600) };
    save(session);
    jump = sessionStorage.getItem('zg-family-jump') || '';
    history.replaceState(null, '', location.pathname);
  } else if (h.get('error_description')) {
    history.replaceState(null, '', location.pathname);
    setTimeout(() => notice(`Sign-in didn't finish: ${h.get('error_description')}`), 0);
  } else jump = location.hash.slice(1);

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
  async function api(params, init = {}) {
    const t = await token();
    if (!t) throw Object.assign(new Error('signed out'), { signedOut: true });
    const res = await fetch(`${FN}?${new URLSearchParams(params)}`, { ...init, headers: { Authorization: `Bearer ${t}`, apikey: KEY, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
    if (res.status === 401) { session = null; save(null); throw Object.assign(new Error('signed out'), { signedOut: true }); }
    return res;
  }
  const getJson = async (params, init) => { const r = await api(params, init); const j = await r.json(); if (!r.ok && j.member !== false) throw new Error(j.error || `Error ${r.status}`); return j; };

  function signIn() {
    if (jump) sessionStorage.setItem('zg-family-jump', jump);
    location.href = `${SB}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(HOME)}`;
  }
  async function signOut() {
    const t = session?.access_token;
    session = null; save(null);
    if (t) fetch(`${SB}/auth/v1/logout`, { method: 'POST', headers: { Authorization: `Bearer ${t}`, apikey: KEY } }).catch(() => {});
    start();
  }
  function notice(text) {
    const p = document.createElement('p'); p.className = 'family-notice'; p.textContent = text;
    root.prepend(p);
  }

  function signedOut() {
    set(`<div class="card family-signin"><p>This page is invite-only. Sign in to see the apps you've been invited to.</p>
<button type="button" class="btn btn-iri" data-act="in">Sign in with Google</button></div>`);
  }
  function notInvited(email) {
    set(`<div class="card family-signin"><p>You're signed in as <b>${esc(email)}</b>, which isn't on the invite list.</p>
<p class="muted small">If you were expecting an invite, ask ${esc(CONTACT)} to add this email address, or sign in with a different Google account.</p>
<button type="button" class="btn btn-ghost" data-act="out">Sign out</button></div>`);
  }

  const latestFor = (app, p) => (app.releases || []).find(r => r.status === 'live' && r.files.length && r.files.some(f => KINDS[f.kind] === p));
  function appCard(app) {
    const plats = Object.keys(app.platforms || {});
    const dl = plats.map(p => {
      const r = latestFor(app, p);
      if (!r) return `<p class="muted small">${p === 'android' ? 'Android' : 'Windows'}: no version yet.</p>`;
      return `<div class="fam-dl"><p class="small muted">${p === 'android' ? 'Android' : 'Windows'} · version ${esc(r.version)} · ${date(r.date)}${app.platforms[p].requires ? ' · ' + esc(app.platforms[p].requires) : ''}</p>
<div class="btns">${r.files.filter(f => KINDS[f.kind] === p).map((f, i) => `<button type="button" class="btn ${i ? 'btn-ghost' : 'btn-iri'}" data-act="dl" data-app="${esc(app.id)}" data-name="${esc(f.name)}">${LABEL[f.kind]} <span class="small">${mb(f.size)}</span></button>`).join('')}</div></div>`;
    }).join('');
    const now = (app.releases || []).find(r => r.status === 'live');
    const shots = (app.screenshots || []).map(s => typeof s === 'string' ? { file: s } : s);
    const ds = app.dataSafety;
    return `<article class="card fam-app" id="${esc(app.id)}">
<div class="fam-head"><img class="icon" alt="" width="64" height="64" data-img="${esc(app.id)}|icon">
<div><h2>${esc(app.name)}</h2><p class="tag">${esc(app.tagline)}</p></div></div>
${dl}
${now ? `<p class="notes"><b>What's new:</b> ${esc(now.notes)}</p>` : ''}
<details class="fam-more"><summary>More about ${esc(app.name)}</summary>
${shots.length ? `<div class="shots style-${esc(app.shotStyle || 'clean')}">${shots.map(s => `<span class="shot${s.wide ? ' wide' : ''}"><img alt="" data-img="${esc(app.id)}|shots/${esc(s.file)}"></span>`).join('')}</div>` : ''}
${(app.description || []).map(p => `<p>${esc(p)}</p>`).join('')}
${(app.features || []).length ? `<ul class="feat">${app.features.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
${ds ? `<h3>Data safety</h3><ul class="feat">${(ds.collected || []).map(c => `<li><b>${esc(c.data)}</b>: ${esc(c.why)}${c.optional ? ' (optional)' : ''}</li>`).join('')}${(ds.sent || []).map(x => `<li>Sends <b>${esc(x.data)}</b> to ${esc(x.to)}: ${esc(x.why)}</li>`).join('')}${ds.encryptedInTransit ? '<li>Data is encrypted in transit</li>' : ''}${ds.deletion ? `<li>Deleting your data: ${esc(ds.deletion)}</li>` : ''}${(ds.extras || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
<h3>Version history</h3><ol class="versions">${(app.releases || []).slice(0, 10).map(r => `<li class="${esc(r.status)}"><div class="vrow"><b>${esc(r.version)}</b><span class="muted small">${date(r.date)}</span></div><p>${esc(r.notes)}</p>${(r.changes || []).length ? `<ul>${r.changes.map(c => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</ol>
<p class="small"><a href="/apps/${esc(app.id)}/privacy/">Privacy policy</a> · <a href="/apps/${esc(app.id)}/terms/">Terms of use</a> · <a href="/install/">Install help</a></p>
</details></article>`;
  }

  async function fillImages() {
    for (const img of root.querySelectorAll('img[data-img]')) {
      const [app, p] = img.dataset.img.split('|');
      img.removeAttribute('data-img');
      try { const r = await api({ action: 'file', app, path: p }); if (r.ok) img.src = URL.createObjectURL(await r.blob()); } catch { /* leave blank */ }
    }
  }

  async function ownerPanel() {
    const box = document.createElement('section');
    box.className = 'card fam-owner';
    root.append(box);
    const draw = async () => {
      const { members, apps } = await getJson({ action: 'members' });
      const appName = id => id === '*' ? 'all family apps' : (apps.find(a => a.id === id)?.name || id);
      const qr = document.getElementById('fam-share-qr')?.innerHTML || '';
      box.innerHTML = `<h2>Invites <span class="muted small">(only you see this)</span></h2>
<div class="fam-share"><div class="fam-qr">${qr}</div><div>
<h3>Share the Family page</h3>
<p class="small muted">Face to face: let them scan this with their phone camera. Otherwise send them the link. They sign in with the Google email you invited.</p>
<p><code>${esc(HOME)}</code></p>
<div class="btns"><button type="button" class="btn btn-ghost" data-act="send">Share link…</button><button type="button" class="btn btn-ghost" data-act="copy">Copy link</button></div></div></div>
${members.length ? `<ul class="fam-members">${members.map(m => `<li><span><b>${esc(m.name || m.email)}</b>${m.name ? ` <span class="muted small">${esc(m.email)}</span>` : ''}<br><span class="small muted">${esc(m.apps.map(appName).join(', '))}</span></span><span class="fam-acts"><button type="button" class="linkish" data-act="send" data-name="${esc(m.name || '')}" data-email="${esc(m.email)}">Send invite</button><button type="button" class="linkish" data-act="rm" data-email="${esc(m.email)}">Remove</button></span></li>`).join('')}</ul>` : '<p class="muted small">Nobody invited yet.</p>'}
<form class="fam-form" data-act="add"><h3>Invite someone</h3>
<label>Their Google email <input type="email" name="email" required autocomplete="off"></label>
<label>Name (for you) <input type="text" name="name" maxlength="80" autocomplete="off"></label>
<fieldset><legend class="small">Apps they can see</legend>
<label class="chk"><input type="checkbox" name="apps" value="*" checked> All family apps, including future ones</label>
${apps.map(a => `<label class="chk"><input type="checkbox" name="apps" value="${esc(a.id)}"> ${esc(a.name)}</label>`).join('')}</fieldset>
<button class="btn btn-iri" type="submit">Save invite</button>
<p class="small muted">Inviting someone again with the same email changes their apps.</p></form>`;
    };
    box.addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target), picked = fd.getAll('apps');
      try {
        await getJson({ action: 'members' }, { method: 'POST', body: JSON.stringify({ email: fd.get('email'), name: fd.get('name'), apps: picked.includes('*') ? ['*'] : picked }) });
        await draw();
      } catch (err) { alertIn(box, err.message); }
    });
    box.addEventListener('click', async e => {
      const s = e.target.closest('[data-act="send"], [data-act="copy"]');
      if (s) {
        const who = s.dataset.email ? `Hi${s.dataset.name ? ' ' + s.dataset.name : ''}! ` : '';
        const text = `${who}I've shared my apps with you. Open ${HOME} and sign in with Google${s.dataset.email ? ` (${s.dataset.email})` : ''} to download them.`;
        try {
          if (s.dataset.act === 'send' && navigator.share) await navigator.share({ title: 'Family & friends apps', text });
          else { await navigator.clipboard.writeText(s.dataset.act === 'copy' ? HOME : text); s.textContent = 'Copied'; }
        } catch { /* share sheet closed */ }
        return;
      }
      const b = e.target.closest('[data-act="rm"]');
      if (!b) return;
      if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Tap again to remove'; return; }
      try { await getJson({ action: 'members', email: b.dataset.email }, { method: 'DELETE' }); await draw(); } catch (err) { alertIn(box, err.message); }
    });
    try { await draw(); } catch (err) { box.textContent = 'Invites could not load: ' + err.message; }
  }
  const alertIn = (box, text) => { const p = document.createElement('p'); p.className = 'family-notice'; p.textContent = text; box.prepend(p); };

  root.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]');
    if (!b || b.tagName === 'FORM') return;
    if (b.dataset.act === 'in') signIn();
    if (b.dataset.act === 'out') signOut();
    if (b.dataset.act === 'dl') {
      const was = b.innerHTML; b.disabled = true; b.textContent = 'Starting download…';
      try { const j = await getJson({ action: 'download', app: b.dataset.app, name: b.dataset.name }); location.href = j.url; }
      catch (err) { if (err.signedOut) return start(); alert(err.message); }
      finally { setTimeout(() => { b.disabled = false; b.innerHTML = was; }, 3000); }
    }
  });

  async function start() {
    if (!session) return signedOut();
    set('<p class="muted">Loading your apps…</p>');
    try {
      const j = await getJson({ action: 'catalog' });
      if (!j.member) return notInvited(j.email);
      set(`<p class="small muted fam-who">Signed in as <b>${esc(j.email)}</b> · <button type="button" class="linkish" data-act="out">Sign out</button></p>
${j.apps.length ? j.apps.map(appCard).join('') : '<p class="muted">No apps have been shared with you yet.</p>'}`);
      if (jump) document.getElementById(jump)?.scrollIntoView();
      fillImages();
      if (j.owner) ownerPanel();
    } catch (err) {
      if (err.signedOut) return signedOut();
      set(`<p class="family-notice">The Family page couldn't load (${esc(err.message)}). Try again in a minute.</p>`);
    }
  }
  start();
})();
