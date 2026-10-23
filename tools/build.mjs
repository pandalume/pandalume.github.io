// Builds the whole public site into dist/ from data/ and content/.
//   node tools/build.mjs                  build with download counts (needs network; skips them if offline)
//   node tools/build.mjs --no-counts      build without asking GitHub for counts
//   node tools/build.mjs --data <dir>     use another data folder (tests)
// Plain Node 20+, no packages. If data/ is invalid it stops before writing anything, so a
// broken edit can never reach the live site.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, PLATFORMS, KINDS, loadData, latestFor, androidFeed, windowsFeed, appUrl, timeline } from './lib.mjs';
const qrcode = createRequire(import.meta.url)('./vendor/qrcode.cjs');   // MIT, Kazuhiko Arase

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i < 0 ? null : args[i + 1]; };
const DATA = path.resolve(opt('--data') || path.join(ROOT, 'data'));
const OUT = path.resolve(opt('--out') || path.join(ROOT, 'dist'));
const CONTENT = path.join(ROOT, 'content');

const { site, apps: allApps } = loadData(DATA);
const apps = allApps.filter(a => a.visibility !== 'private');          // private apps get nothing at all
const listed = apps.filter(a => a.visibility === 'public');
const counts = args.includes('--no-counts') ? {} : await downloadCounts();

// ---------- helpers ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mb = n => n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB';
const date = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const num = n => n.toLocaleString('en-US');
const KIND_LABEL = { apk: 'Download APK', setup: 'Installer', portable: 'Portable' };
const KIND_HINT = { apk: 'Android app', setup: 'Installs with a Start menu shortcut', portable: 'Runs without installing' };
const fill = html => html.replaceAll('{{contact}}', esc(site.contact));
const read = p => fs.readFileSync(p, 'utf8');
const exists = p => fs.existsSync(p);

function write(rel, text) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const json = (rel, obj) => write(rel, JSON.stringify(obj, null, 2) + '\n');

function copyDir(src, dst) {
  if (!exists(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name.endsWith('.html')) continue;                            // fragments are inlined, not served
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    e.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
  }
}

// GitHub counts every download, including the check download zgs makes after each upload and any
// you mark as your own (zgs mine). Those are subtracted ("selfDownloads" on each file).
const fileCount = f => Math.max(0, (counts[f.url] || 0) - (f.selfDownloads || 0));
const appCount = app => (app.releases || []).reduce((t, r) => t + r.files.reduce((u, f) => u + fileCount(f), 0), 0);
// Shown like Google Play: "5+", "100+", "1K+". Exact numbers are only in zgs status.
const STEPS = [1, 5, 10, 50, 100, 500, 1e3, 5e3, 1e4, 5e4, 1e5, 5e5, 1e6];
const bucket = n => { const s = STEPS.filter(x => x <= n).at(-1); return s >= 1e6 ? s / 1e6 + 'M+' : s >= 1e3 ? s / 1e3 + 'K+' : s + '+'; };
// The icon may be icon.webp, icon.png or icon.jpg (a new app's listing folder can use any of them).
const iconOf = id => '/apps/' + id + '/' + (['icon.webp', 'icon.png', 'icon.jpg'].find(f => exists(path.join(CONTENT, 'apps', id, f))) || 'icon.webp');

const LOGO = `<img class="zg-logo" src="/assets/zg-logo.webp" alt="" width="38" height="38">`;

function page({ title, description, body, noindex = false, canonical = '', image = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${noindex ? '<meta name="robots" content="noindex">\n' : ''}${canonical ? `<link rel="canonical" href="${esc(canonical)}">\n` : ''}<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(site.name)}">
${canonical ? `<meta property="og:url" content="${esc(canonical)}">\n` : ''}<meta property="og:image" content="${esc(image || site.baseUrl + '/assets/og.png')}">
<meta name="twitter:card" content="summary">
<link rel="alternate" type="application/atom+xml" title="${esc(site.name)}: what's new" href="/feed.xml">
<meta name="theme-color" content="#070a0f">${site.googleSiteVerification ? `\n<meta name="google-site-verification" content="${esc(site.googleSiteVerification)}">` : ''}
<link rel="icon" href="/assets/favicon-32.png" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<link rel="stylesheet" href="/assets/site.css">
<script src="/assets/site.js" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="wrap top-in">
  <a class="brand" href="/">${LOGO}<span><b class="iri-text">ZENITH GEN</b><small>ORBIT</small></span></a>
  <nav><a href="/#apps">Apps</a><a href="/updates/">What's new</a><a href="/install/">Install help</a></nav>
</div></header>
<main class="wrap" id="main">
${body}
</main>
<footer class="wrap foot">
  <p>No ads. No tracking. No cookies.</p>
  <p><a href="/">Home</a><a href="/updates/">What's new</a><a href="/install/">Install help</a><a href="/privacy.html">Privacy policy</a><a href="/terms.html">Terms of use</a><a href="mailto:${esc(site.contact)}">Contact</a></p>
  <p class="muted studio-foot"><img src="/assets/pandalume-mark.webp" alt="" width="28" height="28">© ${new Date().getUTCFullYear()} ${esc(site.developer)} · ${esc(site.name)}</p>
</footer>
</body>
</html>
`;
}

/** QR code as an inline SVG (built once at build time; no script needed to show it). */
function qrSvg(text, px = 148) {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(), m = 2, size = n + m * 2;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += `M${x + m} ${y + m}h1v1h-1z`;
  return `<svg class="qr" viewBox="0 0 ${size} ${size}" width="${px}" height="${px}" role="img" aria-label="QR code"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#070a0f"/></svg>`;
}
const vid = v => 'v' + v;                                              // anchor id for a version
// Link previews (WhatsApp etc.) need PNG/JPG: content/apps/<id>/share.png (1200×630) if present, else the site card.
const shareImage = app => exists(path.join(CONTENT, 'apps', app.id, 'share.png')) ? `${site.baseUrl}/apps/${app.id}/share.png` : '';
const releaseRow = ({ app, r }) => `<li><a class="upd" href="/apps/${app.id}/#${vid(r.version)}">
  <img class="icon" src="${iconOf(app.id)}" alt="" width="44" height="44">
  <span><b>${esc(app.name)} ${esc(r.version)}</b><span class="muted small"> · ${date(r.date)}</span><br><span class="small">${esc(r.notes)}</span></span></a></li>`;

const chips = app => Object.keys(app.platforms).map(p => `<span class="chip">${PLATFORMS[p]}</span>`).join('');

// ---------- home ----------
function home() {
  const plats = [...new Set(listed.flatMap(a => Object.keys(a.platforms)))];
  const filters = listed.length >= 4 && plats.length > 1 ? `<div class="filters" role="group" aria-label="Filter by platform">
  <button type="button" class="chip-btn on" data-filter="">All</button>${plats.map(p => `<button type="button" class="chip-btn" data-filter="${p}">${PLATFORMS[p]}</button>`).join('')}</div>` : '';
  const cards = listed.map(a => {
    const latest = (a.releases || []).find(r => r.status === 'live');
    return `<a class="card app-card${latest ? '' : ' soon'}" href="/apps/${a.id}/" data-platforms="${Object.keys(a.platforms).join(' ')}">
  <img class="icon" src="${iconOf(a.id)}" alt="" width="64" height="64">
  <div><h3>${esc(a.name)}</h3><p class="muted small">${esc(a.category || '')}</p></div>
  <p class="tag">${esc(a.tagline)}</p>
  <div class="chips">${chips(a)}${latest ? `<span class="chip ghost">v${esc(latest.version)}</span>` : '<span class="chip soon-chip">Coming soon</span>'}</div>
</a>`;
  }).join('\n');
  const recent = timeline(listed).slice(0, 3);
  return page({
    title: `${site.name}: apps and games by ${site.developer}`,
    description: site.tagline,
    canonical: site.baseUrl + '/',
    body: `<section class="hero">
  <img class="studio-mark" src="/assets/pandalume-mark.webp" alt="${esc(site.developer)} logo" width="80" height="80">
  <span class="pill">✦ ${esc(site.name)}</span>
  <h1>Apps and games by <span class="iri-text">${esc(site.developer)}</span>.</h1>
  <p>Small, private apps made by one developer. No ads, no tracking. Download them here directly, always the newest version, with every older one kept.</p>
</section>
<section id="apps"><div class="sec-row"><h2 class="sec">Apps</h2>${filters}</div>
<div class="grid">${cards || '<p class="muted">Apps are on their way.</p>'}</div></section>
${recent.length ? `<section><div class="sec-row"><h2 class="sec">Latest updates</h2><a class="small" href="/updates/">All updates →</a></div><ul class="updates">${recent.map(releaseRow).join('')}</ul></section>` : ''}
<section class="principles">
  <div><b>No ads</b><span>None, in any app.</span></div>
  <div><b>No tracking</b><span>No analytics, no cookies, on this site or in the apps.</span></div>
  <div><b>Your data stays yours</b><span>Kept on your device. Synced only if you sign in.</span></div>
  <div><b>Checkable downloads</b><span>Every file lists its SHA-256 fingerprint.</span></div>
</section>`
  });
}

// ---------- what's new (all public releases) + Atom feed ----------
function updatesPage() {
  const items = timeline(listed);
  const byMonth = Map.groupBy ? Map.groupBy(items, i => i.r.date.slice(0, 7)) : items.reduce((m, i) => m.set(i.r.date.slice(0, 7), [...(m.get(i.r.date.slice(0, 7)) || []), i]), new Map());
  const month = ym => new Date(ym + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return page({
    title: `What's new · ${site.name}`,
    description: `Every new version of apps by ${site.developer}.`,
    canonical: site.baseUrl + '/updates/',
    body: `<section class="prose wide"><h1>What's new</h1>
<p class="muted">Every release, newest first. Follow along without an account: add <a href="/feed.xml">this feed</a> to any feed reader app.</p>
${items.length ? [...byMonth].map(([ym, list]) => `<h2 class="sec">${month(ym)}</h2><ul class="updates">${list.map(releaseRow).join('')}</ul>`).join('') : '<p>No releases yet.</p>'}</section>`
  });
}
function atomFeed() {
  const items = timeline(listed).slice(0, 50);
  const x = s => esc(s);
  const updated = items[0] ? items[0].r.date : site.privacyUpdated;
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${x(site.name)}: what's new</title>
  <subtitle>${x(site.tagline)}</subtitle>
  <link href="${site.baseUrl}/feed.xml" rel="self"/>
  <link href="${site.baseUrl}/updates/"/>
  <id>${site.baseUrl}/feed.xml</id>
  <updated>${updated}T00:00:00Z</updated>
  <author><name>${x(site.developer)}</name></author>
${items.map(({ app, r }) => `  <entry>
    <title>${x(app.name)} ${x(r.version)}</title>
    <link href="${appUrl(site, app)}#${vid(r.version)}"/>
    <id>${site.baseUrl}/apps/${app.id}/#${vid(r.version)}</id>
    <updated>${r.date}T00:00:00Z</updated>
    <summary>${x(r.notes)}</summary>
  </entry>`).join('\n')}
</feed>
`;
}

// ---------- app page ----------
function fileButton(f, primary) {
  return `<a class="btn ${primary ? 'btn-iri' : 'btn-ghost'}" href="${esc(f.url)}" data-kind="${f.kind}">
  <span>${KIND_LABEL[f.kind]}</span><small>${mb(f.size)} · ${KIND_HINT[f.kind]}</small></a>`;
}
function hashes(files) {
  return `<details class="hash"><summary>File fingerprints (SHA-256)</summary>${files.map(f =>
    `<div><span class="muted small">${esc(f.name)}</span><code>${f.sha256}</code><button type="button" class="copy" data-copy="${f.sha256}">Copy</button></div>`).join('')}</details>`;
}

function appPage(app) {
  const plats = Object.keys(app.platforms);
  const latestAny = (app.releases || []).find(r => r.status === 'live');
  const total = appCount(app);
  const primaryFile = p => { const r = latestFor(app, p); return r && r.files.find(f => KINDS[f.kind] === p); };

  const panels = plats.map(p => {
    const info = app.platforms[p], r = latestFor(app, p);
    const files = r ? r.files.filter(f => KINDS[f.kind] === p) : [];
    const short = `${site.baseUrl}/get/${app.id}/${p}/`;
    return `<div class="card dl" data-platform="${p}">
  <div class="dl-head"><h3>${PLATFORMS[p]}</h3><span class="muted small">${esc(info.requires || '')}</span></div>
  ${r ? `<p class="ver">Version ${esc(r.version)} · ${date(r.date)}</p>
  <div class="dl-body"><div class="dl-main"><div class="btns">${files.map((f, i) => fileButton(f, i === 0)).join('')}</div>
  <p class="notes"><b>What's new:</b> ${esc(r.notes)}</p>
  ${hashes(files)}
  <p class="small"><a href="/install/#${p}">How to install on ${PLATFORMS[p]}</a> · <button type="button" class="linkish copy" data-copy="${short}" data-done="Link copied">Copy download link</button></p></div>
  ${p === 'android' ? `<figure class="qr-box">${qrSvg(short)}<figcaption>On a computer? Scan with your phone to download.</figcaption></figure>` : ''}</div>`
    : '<p class="muted">No download yet. Check back soon.</p>'}
</div>`;
  }).join('\n');

  const facts = [
    latestAny && ['Version', latestAny.version],
    latestAny && ['Updated', date(latestAny.date)],
    ...plats.map(p => primaryFile(p) && [plats.length > 1 ? `${PLATFORMS[p]} size` : 'Size', mb(primaryFile(p).size)]),
    ...plats.map(p => app.platforms[p].requires && [plats.length > 1 ? `${PLATFORMS[p]}` : 'Requires', app.platforms[p].requires.replace(' or newer', '+')]),
    total && ['Downloads', bucket(total)]
  ].filter(Boolean);

  // Screenshots, Google Play style: a sideways strip. "shotStyle" picks the look:
  //   clean (default): the in-app image with rounded corners
  //   phone: the image inside a plain phone outline (for launchers and other full-screen apps)
  // An entry is a file name, or { "file": "...", "wide": true } for a Windows (landscape) shot.
  const shotList = (app.screenshots || []).map(s => typeof s === 'string' ? { file: s } : s);
  const style = app.shotStyle || 'clean';
  const shots = shotList.length ? `<section><h2 class="sec">Screenshots</h2><div class="shots style-${style}" data-gallery>${shotList.map((s, i) =>
    `<button type="button" class="shot${s.wide ? ' wide' : ''}" aria-label="Enlarge screenshot ${i + 1}"><img src="/apps/${app.id}/shots/${esc(s.file)}" alt="${esc(s.caption || `${app.name} screenshot ${i + 1}`)}" loading="lazy"></button>`).join('')}</div></section>` : '';

  const about = `<section><h2 class="sec">About</h2>${(app.description || []).map(p => `<p>${esc(p)}</p>`).join('')}
${(app.features || []).length ? `<ul class="feat">${app.features.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}</section>`;

  // Only the newest version per platform is downloadable; older entries show their notes only.
  const current = new Set(plats.map(p => latestFor(app, p)).filter(Boolean));
  const verItem = r => `<li class="${r.status}" id="${vid(r.version)}">
  <div class="vrow"><b>${esc(r.version)}</b><span class="muted small">${date(r.date)}</span>${r.status === 'pulled' ? '<span class="chip warn">Pulled</span>' : ''}</div>
  <p>${esc(r.notes)}</p>
  ${(r.changes || []).length ? `<ul>${r.changes.map(c => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
  ${r.status === 'pulled' ? `<p class="small warn-text">Withdrawn: ${esc(r.pulledReason)}</p>` : current.has(r) ? '<p class="small muted">Current version, download it above.</p>' : ''}
</li>`;
  const rel = app.releases || [], SHOW = 3;
  const versions = rel.length ? `<section><h2 class="sec">Version history</h2><ol class="versions">${rel.slice(0, SHOW).map(verItem).join('')}</ol>
${rel.length > SHOW ? `<details class="older"><summary>Show ${rel.length - SHOW} older version${rel.length - SHOW > 1 ? 's' : ''}</summary><ol class="versions">${rel.slice(SHOW).map(verItem).join('')}</ol></details>` : ''}</section>` : '';

  const bar = plats.map(p => { const f = primaryFile(p); return f ? `<div class="getbar" data-platform="${p}" hidden>
  <img class="icon" src="${iconOf(app.id)}" alt="" width="36" height="36"><span><b>${esc(app.name)}</b><small>${esc(latestFor(app, p).version)} · ${mb(f.size)}</small></span>
  <a class="btn btn-iri" href="${esc(f.url)}">${p === 'android' ? 'Download' : 'Get for Windows'}</a></div>` : ''; }).join('');

  return page({
    title: `${app.name} · ${site.name}`,
    description: `${app.tagline} By ${app.developer || site.developer}.`,
    noindex: app.visibility !== 'public',
    canonical: appUrl(site, app),
    image: shareImage(app),
    body: `<section class="app-head">
  <img class="icon big" src="${iconOf(app.id)}" alt="" width="96" height="96">
  <div class="app-title"><h1>${esc(app.name)}</h1><p class="by"><img src="/assets/pandalume-mark.webp" alt="" width="18" height="18">by <b>${esc(app.developer || site.developer)}</b> <span class="muted">· Published on ${esc(site.name)}</span></p><p class="tag">${esc(app.tagline)}</p>
  <div class="chips">${chips(app)}${app.category ? `<span class="chip ghost">${esc(app.category)}</span>` : ''}</div></div>
  <button type="button" class="share-btn" data-share-url="${appUrl(site, app)}" data-share-title="${esc(app.name)}" data-share-text="${esc(app.tagline)}">Share</button>
</section>
${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
<section class="dls">${panels}</section>
${shots}
${about}
${versions}
<p class="small"><a href="/apps/${app.id}/privacy/">${esc(app.name)} privacy policy</a> · <a href="/apps/${app.id}/terms/">Terms of use</a></p>
${bar}`
  });
}

// ---------- privacy policy + terms of use ----------
// Each document = shared intro + one section per app + shared closing parts. The combined page
// (/privacy.html, /terms.html) has every app's section; an app's own page has only its own.
const DOCS = {
  privacy: { title: 'Privacy policy', file: 'privacy', updated: () => site.privacyUpdated, intro: 'privacy/intro.html', outro: 'privacy/shared.html', path: '/privacy.html', sub: 'privacy',
    lead: (list, one) => one ? `This policy covers ${list}, made by ${esc(site.developer)}, ${esc(site.developerAbout)}, and published on ${esc(site.name)}. “We” and “us” mean ${esc(site.developer)}.` : `This policy covers the apps made by ${esc(site.developer)}, ${esc(site.developerAbout)}, and published on ${esc(site.name)}: ${list} (“the apps”). “We” and “us” mean ${esc(site.developer)}.` },
  terms: { title: 'Terms of use', file: 'terms', updated: () => site.termsUpdated, intro: null, outro: 'terms/shared.html', path: '/terms.html', sub: 'terms',
    lead: (list, one) => one ? `These terms apply when you use ${list}, made by ${esc(site.developer)}, ${esc(site.developerAbout)}, and published on ${esc(site.name)}. “We” and “us” mean ${esc(site.developer)}.` : `These terms apply when you use the apps made by ${esc(site.developer)}, ${esc(site.developerAbout)}, and published on ${esc(site.name)}: ${list} (“the apps”). “We” and “us” mean ${esc(site.developer)}.` }
};
// Shared policy text speaks about one app on its own page and about "the apps" on the combined page,
// so no app's page mentions another app's content.
function words(app) {
  if (!app) return { apps: 'the apps', Apps: 'The apps', poss: 'The apps\u2019', are: 'are', them: 'them', they: 'they', keep: 'keep', sync: 'sync', show: 'show', track: 'track', sell: 'sell', check: 'check', contentParen: '', whichApp: ' and say which app' };
  return { apps: app.name, Apps: app.name, poss: app.name + '\u2019s', are: 'is', them: 'it', they: 'it', keep: 'keeps', sync: 'syncs', show: 'shows', track: 'tracks', sell: 'sells', check: 'checks', contentParen: app.contentNoun ? ` (${app.contentNoun})` : '', whichApp: '' };
}
const part = (rel, app) => { const p = path.join(CONTENT, rel); if (!exists(p)) return ''; let h = fill(read(p)); for (const [k, v] of Object.entries(words(app))) h = h.replaceAll(`{{${k}}}`, esc(v)); return h; };
const nameList = list => list.length > 1 ? list.slice(0, -1).join(', ') + ' and ' + list.at(-1) : list[0];

function docPage(kind, app = null) {
  const d = DOCS[kind], subject = app ? [app] : apps;
  const title = app ? `${app.name} ${d.title.toLowerCase()}` : d.title;
  return page({
    title: `${title} · ${site.name}`,
    description: `${d.title} for ${app ? app.name : `apps by ${site.developer}`}.`,
    noindex: !!app && app.visibility !== 'public',
    canonical: app ? `${appUrl(site, app)}${d.sub}/` : site.baseUrl + d.path,
    body: `<article class="prose">${app ? `<p class="small"><a href="/apps/${app.id}/">← ${esc(app.name)}</a></p>` : ''}<h1>${esc(title)}</h1><p class="muted">Last updated: ${date(d.updated())}</p>
<p>${d.lead(esc(nameList(subject.map(a => a.name))), !!app)}</p>
${d.intro ? part(d.intro, app) : ''}${subject.map(a => part(`apps/${a.id}/${d.file}.html`, app)).join('')}${part(d.outro, app)}</article>`
  });
}

// ---------- install help ----------
function install() {
  return page({
    title: `Install help · ${site.name}`,
    description: 'How to install and update apps downloaded from this site on Android and Windows.',
    canonical: site.baseUrl + '/install/',
    body: `<article class="prose"><h1>Install help</h1>
<p>These apps come straight from the developer instead of an app store, so your phone or PC asks you to confirm the first time. That's expected.</p>
<p class="tip">Looking on a computer but want the app on your phone? Open the app's page and scan its QR code with your phone's camera.</p>
<h2 id="android">Android</h2>
<ol>
<li>Tap <b>Download APK</b> on the app's page. Your browser may warn that the file could be harmful. Tap <b>Download anyway</b>.</li>
<li>Open the downloaded file from the notification or your <b>Downloads</b> folder.</li>
<li>If you see <i>“For your security, your phone is not allowed to install unknown apps from this source”</i>, tap <b>Settings</b>, turn on <b>Allow from this source</b>, then go back.</li>
<li>Tap <b>Install</b>. If Google Play Protect asks to scan the app, let it scan, or tap <b>More details › Install anyway</b>.</li>
</ol>
<h3>Updating</h3>
<p>When a new version is out, the app shows an <b>Update</b> bar. Tap it and install the file over the current app. <b>Don't uninstall first</b>: installing over the top keeps everything stored on your phone.</p>
<h3>“App not installed”</h3>
<ul><li>Your phone already has a newer version. You can't install an older one over it.</li>
<li>Not enough free space. Free some up and try again.</li>
<li>The app came from somewhere else and was signed by someone else. Only install files from this site.</li></ul>
<h2 id="windows">Windows</h2>
<ul><li><b>Installer</b>: installs the app with a Start menu shortcut. Best for most people.</li>
<li><b>Portable</b>: a single file that runs without installing, for example from a USB stick.</li></ul>
<p>The apps aren't code-signed yet, so Windows may show <i>“Windows protected your PC”</i>. Click <b>More info</b>, check that the file name matches what you downloaded, then click <b>Run anyway</b>.</p>
<h2 id="verify">Check a download (optional)</h2>
<p>Every file's page lists its SHA-256 fingerprint. On Windows, open PowerShell in the folder with the file and run:</p>
<pre><code>Get-FileHash .\\FileName.exe -Algorithm SHA256</code></pre>
<p>The result should match the fingerprint on the site exactly. On Android you don't need to check: once an app is installed, Android only accepts updates signed with the same developer key.</p>
</article>`
  });
}

// ---------- short links /get/<id>/<platform>/ ----------
function getPage(app, url, label) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0; url=${esc(url)}"><title>Downloading ${esc(app.name)}</title>
<link rel="stylesheet" href="/assets/site.css"></head><body><main class="wrap"><p>Downloading ${esc(app.name)} ${esc(label)}… If nothing happens, <a href="${esc(url)}">tap here</a>, or go to the <a href="/apps/${app.id}/">${esc(app.name)} page</a>.</p></main></body></html>\n`;
}

// ---------- download counts (totals per file, from GitHub; nothing about people) ----------
async function downloadCounts() {
  const out = {};
  try {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'zenith-gen-build' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    for (let p = 1; p < 20; p++) {
      const res = await fetch(`https://api.github.com/repos/${site.repo}/releases?per_page=100&page=${p}`, { headers, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error('GitHub ' + res.status);
      const rel = await res.json();
      for (const r of rel) for (const a of r.assets) out[a.browser_download_url] = a.download_count;
      if (rel.length < 100) break;
    }
  } catch (e) { console.warn(`download counts skipped (${e.message})`); return {}; }
  return out;
}

// ---------- write everything ----------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
copyDir(path.join(ROOT, 'assets'), path.join(OUT, 'assets'));
write('.nojekyll', '');
// content/root/: files served as-is at the site root (e.g. Google Search Console ownership file)
const ROOTFILES = path.join(CONTENT, 'root');
if (exists(ROOTFILES)) for (const f of fs.readdirSync(ROOTFILES)) fs.copyFileSync(path.join(ROOTFILES, f), path.join(OUT, f));
if (site.domain) write('CNAME', site.domain + '\n');

write('index.html', home());
write('install/index.html', install());
write('privacy.html', docPage('privacy'));
write('terms.html', docPage('terms'));
write('404.html', page({ title: `Not found · ${site.name}`, description: 'Page not found', noindex: true, body: `<section class="hero"><h1>Page not found</h1><p>That page doesn't exist, or it moved.</p></section><ul class="updates">${listed.map(a => `<li><a class="upd" href="/apps/${a.id}/"><img class="icon" src="${iconOf(a.id)}" alt="" width="44" height="44"><span><b>${esc(a.name)}</b><br><span class="small">${esc(a.tagline)}</span></span></a></li>`).join('')}</ul><p><a href="/">All apps</a></p>` }));
write('updates/index.html', updatesPage());
write('feed.xml', atomFeed());

const catalog = [];
for (const app of apps) {
  copyDir(path.join(CONTENT, 'apps', app.id), path.join(OUT, 'apps', app.id));
  write(`apps/${app.id}/index.html`, appPage(app));
  write(`apps/${app.id}/privacy/index.html`, docPage('privacy', app));
  write(`apps/${app.id}/terms/index.html`, docPage('terms', app));
  const feeds = {};
  const a = androidFeed(site, app), w = windowsFeed(site, app);
  if (a) { json(`api/${app.id}/android.json`, a); feeds.android = `${site.baseUrl}/api/${app.id}/android.json`; write(`get/${app.id}/android/index.html`, getPage(app, a.apk, 'for Android')); }
  if (w) { json(`api/${app.id}/windows.json`, w); feeds.windows = `${site.baseUrl}/api/${app.id}/windows.json`; const f = w.files.setup || w.files.portable; write(`get/${app.id}/windows/index.html`, getPage(app, f.url, 'for Windows')); }
  const currentRel = new Set(Object.keys(app.platforms).map(p => latestFor(app, p)).filter(Boolean));
  json(`api/${app.id}/releases.json`, (app.releases || []).map(r => ({
    version: r.version, ...(r.code != null && { code: r.code }), date: r.date, status: r.status, notes: r.notes, ...(r.changes && { changes: r.changes }),
    ...(r.status === 'pulled' ? { pulledReason: r.pulledReason } : currentRel.has(r) ? { files: r.files.map(({ kind, name, url, size, sha256 }) => ({ kind, name, url, size, sha256 })) } : {})
  })));
  if (app.visibility === 'public') catalog.push({ id: app.id, name: app.name, tagline: app.tagline, page: appUrl(site, app), icon: site.baseUrl + iconOf(app.id), feeds });
}
json('api/catalog.json', catalog);

// Old URLs that installed apps still read: same content as the new feed, from the same data.
for (const [rel, id] of Object.entries(site.legacyFeeds || {})) {
  const app = apps.find(a => a.id === id), feed = app && androidFeed(site, app);
  if (feed) json(rel, feed);                                          // no live release yet → no file (404), as before
}

write('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${site.baseUrl}/sitemap.xml\n`);
const urls = ['/', '/updates/', '/install/', '/privacy.html', '/terms.html', ...listed.flatMap(a => [`/apps/${a.id}/`, `/apps/${a.id}/privacy/`, `/apps/${a.id}/terms/`])];
write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${site.baseUrl}${u}</loc></url>`).join('\n')}\n</urlset>\n`);

console.log(`Built ${apps.length} app page(s) (${listed.length} listed) into ${path.relative(ROOT, OUT) || OUT}`);
