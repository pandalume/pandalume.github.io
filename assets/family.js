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
  const PLAT = { android: 'Android', windows: 'Windows' };
  const HINT = { apk: 'Android app', setup: 'Installs with a Start menu shortcut', portable: 'Runs without installing' };
  const chips = app => Object.keys(app.platforms || {}).sort((x, y) => (x === 'android' ? 0 : 1) - (y === 'android' ? 0 : 1)).map(p => `<span class="chip">${PLAT[p]}</span>`).join('');
  let apps = [], me = null;

  // The list, laid out like the main site's home page: apps and games apart, by genre when there are many.
  // Public and link-only apps (from the page itself): family sees these too, without switching sites.
  const PUBLIC = (() => { try { return JSON.parse(document.getElementById('family-public')?.textContent || '[]'); } catch { return []; } })();
  function card(a) {
    if (a.group === 'public' || a.group === 'unlisted') return `<a class="card app-card" href="/apps/${esc(a.id)}/">
  <img class="icon" alt="" width="64" height="64" src="${esc(a.icon)}">
  <div><h3>${esc(a.name)}</h3><p class="muted small">${esc(a.category || '')}</p></div>
  <p class="tag">${esc(a.tagline)}</p>
  <div class="chips">${(a.platforms || []).map(p => `<span class="chip">${PLAT[p]}</span>`).join('')}${a.version ? `<span class="chip ghost">v${esc(a.version)}</span>` : '<span class="chip soon-chip">Coming soon</span>'}</div>
</a>`;
    const latest = (a.releases || []).find(r => r.status === 'live');
    return `<a class="card app-card" href="#${esc(a.id)}">
  <img class="icon" alt="" width="64" height="64" data-img="${esc(a.id)}|icon">
  <div><h3>${esc(a.name)}</h3><p class="muted small">${esc(a.category || 'Family & friends')}</p></div>
  <p class="tag">${esc(a.tagline)}</p>
  <div class="chips">${chips(a)}${latest ? `<span class="chip ghost">v${esc(latest.version)}</span>` : '<span class="chip soon-chip">Coming soon</span>'}</div>
</a>`;
  }
  function section(list) {
    const cats = [...new Set(list.map(a => a.category || 'Other'))].sort();
    if (list.length < 4 || cats.length < 2) return `<div class="grid">${list.map(card).join('')}</div>`;
    return cats.map(c => `<h3 class="genre">${esc(c)}</h3><div class="grid">${list.filter(a => (a.category || 'Other') === c).sort((x, y) => x.name.localeCompare(y.name)).map(card).join('')}</div>`).join('');
  }
  function kinds(list) {
    const games = list.filter(a => a.kind === 'game'), rest = list.filter(a => a.kind !== 'game');
    return games.length ? `${rest.length ? `<h3 class="genre">Apps</h3>${section(rest)}` : ''}<h3 class="genre">Games</h3>${section(games)}` : section(list);
  }
  function listView() {
    const shared = apps.filter(a => a.visibility !== 'owner'), mine = apps.filter(a => a.visibility === 'owner');
    const everyone = [...PUBLIC].sort((x, y) => x.order - y.order || x.name.localeCompare(y.name));
    return `<section id="apps"><div class="sec-row"><h2 class="sec">Family &amp; friends <span class="muted small">shared with you</span></h2></div>
${shared.length ? kinds(shared) : '<p class="muted">No apps have been shared with you yet.</p>'}</section>
${everyone.length ? `<section><div class="sec-row"><h2 class="sec">Public <span class="muted small">on Zenith for everyone</span></h2></div>${kinds(everyone)}</section>` : ''}
${mine.length ? `<section><div class="sec-row"><h2 class="sec">Just me <span class="muted small">only you can see these</span></h2></div>${kinds(mine)}</section>` : ''}`;
  }

  // One app, laid out like its page on the main site.
  function detailView(app) {
    const plats = Object.keys(app.platforms || {}).sort((x, y) => (x === 'android' ? 0 : 1) - (y === 'android' ? 0 : 1));
    const latestAny = (app.releases || []).find(r => r.status === 'live');
    const facts = [latestAny && ['Version', latestAny.version], latestAny && ['Updated', date(latestAny.date)],
      ...plats.map(p => app.platforms[p].requires && [plats.length > 1 ? PLAT[p] : 'Requires', app.platforms[p].requires.replace(' or newer', '+')])].filter(Boolean);
    const panels = plats.map(p => {
      const r = latestFor(app, p), files = r ? r.files.filter(f => KINDS[f.kind] === p) : [];
      return `<div class="card dl" data-platform="${p}"><div class="dl-head"><h3>${PLAT[p]}</h3><span class="muted small">${esc(app.platforms[p].requires || '')}</span></div>
${r ? `<p class="ver">Version ${esc(r.version)} · ${date(r.date)}</p>
<div class="btns">${files.map((f, i) => `<button type="button" class="btn ${i ? 'btn-ghost' : 'btn-iri'}" data-act="dl" data-app="${esc(app.id)}" data-name="${esc(f.name)}"><span>${LABEL[f.kind]}</span><small>${mb(f.size)} · ${HINT[f.kind]}</small></button>`).join('')}</div>
${p === 'android' ? '<p class="small dl-hint">Chrome will ask <b>"File might be harmful"</b> because the app isn\'t from the Play Store. Tap <b>Download anyway</b>, then open the file to install.</p>' : ''}
<p class="notes"><b>What's new:</b> ${esc(r.notes)}</p>
<p class="small"><a href="/install/#${p}">How to install on ${PLAT[p]}</a></p>` : '<p class="muted">No download yet. Check back soon.</p>'}</div>`;
    }).join('');
    const shots = (app.screenshots || []).map(s => typeof s === 'string' ? { file: s } : s);
    const ds = app.dataSafety;
    const rel = app.releases || [];
    const ver = r => `<li class="${esc(r.status)}"><div class="vrow"><b>${esc(r.version)}</b><span class="muted small">${date(r.date)}</span></div><p>${esc(r.notes)}</p>${(r.changes || []).length ? `<ul>${r.changes.map(c => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}</li>`;
    return `<p class="small"><a href="#">← All shared apps</a></p>
<section class="app-head"><img class="icon big" alt="" width="96" height="96" data-img="${esc(app.id)}|icon">
<div class="app-title"><h1>${esc(app.name)}</h1><p class="by"><img src="/assets/pandalume-mark.webp" alt="" width="18" height="18">by <b>Pandalume Studio</b> <span class="muted">· ${app.visibility === 'owner' ? 'Just me (only you can see this)' : 'Family &amp; friends'}</span></p><p class="tag">${esc(app.tagline)}</p>
<div class="chips">${chips(app)}${app.category ? `<span class="chip ghost">${esc(app.category)}</span>` : ''}</div></div></section>
${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
<section class="dls">${panels}</section>
${shots.length ? `<section><h2 class="sec">Screenshots</h2><div class="shots style-${esc(app.shotStyle || 'clean')}">${shots.map(s => `<span class="shot${s.wide ? ' wide' : ''}"><img alt="" data-img="${esc(app.id)}|shots/${esc(s.file)}"></span>`).join('')}</div></section>` : ''}
<section><h2 class="sec">About</h2>${(app.description || []).map(p => `<p>${esc(p)}</p>`).join('')}
${(app.features || []).length ? `<ul class="feat">${app.features.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
${(app.tags || []).length ? `<div class="chips tags">${app.tags.map(t => `<span class="chip ghost">${esc(t)}</span>`).join('')}</div>` : ''}</section>
${(() => { const today = new Date().toISOString().slice(0, 10); const evs = (app.events || []).filter(e => (!e.starts || e.starts <= today) && (!e.ends || e.ends >= today));
  return evs.length ? `<section><h2 class="sec">Events &amp; offers</h2><div class="events">${evs.map(e => `<div class="card event">${e.ends ? `<span class="chip warn-chip">Ends ${date(e.ends)}</span>` : '<span class="chip">Now on</span>'}<h3>${esc(e.title)}</h3>${e.text ? `<p class="small">${esc(e.text)}</p>` : ''}${e.url ? `<a class="small" href="${esc(e.url)}">${esc(e.link || 'Find out more')} →</a>` : ''}</div>`).join('')}</div></section>` : ''; })()}
${ds ? `<section><h2 class="sec">Data safety</h2><div class="card ds">
${(ds.collected || []).length ? `<div class="ds-row"><span aria-hidden="true">•</span><div><b>Collects, only if you sign in</b><span>${esc(ds.collected.map(c => c.data).join(' · '))}</span></div></div>` : '<div class="ds-row"><span aria-hidden="true">•</span><div><b>Collects no data</b></div></div>'}
${(ds.sent || []).map(x => `<div class="ds-row"><span aria-hidden="true">•</span><div><b>Sends ${esc(x.data)}</b><span>to ${esc(x.to)}: ${esc(x.why)}</span></div></div>`).join('')}
${ds.encryptedInTransit ? '<div class="ds-row"><span aria-hidden="true">•</span><div><b>Data is encrypted in transit</b></div></div>' : ''}
${ds.deletion ? `<div class="ds-row"><span aria-hidden="true">•</span><div><b>You can delete your data</b><span>${esc(ds.deletion)}</span></div></div>` : ''}
${(ds.extras || []).map(x => `<div class="ds-row"><span aria-hidden="true">•</span><div><span>${esc(x)}</span></div></div>`).join('')}</div></section>` : ''}
${rel.length ? `<section><h2 class="sec">Version history</h2><ol class="versions">${rel.slice(0, 3).map(ver).join('')}</ol>
${rel.length > 3 ? `<details class="older"><summary>Show ${rel.length - 3} older version${rel.length - 3 > 1 ? 's' : ''}</summary><ol class="versions">${rel.slice(3).map(ver).join('')}</ol></details>` : ''}</section>` : ''}
<p class="small"><a href="/apps/${esc(app.id)}/privacy/">${esc(app.name)} privacy policy</a> · <a href="/apps/${esc(app.id)}/terms/">Terms of use</a></p>`;
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

  function render() {
    const id = decodeURIComponent(location.hash.slice(1));
    const app = apps.find(a => a.id === id);
    set(`<p class="small muted fam-who">Signed in as <b>${esc(me.email)}</b> · <button type="button" class="linkish" data-act="out">Sign out</button></p>
${app ? detailView(app) : listView()}`);
    window.scrollTo(0, 0);
    fillImages();
    if (me.owner && !app) ownerPanel();
  }
  window.addEventListener('hashchange', () => { if (me) render(); });

  async function start() {
    me = null;
    if (!session) return signedOut();
    set('<p class="muted">Loading your apps…</p>');
    try {
      const j = await getJson({ action: 'catalog' });
      if (!j.member) return notInvited(j.email);
      apps = j.apps; me = j;
      if (jump && location.hash.slice(1) !== jump) location.hash = jump; else render();
    } catch (err) {
      if (err.signedOut) return signedOut();
      set(`<p class="family-notice">The Family page couldn't load (${esc(err.message)}). Try again in a minute.</p>`);
    }
  }
  start();
})();
