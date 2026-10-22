// Builds the whole public site into dist/ from data/ and content/.
//   node tools/build.mjs                  build with download counts (needs network; skips them if offline)
//   node tools/build.mjs --no-counts      build without asking GitHub for counts
//   node tools/build.mjs --data <dir>     use another data folder (tests)
// Plain Node 20+, no packages. If data/ is invalid it stops before writing anything, so a
// broken edit can never reach the live site.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, PLATFORMS, KINDS, loadData, latestFor, androidFeed, windowsFeed, appUrl } from './lib.mjs';

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

const appCount = app => (app.releases || []).reduce((t, r) => t + r.files.reduce((u, f) => u + (counts[f.url] || 0), 0), 0);

const LOGO = `<svg viewBox="0 0 40 40" width="36" height="36" aria-hidden="true"><defs><linearGradient id="zg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#73E6D8"/><stop offset=".45" stop-color="#818CF8"/><stop offset=".75" stop-color="#C084FC"/><stop offset="1" stop-color="#F472B6"/></linearGradient></defs><rect x="1" y="1" width="38" height="38" rx="11" fill="#0b0f17" stroke="url(#zg)" stroke-opacity=".55"/><path d="M11 12h13L11 28h13" fill="none" stroke="url(#zg)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M33 15.5a6 6 0 1 0 0 9V21h-3.5" fill="none" stroke="url(#zg)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function page({ title, description, body, noindex = false, canonical = '' }) {
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
<meta name="theme-color" content="#070a0f">
<link rel="icon" href="/assets/logo.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/site.css">
<script src="/assets/site.js" defer></script>
</head>
<body>
<header class="top"><div class="wrap top-in">
  <a class="brand" href="/">${LOGO}<span><b class="iri-text">ZENITH GEN</b><small>STUDIO</small></span></a>
  <nav><a href="/#apps">Apps</a><a href="/install/">Install help</a><a href="/privacy.html">Privacy</a></nav>
</div></header>
<main class="wrap">
${body}
</main>
<footer class="wrap foot">
  <p>No ads. No tracking. No cookies.</p>
  <p><a href="/">Home</a><a href="/install/">Install help</a><a href="/privacy.html">Privacy policy</a><a href="mailto:${esc(site.contact)}">Contact</a></p>
  <p class="muted">© ${new Date().getUTCFullYear()} ${esc(site.name)}</p>
</footer>
</body>
</html>
`;
}

const chips = app => Object.keys(app.platforms).map(p => `<span class="chip">${PLATFORMS[p]}</span>`).join('');

// ---------- home ----------
function home() {
  const cards = listed.map(a => {
    const latest = (a.releases || []).find(r => r.status === 'live');
    return `<a class="card app-card" href="/apps/${a.id}/">
  <img class="icon" src="/apps/${a.id}/icon.webp" alt="" width="64" height="64">
  <div><h3>${esc(a.name)}</h3><p class="muted small">${esc(a.category || '')}</p></div>
  <p class="tag">${esc(a.tagline)}</p>
  <div class="chips">${chips(a)}${latest ? `<span class="chip ghost">v${esc(latest.version)}</span>` : '<span class="chip ghost">Coming soon</span>'}</div>
</a>`;
  }).join('\n');
  return page({
    title: `${site.name}: apps`,
    description: site.tagline,
    canonical: site.baseUrl + '/',
    body: `<section class="hero">
  <span class="pill">✦ Made by one developer</span>
  <h1>Apps without the noise.</h1>
  <p>${esc(site.tagline)} Download them here directly, always the newest version, with every older one kept.</p>
</section>
<section id="apps"><h2 class="sec">Apps</h2>
<div class="grid">${cards || '<p class="muted">Apps are on their way.</p>'}</div></section>
<section class="principles">
  <div><b>No ads</b><span>None, in any app.</span></div>
  <div><b>No tracking</b><span>No analytics, no cookies, on this site or in the apps.</span></div>
  <div><b>Your data stays yours</b><span>Kept on your device. Synced only if you sign in.</span></div>
  <div><b>Checkable downloads</b><span>Every file lists its SHA-256 fingerprint.</span></div>
</section>`
  });
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
  const panels = Object.entries(app.platforms).map(([p, info]) => {
    const r = latestFor(app, p);
    const files = r ? r.files.filter(f => KINDS[f.kind] === p) : [];
    return `<div class="card dl" data-platform="${p}">
  <div class="dl-head"><h3>${PLATFORMS[p]}</h3><span class="muted small">${esc(info.requires || '')}</span></div>
  ${r ? `<p class="ver">Version ${esc(r.version)} · ${date(r.date)}</p>
  <div class="btns">${files.map((f, i) => fileButton(f, i === 0)).join('')}</div>
  <p class="notes"><b>What's new:</b> ${esc(r.notes)}</p>
  ${hashes(files)}
  <p class="small"><a href="/install/#${p}">How to install on ${PLATFORMS[p]}</a></p>`
    : '<p class="muted">No download yet.</p>'}
</div>`;
  }).join('\n');

  const shots = (app.screenshots || []).length ? `<section><h2 class="sec">Screenshots</h2><div class="shots">${app.screenshots.map((s, i) =>
    `<img src="/apps/${app.id}/shots/${esc(s)}" alt="${esc(app.name)} screenshot ${i + 1}" loading="lazy" width="270">`).join('')}</div></section>` : '';

  const about = `<section><h2 class="sec">About</h2>${(app.description || []).map(p => `<p>${esc(p)}</p>`).join('')}
${(app.features || []).length ? `<ul class="feat">${app.features.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}</section>`;

  const versions = (app.releases || []).length ? `<section><h2 class="sec">All versions</h2><ol class="versions">${app.releases.map(r => `<li class="${r.status}">
  <div class="vrow"><b>${esc(r.version)}</b><span class="muted small">${date(r.date)}</span>${r.status === 'pulled' ? '<span class="chip warn">Pulled</span>' : ''}</div>
  <p>${esc(r.notes)}</p>
  ${(r.changes || []).length ? `<ul>${r.changes.map(c => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
  ${r.status === 'pulled' ? `<p class="small warn-text">Withdrawn: ${esc(r.pulledReason)}</p>` : `<p class="small files">${r.files.map(f =>
    `<a href="${esc(f.url)}">${esc(f.name)}</a> <span class="muted">${mb(f.size)}${counts[f.url] != null ? ` · ${num(counts[f.url])} downloads` : ''}</span>`).join('<br>')}</p>${hashes(r.files)}`}
</li>`).join('')}</ol></section>` : '';

  const total = appCount(app);
  return page({
    title: `${app.name} · ${site.name}`,
    description: app.tagline,
    noindex: app.visibility !== 'public',
    canonical: appUrl(site, app),
    body: `<section class="app-head">
  <img class="icon big" src="/apps/${app.id}/icon.webp" alt="" width="96" height="96">
  <div><h1>${esc(app.name)}</h1><p class="tag">${esc(app.tagline)}</p>
  <div class="chips">${chips(app)}${app.category ? `<span class="chip ghost">${esc(app.category)}</span>` : ''}${total ? `<span class="chip ghost">${num(total)} downloads</span>` : ''}</div></div>
</section>
<section class="dls">${panels}</section>
${shots}
${about}
${versions}
<p class="small"><a href="/apps/${app.id}/privacy/">${esc(app.name)} privacy policy</a></p>`
  });
}

// ---------- privacy ----------
const intro = () => fill(read(path.join(CONTENT, 'privacy/intro.html')));
const shared = () => fill(read(path.join(CONTENT, 'privacy/shared.html')));
const appPrivacy = app => { const p = path.join(CONTENT, 'apps', app.id, 'privacy.html'); return exists(p) ? fill(read(p)) : ''; };

function privacyAll() {
  const names = apps.map(a => a.name);
  const list = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names.at(-1) : names[0];
  return page({
    title: `Privacy policy · ${site.name}`,
    description: `How ${site.name}'s apps handle your data.`,
    canonical: site.baseUrl + '/privacy.html',
    body: `<article class="prose"><h1>Privacy policy</h1><p class="muted">Last updated: ${date(site.privacyUpdated)}</p>
<p>This policy covers the apps made by ${esc(site.name)}, a solo developer: ${esc(list)} (“the apps”).</p>
${intro()}${apps.map(appPrivacy).join('')}${shared()}</article>`
  });
}
function privacyApp(app) {
  return page({
    title: `${app.name} privacy policy · ${site.name}`,
    description: `How ${app.name} handles your data.`,
    noindex: app.visibility !== 'public',
    body: `<article class="prose"><p class="small"><a href="/apps/${app.id}/">← ${esc(app.name)}</a></p><h1>${esc(app.name)} privacy policy</h1><p class="muted">Last updated: ${date(site.privacyUpdated)}</p>
<p>${esc(app.name)} is made by ${esc(site.name)}, a solo developer.</p>
${intro()}${appPrivacy(app)}${shared()}</article>`
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
if (site.domain) write('CNAME', site.domain + '\n');

write('index.html', home());
write('install/index.html', install());
write('privacy.html', privacyAll());
write('404.html', page({ title: `Not found · ${site.name}`, description: 'Page not found', noindex: true, body: '<section class="hero"><h1>Page not found</h1><p><a href="/">Back to all apps</a></p></section>' }));

const catalog = [];
for (const app of apps) {
  copyDir(path.join(CONTENT, 'apps', app.id), path.join(OUT, 'apps', app.id));
  write(`apps/${app.id}/index.html`, appPage(app));
  write(`apps/${app.id}/privacy/index.html`, privacyApp(app));
  const feeds = {};
  const a = androidFeed(site, app), w = windowsFeed(site, app);
  if (a) { json(`api/${app.id}/android.json`, a); feeds.android = `${site.baseUrl}/api/${app.id}/android.json`; write(`get/${app.id}/android/index.html`, getPage(app, a.apk, 'for Android')); }
  if (w) { json(`api/${app.id}/windows.json`, w); feeds.windows = `${site.baseUrl}/api/${app.id}/windows.json`; const f = w.files.setup || w.files.portable; write(`get/${app.id}/windows/index.html`, getPage(app, f.url, 'for Windows')); }
  json(`api/${app.id}/releases.json`, (app.releases || []).map(r => ({
    version: r.version, ...(r.code != null && { code: r.code }), date: r.date, status: r.status, notes: r.notes,
    ...(r.status === 'pulled' ? { pulledReason: r.pulledReason } : { files: r.files.map(({ kind, name, url, size, sha256 }) => ({ kind, name, url, size, sha256 })) })
  })));
  if (app.visibility === 'public') catalog.push({ id: app.id, name: app.name, tagline: app.tagline, page: appUrl(site, app), icon: `${site.baseUrl}/apps/${app.id}/icon.webp`, feeds });
}
json('api/catalog.json', catalog);

// Old URLs that installed apps still read: same content as the new feed, from the same data.
for (const [rel, id] of Object.entries(site.legacyFeeds || {})) {
  const app = apps.find(a => a.id === id), feed = app && androidFeed(site, app);
  if (feed) json(rel, feed);                                          // no live release yet → no file (404), as before
}

write('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${site.baseUrl}/sitemap.xml\n`);
const urls = ['/', '/install/', '/privacy.html', ...listed.flatMap(a => [`/apps/${a.id}/`, `/apps/${a.id}/privacy/`])];
write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${site.baseUrl}${u}</loc></url>`).join('\n')}\n</urlset>\n`);

console.log(`Built ${apps.length} app page(s) (${listed.length} listed) into ${path.relative(ROOT, OUT) || OUT}`);
