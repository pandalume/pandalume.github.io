#!/usr/bin/env node
// zgs: Zenith Gen Orbit publisher. Runs on your PC from the hub repo folder.
//
//   node tools/zgs.mjs                    menu: shows every app and which have a new build ready
//   node tools/zgs.mjs publish <app> [--dry-run] [--notes "…"] [--changes "a | b"] [--platform android|windows] [--yes]
//   node tools/zgs.mjs publish <app> --backfill --from "<folder>" --date YYYY-MM-DD --notes "…"
//   node tools/zgs.mjs pull <app> <version> --reason "…" [--delete-files] [--yes]
//   node tools/zgs.mjs status [app]
//   node tools/zgs.mjs verify [--deep]
//   node tools/zgs.mjs mine <app> [android|windows]   don't count a download you made yourself
//   node tools/zgs.mjs move <app> family [--delete-public]   make an app family & friends only
//
// publish: reads the newest build from Finished Apps, checks it, uploads it to a GitHub release,
// re-downloads every file to confirm its SHA-256, and only then records the version in
// data/apps/<app>.json and pushes. That one push rebuilds the page, buttons and update feeds together.
// Needs: Node 20+, git (signed in to GitHub), and for APKs the Android SDK build-tools + Java.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import https from 'node:https';
import { ROOT, KINDS, PLATFORMS, NOTES_MAX, loadData, readJson, writeJson, validate, cmpVersion, latestFor, releaseTag, androidFeed, windowsFeed, pendingPolicyChanges } from './lib.mjs';

const CONFIG = readJson(path.join(ROOT, 'tools', 'zgs.config.json'));
const argv = process.argv.slice(2);
const [cmd, ...rest] = argv[0]?.startsWith('--') ? [undefined, ...argv] : argv;   // flags alone = menu with flags
const flags = {}, pos = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith('--')) { const k = a.slice(2); flags[k] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true; }
  else pos.push(a);
}
const FORBIDDEN = /\.(jks|keystore|p12|pfx|pem|key|properties|env)$/i;

// ---------- small utilities ----------
const c = { ok: s => `\x1b[32m${s}\x1b[0m`, bad: s => `\x1b[31m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m` };
class Stop extends Error {}
const stop = m => { throw new Stop(m); };
const say = m => console.log(m);
const mb = n => (n / 1e6).toFixed(1) + ' MB';
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function run(file, args, opts = {}) {
  const r = spawnSync(file, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6, ...opts });
  if (r.error) stop(`${file} could not run: ${r.error.message}`);
  return r;
}
function git(...args) {
  const r = run('git', args);
  if (r.status !== 0) stop(`git ${args.join(' ')} failed:\n${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}
function sha256File(file) {
  const h = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), buf = Buffer.alloc(4 << 20);
  for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  fs.closeSync(fd);
  return h.digest('hex');
}
async function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(q)).trim(); } finally { rl.close(); }
}
async function confirm(q) { return flags.yes || /^y(es)?$/i.test(await ask(`${q} [y/N] `)); }

// ---------- GitHub ----------
let TOKEN;
function token() {
  if (TOKEN) return TOKEN;
  TOKEN = process.env.ZGS_GITHUB_TOKEN;
  if (!TOKEN) {                                         // reuse the login git already has (Windows Credential Manager)
    const r = run('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    TOKEN = /^password=(.+)$/m.exec(r.stdout || '')?.[1];
  }
  if (!TOKEN) stop('No GitHub login found. Sign in once with "git push" in this folder, or set ZGS_GITHUB_TOKEN to a fine-grained token (this repo only, Contents: read and write).');
  return TOKEN;
}
// Family apps live in a private repository (site.json "family.repo"). zgs reaches it with the GitHub CLI's
// login (gh auth login), because the saved git token only covers the website repository.
let FTOKEN;
function familyToken() {
  if (FTOKEN) return FTOKEN;
  FTOKEN = process.env.ZGS_FAMILY_TOKEN;
  for (const exe of ['gh', 'C:\\Program Files\\GitHub CLI\\gh.exe']) {
    if (FTOKEN) break;
    const r = spawnSync(exe, ['auth', 'token'], { encoding: 'utf8' });
    if (r.status === 0) FTOKEN = r.stdout.trim();
  }
  if (!FTOKEN) stop('Family apps need the GitHub CLI signed in. Run: gh auth login');
  return FTOKEN;
}
const FAMILY = () => SITE().family?.repo || stop('site.json has no "family.repo".');
const FAPI = p => `https://api.github.com/repos/${FAMILY()}${p}`;
const tokenFor = url => SITE().family?.repo && url.includes(SITE().family.repo) ? familyToken() : token();

async function gh(method, url, body, extra = {}) {
  const full = url.startsWith('http') ? url : `https://api.github.com/repos/${SITE().repo}${url}`;
  const res = await fetch(full, {
    method, body, duplex: body ? 'half' : undefined,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${tokenFor(full)}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'zgs', ...extra }
  });
  if (res.status === 404 && method === 'GET') return null;
  if (!res.ok) stop(`GitHub ${method} ${url} → ${res.status}: ${(await res.text()).slice(0, 300)}${res.status === 401 ? '\nThe saved GitHub login was refused. Set ZGS_GITHUB_TOKEN (see README).' : ''}`);
  return res.status === 204 ? null : res.json();
}
/** Streams a file to a release with a progress line. Uses node:https, not fetch: fetch gives up when
 *  GitHub takes over 5 minutes to answer, which happens for 100 MB+ files on a home connection. */
function uploadAsset(uploadUrl, file, name) {
  const size = fs.statSync(file).size, url = new URL(`${uploadUrl.replace(/\{.*$/, '')}?name=${encodeURIComponent(name)}`);
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers: { Authorization: `Bearer ${tokenFor(uploadUrl)}`, Accept: 'application/vnd.github+json', 'User-Agent': 'zgs', 'Content-Type': 'application/octet-stream', 'Content-Length': size } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', d => (body += d));
      res.on('end', () => { process.stdout.write('\n'); res.statusCode < 300 ? resolve(JSON.parse(body)) : reject(new Stop(`Upload of ${name} failed: GitHub ${res.statusCode} ${body.slice(0, 200)}`)); });
    });
    req.on('error', e => reject(new Stop(`Upload of ${name} failed: ${e.message}. Run the same command again to resume.`)));
    let sent = 0, shown = -1;
    fs.createReadStream(file).on('data', chunk => {
      sent += chunk.length; const pct = Math.floor(sent * 100 / size);
      if (pct !== shown && pct % 5 === 0) { shown = pct; process.stdout.write(`\r    ${pct}%`); }
    }).on('error', reject).pipe(req);
  });
}

async function downloadSha(url) {
  let res;
  if (url.startsWith('https://api.github.com/')) {                  // private asset: ask GitHub for a short-lived link first
    const r = await fetch(url, { redirect: 'manual', headers: { Accept: 'application/octet-stream', Authorization: `Bearer ${tokenFor(url)}`, 'User-Agent': 'zgs' } });
    const loc = r.headers.get('location');
    res = loc ? await fetch(loc, { headers: { 'User-Agent': 'zgs' } }) : r;
  } else res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'zgs' } });
  if (!res.ok) stop(`Download check failed: ${url} → ${res.status}`);
  const h = crypto.createHash('sha256'); let size = 0;
  for await (const chunk of res.body) { h.update(chunk); size += chunk.length; }
  return { sha256: h.digest('hex'), size };
}

let _data;
const DATA = () => (_data ||= loadData());
const SITE = () => DATA().site;
function appById(id) {
  const app = DATA().apps.find(a => a.id === id);
  if (!app) stop(`Unknown app "${id}". Known: ${DATA().apps.map(a => a.id).join(', ')}`);
  return app;
}

// ---------- reading builds ----------
function androidTools() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
  const bt = path.join(sdk, 'build-tools');
  if (!fs.existsSync(bt)) stop(`Android build-tools not found in ${bt}. Set ANDROID_HOME.`);
  const ver = fs.readdirSync(bt).filter(v => /^\d/.test(v)).sort(cmpVersion).at(-1);
  const dir = path.join(bt, ver), exe = process.platform === 'win32' ? '.exe' : '';
  const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java' + exe) : 'java';
  return { aapt2: path.join(dir, 'aapt2' + exe), apksignerJar: path.join(dir, 'lib', 'apksigner.jar'), java };
}
function inspectApk(file) {
  const t = androidTools();
  const b = run(t.aapt2, ['dump', 'badging', file]);
  const m = /package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/.exec(b.stdout);
  if (b.status !== 0 || !m) stop(`Couldn't read ${path.basename(file)} with aapt2:\n${b.stderr}`);
  const v = run(t.java, ['-jar', t.apksignerJar, 'verify', '--print-certs', file]);
  if (v.status !== 0) stop(`${path.basename(file)} failed signature verification:\n${v.stderr || v.stdout}`);
  const certs = [...v.stdout.matchAll(/certificate SHA-256 digest: ([0-9a-f]{64})/g)].map(x => x[1]);
  if (!certs.length) stop(`No signing certificate found in ${path.basename(file)}.`);
  const pd = run(t.aapt2, ['dump', 'permissions', file]);
  const permissions = [...new Set([...(pd.stdout || '').matchAll(/uses-permission: name='([^']+)'/g)].map(x => x[1]))];
  return { package: m[1], code: Number(m[2]), version: m[3], certs: [...new Set(certs)], permissions };
}
const EXE = /^(.*?)[-_ ](Setup|Portable)[-_ ]v?(\d+(?:\.\d+){1,3})(?:-x64)?\.exe$/i;

/** Finds the build files to publish for an app and works out their version. */
function findBuild(app, folder) {
  if (!fs.existsSync(folder)) stop(`Build folder not found: ${folder}`);
  const files = [];
  for (const name of fs.readdirSync(folder)) {
    const full = path.join(folder, name);
    if (!fs.statSync(full).isFile()) continue;
    if (FORBIDDEN.test(name)) stop(`Refusing: ${name} looks like a key or secret and sits next to the build. Move it out of ${folder}.`);
    if (/\.apk$/i.test(name)) files.push({ kind: 'apk', full, name });
    else { const m = EXE.exec(name); if (m) files.push({ kind: m[2].toLowerCase(), full, name, version: m[3] }); }
  }
  const only = flags.platform;
  const picked = files.filter(f => app.platforms[KINDS[f.kind]] && (!only || KINDS[f.kind] === only));
  if (!picked.length) stop(`No ${only || ''} build for ${app.name} in ${folder} (looked for .apk, *-Setup-<ver>.exe, *-Portable-<ver>.exe).`);
  for (const k of ['apk', 'setup', 'portable']) if (picked.filter(f => f.kind === k).length > 1) stop(`More than one ${k} file in ${folder}. Leave only the build to publish.`);

  let code = null, permissions = null;
  for (const f of picked) {
    f.size = fs.statSync(f.full).size;
    if (f.size < 1024) stop(`${f.name} is only ${f.size} bytes.`);
    const head = Buffer.alloc(4); const fd = fs.openSync(f.full, 'r'); fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd);
    if (f.kind === 'apk') {
      if (head.toString('hex') !== '504b0304') stop(`${f.name} is not a valid APK (zip).`);
      const info = inspectApk(f.full), want = app.platforms.android;
      if (info.package !== want.package) stop(`${f.name} is package ${info.package}, expected ${want.package}.`);
      if (info.certs.length !== 1 || info.certs[0] !== want.certSha256)
        stop(`${f.name} is signed with the wrong key.\n  signed with: ${info.certs.join(', ')}\n  expected:    ${want.certSha256}\nIs this a debug build? Build the release APK with the release keystore.`);
      f.version = info.version; code = info.code; permissions = info.permissions;
    } else if (head.subarray(0, 2).toString() !== 'MZ') stop(`${f.name} is not a Windows program.`);
  }
  const versions = [...new Set(picked.map(f => f.version))];
  if (versions.length > 1) stop(`The files have different versions (${picked.map(f => `${f.name}=${f.version}`).join(', ')}). Publish one platform at a time with --platform.`);
  return { version: versions[0], code, permissions, files: picked };
}

// ---------- family repository (private) ----------
const enc = p => p.split('/').map(encodeURIComponent).join('/');
const blobSha = b => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex');
async function fGetJson(p) { const r = await gh('GET', FAPI('/contents/' + enc(p))); return r ? JSON.parse(Buffer.from(r.content, 'base64').toString('utf8')) : null; }
async function fList(p) { const r = await gh('GET', FAPI('/contents/' + enc(p))); return Array.isArray(r) ? r : []; }
async function fPut(p, buf, message) {
  const cur = await gh('GET', FAPI('/contents/' + enc(p)));
  if (cur && cur.sha === blobSha(buf)) return false;
  await gh('PUT', FAPI('/contents/' + enc(p)), JSON.stringify({ message, content: buf.toString('base64'), ...(cur && { sha: cur.sha }) }), { 'Content-Type': 'application/json' });
  return true;
}
async function fDelete(p, sha, message) { await gh('DELETE', FAPI('/contents/' + enc(p)), JSON.stringify({ message, sha }), { 'Content-Type': 'application/json' }); }
/** The full data of a family app: the website keeps only a stub (name, platforms) for its policy pages. */
async function familyApp(stub) {
  const remote = await fGetJson(`apps/${stub.id}.json`);
  return { ...stub, ...(remote || { releases: [] }), visibility: 'family', _file: stub._file };
}
// What the public website keeps of a family app: enough for its privacy and terms pages, nothing else.
const STUB = ['id', 'name', 'order', 'visibility', 'tagline', 'contentNoun', 'platforms'];
const stubOf = raw => Object.fromEntries(STUB.filter(k => raw[k] !== undefined).map(k => [k, raw[k]]));

/** Uploads a family app's listing images to the private repo, removing screenshots that are gone. */
async function pushFamilyFiles(id, L, label) {
  const want = Object.entries(L.files).filter(([rel]) => !rel.endsWith('.html'));
  for (const [rel, f] of want) if (await fPut(`apps/${id}/${rel}`, fs.readFileSync(f), `${label}: ${rel}`)) say(c.dim(`  sent ${rel}`));
  if (L.shots) for (const old of await fList(`apps/${id}/shots`)) if (!want.some(([rel]) => rel === 'shots/' + old.name)) await fDelete(old.path, old.sha, `${label}: remove ${old.name}`);
  if (want.some(([rel]) => rel.startsWith('icon.'))) for (const old of await fList(`apps/${id}`)) if (/^icon\./.test(old.name) && !L.files[old.name]) await fDelete(old.path, old.sha, `${label}: remove ${old.name}`);
}

// ---------- store listing ----------
// An app chat can set up (and later update) the app's page without the hub chat by keeping a
// "Store listing" folder next to the builds:  listing.json, icon, screenshots\, screenshots-windows\,
// privacy.html, terms.html. Studio Standards\README.md explains each file.
const LISTING = 'Store listing', IMG = /\.(webp|png|jpe?g)$/i, TEXT = ['name', 'tagline', 'category', 'description', 'features', 'contentNoun', 'shotStyle', 'dataSafety', 'tags', 'ads', 'purchases'];
const hashBuf = b => crypto.createHash('sha256').update(b).digest('hex');
const appDir = id => path.join(ROOT, 'content', 'apps', id);

function readListing(folder) {
  const dir = path.join(folder, LISTING), file = path.join(dir, 'listing.json');
  if (!fs.existsSync(file)) return null;
  let l; try { l = readJson(file); } catch (e) { stop(`${file} is not valid JSON: ${e.message}`); }
  const pics = sub => { const d = path.join(dir, sub); return fs.existsSync(d) ? fs.readdirSync(d).filter(f => IMG.test(f)).sort().map(f => path.join(d, f)) : []; };
  const files = {};                                     // path under content/apps/<id>/ -> source file
  const icon = ['icon.webp', 'icon.png', 'icon.jpg'].map(f => path.join(dir, f)).find(f => fs.existsSync(f));
  if (icon) files[path.basename(icon)] = icon;
  const phone = pics('screenshots'), wide = pics('screenshots-windows'), shots = [];
  phone.forEach((f, i) => { const n = `${String(i + 1).padStart(2, '0')}${path.extname(f).toLowerCase()}`; files['shots/' + n] = f; shots.push(n); });
  wide.forEach((f, i) => { const n = `win-${String(i + 1).padStart(2, '0')}${path.extname(f).toLowerCase()}`; files['shots/' + n] = f; shots.push({ file: n, wide: true }); });
  for (const doc of ['privacy.html', 'terms.html']) {
    const f = path.join(dir, doc);
    if (!fs.existsSync(f)) continue;
    if (/<script|<iframe|<html|<body|\son\w+\s*=/i.test(fs.readFileSync(f, 'utf8'))) stop(`${f} must be a plain HTML section (headings, paragraphs, lists), with no scripts or <html>/<body>.`);
    files[doc] = f;
  }
  for (const [rel, f] of Object.entries(files)) if (/\.(webp|png|jpe?g)$/i.test(f) && fs.statSync(f).size > 1.5e6) stop(`${f} is ${mb(fs.statSync(f).size)}. Keep images under 1.5 MB (1080 px wide is plenty).`);
  return { dir, l, files, shots: phone.length + wide.length ? shots : null };
}

/** Store listing\whats-new.txt: first line the version, then one short line for phones, then "- " details.
 *  Ignored (with a note) when its version isn't the build's, so old notes are never reused. */
function whatsNew(folder, version) {
  const f = path.join(folder, LISTING, 'whats-new.txt');
  if (!fs.existsSync(f)) return null;
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const v = (lines.shift() || '').replace(/^v(ersion)?\s*/i, '');
  if (v !== version) { say(c.dim(`  (whats-new.txt is for ${v || '?'}, this build is ${version}; not using it)`)); return null; }
  const notes = lines.find(l => !/^[-•*]\s/.test(l)) || '';
  const changes = lines.filter(l => /^[-•*]\s/.test(l)).map(l => l.replace(/^[-•*]\s+/, '')).slice(0, 20);
  if (!notes || notes.length > NOTES_MAX) { say(c.bad(`  whats-new.txt needs one line under ${NOTES_MAX} characters after the version.`)); return null; }
  return { notes, changes };
}

/** What the listing would change on an existing (or new) app, without writing anything. */
async function listingDiffFamily(app, L) {
  const out = [];
  for (const k of TEXT) if (L.l[k] !== undefined && JSON.stringify(L.l[k]) !== JSON.stringify(app[k])) out.push(k);
  if (L.shots && JSON.stringify(L.shots) !== JSON.stringify(app.screenshots || [])) out.push('screenshots list');
  const remote = new Map([...(await fList(`apps/${app.id}`)), ...(await fList(`apps/${app.id}/shots`))].map(x => [x.path.replace(`apps/${app.id}/`, ''), x.sha]));
  for (const [rel, f] of Object.entries(L.files)) {
    const b = fs.readFileSync(f);
    if (rel.endsWith('.html')) { const cur = path.join(appDir(app.id), rel); if (!fs.existsSync(cur) || hashBuf(fs.readFileSync(cur)) !== hashBuf(b)) out.push(rel); }
    else if (remote.get(rel) !== blobSha(b)) out.push(rel);
  }
  return [...new Set(out)];
}

function listingDiff(app, L) {
  const out = [];
  for (const k of TEXT) if (L.l[k] !== undefined && JSON.stringify(L.l[k]) !== JSON.stringify(app[k])) out.push(k);
  if (L.shots && JSON.stringify(L.shots) !== JSON.stringify(app.screenshots || [])) out.push('screenshots list');
  for (const [rel, f] of Object.entries(L.files)) {
    const cur = path.join(appDir(app.id), rel);
    if (!fs.existsSync(cur) || hashBuf(fs.readFileSync(cur)) !== hashBuf(fs.readFileSync(f))) out.push(rel);
  }
  return [...new Set(out)];
}

/** Copies the listing into the hub: text into data/apps/<id>.json, files into content/apps/<id>/. */
function applyListing(raw, L, family = false) {
  for (const k of TEXT) if (L.l[k] !== undefined) raw[k] = L.l[k];
  if (L.shots) raw.screenshots = L.shots;
  const dir = appDir(raw.id);
  if (family) {                                          // images go to the private repo (pushFamilyFiles)
    fs.mkdirSync(dir, { recursive: true });
    for (const doc of ['privacy.html', 'terms.html']) if (L.files[doc]) fs.copyFileSync(L.files[doc], path.join(dir, doc));
    return;
  }
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  if (Object.keys(L.files).some(r => r.startsWith('icon.'))) for (const f of ['icon.webp', 'icon.png', 'icon.jpg']) fs.rmSync(path.join(dir, f), { force: true });
  if (L.shots) { for (const f of fs.readdirSync(path.join(dir, 'shots'))) fs.rmSync(path.join(dir, 'shots', f)); raw.screenshots = L.shots; }
  for (const [rel, f] of Object.entries(L.files)) fs.copyFileSync(f, path.join(dir, rel));
}

/** Builds the data entry for an app that isn't on Zenith yet, from its listing and its build. */
function newAppFromListing(L, folder) {
  const l = L.l, id = l.id;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id || '')) stop(`listing.json needs "id": lowercase-with-dashes, e.g. "my-app".`);
  for (const k of ['name', 'tagline']) if (!l[k]) stop(`listing.json needs "${k}".`);
  if (!Object.keys(L.files).some(r => r.startsWith('icon.'))) stop(`${L.dir} needs icon.png or icon.webp (512 x 512).`);
  if (!L.files['privacy.html']) stop(`${L.dir} needs privacy.html (what the app collects and where it goes; see Studio Standards).`);
  if (!l.dataSafety) stop('listing.json needs "dataSafety" (what the app collects and sends; see Studio Standards README section 9).');
  const platforms = {};
  for (const [p, info] of Object.entries(l.platforms || {})) {
    if (!PLATFORMS[p]) stop(`listing.json: unknown platform "${p}" (use android or windows).`);
    platforms[p] = { ...(info.requires && { requires: info.requires }) };
  }
  if (!Object.keys(platforms).length) stop('listing.json needs "platforms", e.g. { "android": { "requires": "Android 8.0 or newer" } }.');
  if (platforms.android) {
    const apk = fs.readdirSync(folder).find(f => /\.apk$/i.test(f)) || stop(`No APK in ${folder} to read the package and signing key from.`);
    const info = inspectApk(path.join(folder, apk));
    if (info.certs.length !== 1) stop(`${apk} has ${info.certs.length} signing certificates; expected one.`);
    platforms.android = { package: info.package, certSha256: info.certs[0], ...platforms.android };
  }
  const order = Math.max(0, ...DATA().apps.map(a => a.order || 0)) + 1;
  const raw = { id, name: l.name, order, visibility: l.visibility || 'public', tagline: l.tagline, screenshots: [], platforms, releases: [] };
  return { raw, app: { ...raw, _file: path.join(ROOT, 'data', 'apps', id + '.json') } };
}

/** Finished Apps folders that have a Store listing for an app Zenith doesn't know yet. */
function newListings() {
  const known = new Set(DATA().apps.map(a => a.id)), found = [];
  const walk = (dir, depth) => {
    if (depth > 3 || !fs.existsSync(dir)) return;
    if (fs.existsSync(path.join(dir, LISTING, 'listing.json'))) {
      try { const id = readJson(path.join(dir, LISTING, 'listing.json')).id; if (id && !known.has(id)) found.push({ id, folder: dir }); } catch { /* reported when chosen */ }
      return;
    }
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('_')) walk(path.join(dir, e.name), depth + 1);
  };
  walk(CONFIG.finishedApps, 0);
  return found;
}

// ---------- commands ----------
async function publish(newApp = null) {
  let app, folder, created = null;
  if (newApp) {                                                       // first publish of an app found by its Store listing
    folder = newApp.folder;
    created = newAppFromListing(readListing(folder), folder);
    app = created.app;
  } else {
    app = appById(pos[0] || stop('Which app? e.g. zgs publish bambowl'));
    folder = flags.from || path.join(CONFIG.finishedApps, CONFIG.apps[app.id] || stop(`Add "${app.id}" to tools/zgs.config.json (its folder under Finished Apps).`));
  }
  const backfill = !!flags.backfill;
  if (backfill && !flags.from) stop('--backfill needs --from "<folder with the old build>".');
  const listing = backfill ? null : readListing(folder);
  const family = (listing?.l.visibility ?? app.visibility) === 'family';
  if (family && !created) app = await familyApp(app);
  if (family) app.visibility = 'family';
  const listingChanges = !listing ? [] : family ? await listingDiffFamily(app, listing) : listingDiff(app, listing);
  policyGuard(app, listing);

  say(c.b(`\n${app.name}: checking ${folder}`));
  const build = findBuild(app, folder);
  const all = app.releases || [];
  if (all.some(r => r.version === build.version)) stop(`${app.name} ${build.version} is already published. Raise the version and rebuild.`);
  const newest = all[0];
  if (!backfill && newest && cmpVersion(build.version, newest.version) <= 0) stop(`${build.version} is not newer than ${newest.version}. (Use --backfill to add an older build to the history.)`);
  if (build.code != null) {
    const codes = all.filter(r => r.code != null);
    if (!backfill && codes.some(r => r.code >= build.code)) stop(`versionCode ${build.code} is not higher than every published one (highest: ${Math.max(...codes.map(r => r.code))}). Phones only update to a higher versionCode.`);
  }
  for (const f of build.files) { f.sha256 = sha256File(f.full); f.upload = f.name.replace(/[^\w.-]+/g, '-'); }

  let notes = typeof flags.notes === 'string' ? flags.notes : '';
  let changes = typeof flags.changes === 'string' ? flags.changes.split('|').map(x => x.trim()).filter(Boolean) : [];
  const wn = !notes && !backfill && whatsNew(folder, build.version);  // written by the app chat, so you don't type it
  if (wn) {
    say(`\n  ${c.b("What's new")} ${c.dim('(from Store listing\\whats-new.txt)')}\n  ${wn.notes}`);
    for (const ch of wn.changes) say(`    • ${ch}`);
    if (flags.yes || await confirm('Use these notes?')) ({ notes, changes } = wn);
  }
  if (!notes) notes = await ask(`One line of what's new (max ${NOTES_MAX} chars): `);
  if (!notes) stop('Notes are required. Phones show them in the update bar.');
  if (notes.length > NOTES_MAX) stop(`Notes are ${notes.length} characters; the limit is ${NOTES_MAX}.`);
  if (!changes.length && typeof flags.notes !== 'string' && !flags.yes && !wn) {
    say(c.dim('More details for the version history (optional). One per line; press Enter on an empty line to finish.'));
    for (let line; (line = await ask('  • ')) && changes.length < 20;) changes.push(line);
  }
  const date = backfill ? (flags.date || stop('--backfill needs --date YYYY-MM-DD')) : today();

  const release = { version: build.version, ...(build.code != null && { code: build.code }), date, status: 'live', notes, ...(changes.length && { changes }), ...(build.permissions && { permissions: build.permissions }), files: [] };
  // Check the finished data would be valid *before* touching GitHub.
  const preview = [...all, { ...release, files: build.files.map(f => ({ kind: f.kind, name: f.upload, url: 'https://example.invalid/x', size: f.size, sha256: f.sha256 })) }]
    .sort((a, b) => cmpVersion(b.version, a.version));
  const errs = validate(SITE(), [{ ...app, releases: preview }]);
  if (errs.length) stop('This release would make the data invalid:\n  ' + errs.join('\n  '));

  say(`\n  ${c.b(app.name + ' ' + build.version)}${build.code != null ? ` (versionCode ${build.code})` : ''}  ·  ${date}${backfill ? '  ·  history only' : ''}`);
  for (const f of build.files) say(`  ${f.kind.padEnd(8)} ${f.name}  ${mb(f.size)}\n           sha256 ${c.dim(f.sha256)}`);
  say(`  notes    ${notes}`);
  for (const ch of changes) say(`           • ${ch}`);
  if (app.platforms.android && build.code != null) say(`  ${c.ok('✓')} signed with the ${app.name} release key`);
  if (family) say(`  ${c.ok('✓')} family & friends only: files go to the private repository, shown to invited people on ${SITE().baseUrl}/family/`);
  if (created) {
    say(c.b(`\n  New app on Zenith: ${app.name} (${app.visibility})`));
    say(`  page     ${SITE().baseUrl}/${family ? 'family/' : `apps/${app.id}/`}`);
    if (app.platforms.android) say(`  key      ${app.platforms.android.certSha256}\n           ${c.dim('This signing key is now pinned. Every future update must be signed with the same key.')}`);
  }
  if (listingChanges.length) say(`  listing  ${created ? 'icon, text, screenshots and policy from' : 'updates ' + listingChanges.join(', ') + ' from'} ${c.dim(listing.dir)}`);
  if (flags['dry-run']) { say(c.ok('\nDry run: all checks passed. Nothing was uploaded.')); return; }
  if (!(await confirm('\nPublish this?'))) stop('Cancelled. Nothing changed.');

  // git must be clean and current, so the push can't clash
  if (git('status', '--porcelain', '--', 'data', 'content', 'tools/zgs.config.json')) stop('data/ or content/ has uncommitted changes. Commit or undo them first.');
  git('pull', '--ff-only', '--quiet');
  _data = null;
  if (created && DATA().apps.some(a => a.id === app.id)) stop(`${app.id} was added meanwhile. Run Publish again.`);
  const fresh = created ? app : family ? await familyApp(appById(app.id)) : appById(app.id);   // re-read after pull
  if ((fresh.releases || []).some(r => r.version === build.version)) stop(`${build.version} was published meanwhile.`);

  // 1. release + uploads (re-running after a failure resumes here safely)
  const tag = releaseTag(app, build.version), R = p => family ? FAPI(p) : p;
  let rel = await gh('GET', R(`/releases/tags/${encodeURIComponent(tag)}`));
  if (!rel) rel = await gh('POST', R('/releases'), JSON.stringify({ tag_name: tag, ...(!family && { target_commitish: git('rev-parse', 'HEAD') }), name: `${app.name} ${build.version}`, body: notes, make_latest: 'false' }), { 'Content-Type': 'application/json' });
  for (const f of build.files) {
    let asset = rel.assets.find(a => a.name === f.upload);
    if (asset && asset.state !== 'uploaded') {                        // a broken earlier upload: clear it and retry
      say(c.dim(`  removing an unfinished earlier upload of ${f.upload}`));
      await gh('DELETE', R(`/releases/assets/${asset.id}`)); asset = null;
    }
    if (asset && asset.size !== f.size) stop(`Release ${tag} already has a different ${f.upload}. Delete that file on GitHub and run again.`);
    if (!asset) {
      say(`  uploading ${f.upload} (${mb(f.size)})…`);
      asset = await uploadAsset(rel.upload_url, f.full, f.upload);
    }
    f.url = family ? asset.url : asset.browser_download_url;          // private files are fetched through the API
    f.assetId = asset.id;
  }
  // 2. prove the public copies are byte-for-byte the files on this PC
  for (const f of build.files) {
    process.stdout.write(`  verifying ${f.upload}… `);
    const got = await downloadSha(f.url);
    if (got.sha256 !== f.sha256 || got.size !== f.size) stop(`MISMATCH for ${f.upload}: the public file differs from yours. Nothing was announced. Delete the file from release ${tag} on GitHub and run again.`);
    say(c.ok('ok'));
  }
  // 3. announce: one commit updates page, buttons and feeds together
  // selfDownloads: the check download above, so it isn't counted as someone downloading the app
  release.files = build.files.map(f => ({ kind: f.kind, name: f.upload, url: f.url, size: f.size, sha256: f.sha256, selfDownloads: 1, ...(family && { assetId: f.assetId }) }));
  let raw = created ? created.raw : family ? Object.fromEntries(Object.entries(fresh).filter(([k]) => k !== '_file')) : readJson(fresh._file);
  if (family) raw.visibility = 'family';
  if (listingChanges.length) applyListing(raw, listing, family);
  raw.releases = [...(raw.releases || []), release].sort((a, b) => cmpVersion(b.version, a.version));
  if (family) {
    const errs = validate(SITE(), [{ ...raw, _file: fresh._file }]);
    if (errs.length) stop('The family data would be invalid:\n  ' + errs.join('\n  '));
    if (listingChanges.length) await pushFamilyFiles(app.id, listing, `${app.name} ${build.version}`);
    await fPut(`apps/${app.id}.json`, Buffer.from(JSON.stringify(raw, null, 2) + '\n'), `Publish ${app.name} ${build.version}`);
    say(c.ok(`  recorded in the private repository`));
    raw = stubOf(raw);                                               // the website keeps only the stub
  }
  writeJson(fresh._file, raw);
  const touched = [fresh._file, path.join('content', 'apps', app.id)];
  if (created) { CONFIG.apps[app.id] = path.relative(CONFIG.finishedApps, folder); writeJson(path.join(ROOT, 'tools', 'zgs.config.json'), CONFIG); touched.push(path.join('tools', 'zgs.config.json')); }
  try { _data = null; loadData(); } catch (e) {
    if (created) { fs.rmSync(fresh._file, { force: true }); fs.rmSync(appDir(app.id), { recursive: true, force: true }); git('checkout', '--', 'tools/zgs.config.json'); }
    else git('checkout', '--', fresh._file, path.join('content', 'apps', app.id));
    stop(e.message);
  }
  git('add', '-A', '--', ...touched);
  if (git('status', '--porcelain', '--', ...touched)) {
    git('commit', '--quiet', '-m', `${created ? 'Add and publish' : backfill ? 'Add' : 'Publish'} ${app.name} ${family ? '(family)' : build.version}`);
    pushWithRetry();
    say(c.ok(`\nPushed. The site rebuilds in about a minute.`));
  }
  if (family) {
    say(`\n${c.b(`${app.name} ${build.version} is out for family & friends.`)} ${SITE().baseUrl}/family/`);
    say('Invited people see it there now. The app finds it at its next update check.');
  } else if (!backfill) await waitLive(app, { ...build, notes });
}

function pushWithRetry() {
  const r = run('git', ['push', '--quiet']);
  if (r.status === 0) return;
  git('pull', '--rebase', '--quiet');
  git('push', '--quiet');
}

async function waitLive(app, build) {
  const plats = [...new Set(build.files.map(f => KINDS[f.kind]))];
  const site = SITE(), until = Date.now() + 6 * 60e3;
  process.stdout.write('  waiting for the live feed');
  for (const p of plats) {
    const url = `${site.baseUrl}/api/${app.id}/${p}.json`;
    for (;;) {
      try { const res = await fetch(`${url}?t=${Date.now()}`); if (res.ok && (await res.json()).name === build.version) break; } catch { /* retry */ }
      if (Date.now() > until) { say(c.bad(`\n  Not live after 6 minutes. Check the "site" run under the repo's Actions tab.`)); return; }
      process.stdout.write('.'); await new Promise(r => setTimeout(r, 10e3));
    }
  }
  say(c.ok(` live.`));
  say(`\n${c.b(`${app.name} ${build.version} is out.`)} ${site.baseUrl}/apps/${app.id}/`);
  if (plats.includes('android')) say('Phones see it at their next daily check, or straight away via Help › Check for updates.');
  const link = plats.includes('android') ? `${site.baseUrl}/get/${app.id}/android/` : `${site.baseUrl}/apps/${app.id}/`;
  say(c.dim('\nReady to paste (WhatsApp, Telegram…):'));
  say(`${app.name} ${build.version} is out! ${build.notes}\nAlready have it? Open the app and tap Update.\nNew to it? ${link}`);
}

async function pull() {
  const app = appById(pos[0] || stop('Usage: zgs pull <app> <version> --reason "…"'));
  const version = pos[1] || stop('Which version?');
  const reason = typeof flags.reason === 'string' ? flags.reason : stop('Give a --reason "…" (shown on the site).');
  const r = (app.releases || []).find(x => x.version === version) || stop(`${app.name} ${version} isn't published.`);
  if (r.status === 'pulled') stop('Already pulled.');
  const before = { android: androidFeed(SITE(), app), windows: windowsFeed(SITE(), app) };
  const raw = readJson(app._file);
  Object.assign(raw.releases.find(x => x.version === version), { status: 'pulled', pulledReason: reason });
  const after = { ...app, releases: raw.releases };
  say(c.b(`\nPull ${app.name} ${version}: "${reason}"`));
  for (const p of Object.keys(app.platforms)) {
    const was = before[p]?.name, now = latestFor(after, p)?.version;
    if (was !== now) say(`  ${p}: update feed goes from ${was} to ${now || c.bad('nothing (no update offered)')}`);
  }
  if (r.code != null) say(c.dim('  Phones that already installed it keep it. Ship a fix with a higher versionCode.'));
  if (!(await confirm('Pull it?'))) stop('Cancelled.');
  git('pull', '--ff-only', '--quiet');
  writeJson(app._file, raw);
  try { _data = null; loadData(); } catch (e) { git('checkout', '--', app._file); stop(e.message); }
  if (flags['delete-files']) {
    const rel = await gh('GET', `/releases/tags/${encodeURIComponent(releaseTag(app, version))}`);
    for (const a of rel?.assets || []) { await gh('DELETE', `/releases/assets/${a.id}`); say(`  deleted ${a.name}`); }
  }
  git('add', app._file); git('commit', '--quiet', '-m', `Pull ${app.name} ${version}: ${reason}`); pushWithRetry();
  say(c.ok('Pushed. Live in about a minute.'));
}

async function status() {
  const site = SITE(), apps = pos[0] ? [appById(pos[0])] : DATA().apps;
  const counts = {};
  try { for (const r of (await gh('GET', '/releases?per_page=100')) || []) for (const a of r.assets) counts[a.browser_download_url] = a.download_count; } catch (e) { say(c.dim(`(download counts unavailable: ${e.message})`)); }
  if (apps.some(a => a.visibility === 'family'))
    try { for (const r of (await gh('GET', FAPI('/releases?per_page=100'))) || []) for (const a of r.assets) counts[a.url] = a.download_count; } catch (e) { say(c.dim(`(family download counts unavailable: ${e.message})`)); }
  for (const app0 of apps) {
    const app = app0.visibility === 'family' ? await familyApp(app0) : app0;
    say(`\n${c.b(app.name)} ${c.dim(`[${app.visibility}]`)}`);
    for (const p of app.visibility === 'family' ? [] : Object.keys(app.platforms)) {
      const want = latestFor(app, p)?.version || '-';
      let live = '-';
      try { const res = await fetch(`${site.baseUrl}/api/${app.id}/${p}.json?t=${Date.now()}`); if (res.ok) live = (await res.json()).name; } catch { live = '?'; }
      say(`  ${p.padEnd(8)} data ${want.padEnd(8)} live ${live === want ? c.ok(live) : c.bad(live)}`);
    }
    say(c.dim('  downloads by other people (zgs checks and ones you marked with "mine" are left out)'));
    for (const r of (app.releases || []).slice(0, 5)) {
      const n = r.files.reduce((t, f) => t + Math.max(0, (counts[f.url] || 0) - (f.selfDownloads || 0)), 0);
      say(`  ${r.version.padEnd(10)} ${r.date}  ${r.status === 'pulled' ? c.bad('pulled') : 'live  '}  ${n} downloads`);
    }
  }
}

async function verify() {
  let bad = 0; const fetched = [];
  for (const app of DATA().apps) for (const r of app.releases || []) {
    if (r.status !== 'live') continue;
    for (const f of r.files) {
      process.stdout.write(`${app.id} ${r.version} ${f.name}… `);
      if (flags.deep) {
        const got = await downloadSha(f.url); fetched.push(f.url);
        if (got.sha256 === f.sha256) say(c.ok('hash ok')); else { bad++; say(c.bad('HASH MISMATCH')); }
      } else {
        const res = await fetch(f.url, { method: 'HEAD', redirect: 'follow' });
        const len = Number(res.headers.get('content-length'));
        if (res.ok && len === f.size) say(c.ok('ok')); else { bad++; say(c.bad(`${res.status}, size ${len} (expected ${f.size})`)); }
      }
    }
  }
  say(bad ? c.bad(`\n${bad} problem(s).`) : c.ok('\nAll live files are reachable' + (flags.deep ? ' and match their hashes.' : '.')));
  if (fetched.length) await addSelfDownloads(fetched, 'Leave zgs check downloads out of the counts');
  if (bad) process.exitCode = 1;
}

/** zgs move <app> family: makes a published app family & friends only. Copies its current files,
 *  details, icon and screenshots to the private repository, and leaves only a stub (for its privacy
 *  and terms pages) on the website. The old public files stay on GitHub until you delete them
 *  (--delete-public removes those releases, after the copy is verified). */
async function move() {
  const app = appById(pos[0] || stop('Usage: zgs move <app> family [--delete-public]'));
  if (pos[1] !== 'family') stop('Only "family" is supported: zgs move <app> family');
  if (app.visibility === 'family') {
    if (!flags['delete-public']) stop(`${app.name} is already family-only.`);
    if (!(await confirm(`Delete the public GitHub releases of ${app.name}? Its private copies stay.`))) stop('Cancelled.');
    const fam = await familyApp(app);
    for (const r of fam.releases || []) {
      const pub = await gh('GET', `/releases/tags/${encodeURIComponent(releaseTag(app, r.version))}`);
      if (pub) { await gh('DELETE', `/releases/${pub.id}`); say(c.dim(`  deleted public release ${pub.tag_name}`)); }
    }
    return say(c.ok('Done.'));
  }
  const raw = readJson(app._file), current = new Set(Object.keys(app.platforms).map(p => latestFor(app, p)).filter(Boolean));
  say(c.b(`\nMove ${app.name} to family & friends only`));
  say(`  current files copied to ${FAMILY()}: ${[...current].flatMap(r => r.files.map(f => f.name)).join(', ') || 'none'}`);
  say(`  older versions keep their notes; their old public links are not shown anywhere`);
  say(`  website keeps: privacy and terms pages, and an "invite only" page at /apps/${app.id}/`);
  if (flags['delete-public']) say(c.bad(`  then deletes the public GitHub releases of ${app.name}`));
  if (!(await confirm('Go ahead?'))) stop('Cancelled.');
  git('pull', '--ff-only', '--quiet');
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'zgs-'));
  for (const r of raw.releases || []) {
    if (![...current].some(c0 => c0.version === r.version)) continue;
    const tag = releaseTag(app, r.version);
    let rel = await gh('GET', FAPI(`/releases/tags/${encodeURIComponent(tag)}`));
    if (!rel) rel = await gh('POST', FAPI('/releases'), JSON.stringify({ tag_name: tag, name: `${app.name} ${r.version}`, body: r.notes, make_latest: 'false' }), { 'Content-Type': 'application/json' });
    for (const f of r.files) {
      let asset = rel.assets.find(a => a.name === f.name && a.state === 'uploaded' && a.size === f.size);
      if (!asset) {
        say(`  copying ${f.name} (${mb(f.size)})…`);
        const res = await fetch(f.url, { redirect: 'follow' });
        if (!res.ok) stop(`Couldn't download ${f.url}: ${res.status}`);
        const local = path.join(tmp, f.name);
        await new Promise((ok, bad) => { const w = fs.createWriteStream(local); (async () => { for await (const ch of res.body) w.write(ch); w.end(); })().catch(bad); w.on('finish', ok); });
        if (sha256File(local) !== f.sha256) stop(`${f.name} doesn't match its recorded SHA-256. Nothing moved.`);
        asset = await uploadAsset(rel.upload_url, local, f.name);
      }
      const got = await downloadSha(asset.url);
      if (got.sha256 !== f.sha256) stop(`The private copy of ${f.name} doesn't match. Nothing moved.`);
      Object.assign(f, { url: asset.url, assetId: asset.id, selfDownloads: 1 });
      say(c.ok(`  ✓ ${f.name}`));
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  raw.visibility = 'family';
  const dir = appDir(app.id);
  for (const rel of ['icon.webp', 'icon.png', 'icon.jpg', ...(raw.screenshots || []).map(s => 'shots/' + (typeof s === 'string' ? s : s.file))])
    if (fs.existsSync(path.join(dir, rel))) await fPut(`apps/${app.id}/${rel}`, fs.readFileSync(path.join(dir, rel)), `Move ${app.name}: ${rel}`);
  await fPut(`apps/${app.id}.json`, Buffer.from(JSON.stringify(raw, null, 2) + '\n'), `Move ${app.name} here (family & friends only)`);
  writeJson(app._file, stubOf(raw));
  fs.rmSync(path.join(dir, 'shots'), { recursive: true, force: true });
  fs.rmSync(path.join(dir, 'share.png'), { force: true });
  _data = null; loadData();
  git('add', '-A', '--', app._file, path.join('content', 'apps', app.id));
  git('commit', '--quiet', '-m', `${app.name} is now family & friends only`);
  pushWithRetry();
  say(c.ok(`\n${app.name} moved. Invited people find it on ${SITE().baseUrl}/family/`));
  if (flags['delete-public']) {
    for (const r of raw.releases || []) {
      const pub = await gh('GET', `/releases/tags/${encodeURIComponent(releaseTag(app, r.version))}`);
      if (pub) { await gh('DELETE', `/releases/${pub.id}`); say(c.dim(`  deleted public release ${pub.tag_name}`)); }
    }
  } else say(c.dim(`The public GitHub releases of ${app.name} still exist (nothing links to them). Remove them later with: zgs move ${app.id} family --delete-public`));
}

/** Adds 1 to selfDownloads for each URL (one commit), so these downloads aren't counted as people. */
async function addSelfDownloads(urls, message) {
  git('pull', '--ff-only', '--quiet'); _data = null;
  const changed = new Set();
  for (const app of DATA().apps) {
    const raw = readJson(app._file); let hit = false;
    for (const r of raw.releases || []) for (const f of r.files) for (const u of urls) if (f.url === u) { f.selfDownloads = (f.selfDownloads || 0) + 1; hit = true; }
    if (hit) { writeJson(app._file, raw); changed.add(app._file); }
  }
  if (!changed.size) return;
  git('add', ...changed); git('commit', '--quiet', '-m', message); pushWithRetry();
  say(c.dim(`Recorded ${urls.length} of your own download(s) so the public count leaves them out.`));
}

/** zgs mine <app> [platform]: "that download was me", for the newest version's main file. */
async function mine() {
  const app = appById(pos[0] || stop('Usage: zgs mine <app> [android|windows]'));
  const plats = pos[1] ? [pos[1]] : Object.keys(app.platforms);
  const urls = [];
  for (const p of plats) {
    const r = latestFor(app, p) || stop(`${app.name} has no ${p} version.`);
    const f = r.files.find(x => KINDS[x.kind] === p && x.kind !== 'portable') || r.files.find(x => KINDS[x.kind] === p);
    if (plats.length > 1 && !(await confirm(`Did you download ${f.name} yourself?`))) continue;
    urls.push(f.url);
  }
  if (urls.length) await addSelfDownloads(urls, `Leave ${app.name} downloads by the developer out of the count`);
}

/** Stops a publish when the app's policy isn't ready (Studio Standards workflow). */
function policyGuard(app, listing = null) {
  if (app.visibility === 'private') stop(`${app.name} is private. Its files would still be public on GitHub. Set "visibility" to "unlisted" or "public" first.`);
  if (!fs.existsSync(path.join(ROOT, 'content', 'apps', app.id, 'privacy.html')) && !listing?.files['privacy.html'])
    stop(`${app.name} has no privacy policy section yet. Put privacy.html in its "${LISTING}" folder (see Studio Standards), or ask the hub chat: "add ${app.name} to the hub".`);
  const sheet = CONFIG.standardsDir && path.join(CONFIG.standardsDir, `${app.name}.md`);
  if (!sheet || !fs.existsSync(sheet)) { say(c.dim(`(No Studio Standards sheet found for ${app.name}; skipping the pending-changes check.)`)); return; }
  const pending = pendingPolicyChanges(fs.readFileSync(sheet, 'utf8'));
  if (pending.length) stop(`${app.name} has pending policy changes in Studio Standards:\n  - ${pending.join('\n  - ')}\nAsk the hub chat to "update ${app.name}'s policy", then publish.`);
}

/** No command: list apps, what's live and what's waiting, then publish the one you pick. */
async function menu() {
  const rows = [];
  for (const app0 of DATA().apps) {
    if (!CONFIG.apps[app0.id] || app0.visibility === 'private') continue;
    const app = app0.visibility === 'family' ? await familyApp(app0) : app0;
    const live = (app.releases || []).find(r => r.status === 'live')?.version || '-';
    let state, ready = false;
    try {
      const b = findBuild(app, path.join(CONFIG.finishedApps, CONFIG.apps[app.id]));
      if ((app.releases || []).some(r => r.version === b.version)) state = c.dim('up to date');
      else if (live === '-' || cmpVersion(b.version, live) > 0) { state = c.ok(`${b.version} ready to publish`); ready = true; }
      else state = c.dim(`folder has ${b.version} (older)`);
    } catch (e) { if (!(e instanceof Stop)) throw e; state = c.bad(e.message.split('\n')[0]); }
    rows.push({ app, live, state, ready });
  }
  const fresh = newListings();
  say(c.b('\nZenith Gen Orbit: publish\n'));
  rows.forEach((r, i) => say(`  ${String(i + 1).padStart(2)}. ${r.app.name.padEnd(18)} live ${r.live.padEnd(9)} ${r.state}`));
  fresh.forEach((n, i) => say(`  ${String(rows.length + i + 1).padStart(2)}. ${n.id.padEnd(18)} ${c.ok('new app, not on Zenith yet')}  ${c.dim(path.relative(CONFIG.finishedApps, n.folder))}`));
  say(c.dim('\n  s = status and download counts, m = a download was me, v = check all links, q = quit'));
  const pick = (await ask('\nChoose: ')).toLowerCase();
  if (pick === 's') return status();
  if (pick === 'v') return verify();
  if (pick === 'm') { pos[0] = await ask('Which app id (e.g. bambowl)? '); return mine(); }
  const n = Number(pick) - 1;
  if (fresh[n - rows.length]) return publish(fresh[n - rows.length]);
  const row = rows[n];
  if (!row) return say('Nothing chosen.');
  pos[0] = row.app.id;
  return publish();
}

const COMMANDS = { publish: () => publish(), pull, status, verify, mine, move };
try {
  if (!cmd) await menu();
  else if (!COMMANDS[cmd]) { say(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 10).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exitCode = 1; }
  else await COMMANDS[cmd]();
} catch (e) {
  if (e instanceof Stop) { console.error(c.bad('\n✗ ' + e.message)); process.exitCode = 1; }
  else throw e;
}
