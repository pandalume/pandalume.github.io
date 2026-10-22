#!/usr/bin/env node
// zgs: Zenith Gen Orbit publisher. Runs on your PC from the hub repo folder.
//
//   node tools/zgs.mjs                    menu: shows every app and which have a new build ready
//   node tools/zgs.mjs publish <app> [--dry-run] [--notes "…"] [--changes "a | b"] [--platform android|windows] [--yes]
//   node tools/zgs.mjs publish <app> --backfill --from "<folder>" --date YYYY-MM-DD --notes "…"
//   node tools/zgs.mjs pull <app> <version> --reason "…" [--delete-files] [--yes]
//   node tools/zgs.mjs status [app]
//   node tools/zgs.mjs verify [--deep]
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
import { ROOT, KINDS, NOTES_MAX, loadData, readJson, writeJson, validate, cmpVersion, latestFor, releaseTag, androidFeed, windowsFeed, pendingPolicyChanges } from './lib.mjs';

const CONFIG = readJson(path.join(ROOT, 'tools', 'zgs.config.json'));
const [cmd, ...rest] = process.argv.slice(2);
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
async function gh(method, url, body, extra = {}) {
  const full = url.startsWith('http') ? url : `https://api.github.com/repos/${SITE().repo}${url}`;
  const res = await fetch(full, {
    method, body, duplex: body ? 'half' : undefined,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token()}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'zgs', ...extra }
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
    const req = https.request(url, { method: 'POST', headers: { Authorization: `Bearer ${token()}`, Accept: 'application/vnd.github+json', 'User-Agent': 'zgs', 'Content-Type': 'application/octet-stream', 'Content-Length': size } }, res => {
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
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'zgs' } });
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
  return { package: m[1], code: Number(m[2]), version: m[3], certs: [...new Set(certs)] };
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

  let code = null;
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
      f.version = info.version; code = info.code;
    } else if (head.subarray(0, 2).toString() !== 'MZ') stop(`${f.name} is not a Windows program.`);
  }
  const versions = [...new Set(picked.map(f => f.version))];
  if (versions.length > 1) stop(`The files have different versions (${picked.map(f => `${f.name}=${f.version}`).join(', ')}). Publish one platform at a time with --platform.`);
  return { version: versions[0], code, files: picked };
}

// ---------- commands ----------
async function publish() {
  const app = appById(pos[0] || stop('Which app? e.g. zgs publish bambowl'));
  const folder = flags.from || path.join(CONFIG.finishedApps, CONFIG.apps[app.id] || stop(`Add "${app.id}" to tools/zgs.config.json (its folder under Finished Apps).`));
  const backfill = !!flags.backfill;
  if (backfill && !flags.from) stop('--backfill needs --from "<folder with the old build>".');
  policyGuard(app);

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
  if (!notes) notes = await ask(`One line of what's new (max ${NOTES_MAX} chars): `);
  if (!notes) stop('Notes are required. Phones show them in the update bar.');
  if (notes.length > NOTES_MAX) stop(`Notes are ${notes.length} characters; the limit is ${NOTES_MAX}.`);
  let changes = typeof flags.changes === 'string' ? flags.changes.split('|').map(x => x.trim()).filter(Boolean) : [];
  if (!changes.length && typeof flags.notes !== 'string' && !flags.yes) {
    say(c.dim('More details for the version history (optional). One per line; press Enter on an empty line to finish.'));
    for (let line; (line = await ask('  • ')) && changes.length < 20;) changes.push(line);
  }
  const date = backfill ? (flags.date || stop('--backfill needs --date YYYY-MM-DD')) : today();

  const release = { version: build.version, ...(build.code != null && { code: build.code }), date, status: 'live', notes, ...(changes.length && { changes }), files: [] };
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
  if (flags['dry-run']) { say(c.ok('\nDry run: all checks passed. Nothing was uploaded.')); return; }
  if (!(await confirm('\nPublish this?'))) stop('Cancelled. Nothing changed.');

  // git must be clean and current, so the push can't clash
  if (git('status', '--porcelain', '--', 'data')) stop('data/ has uncommitted changes. Commit or undo them first.');
  git('pull', '--ff-only', '--quiet');
  _data = null; const fresh = appById(app.id);                        // re-read after pull
  if ((fresh.releases || []).some(r => r.version === build.version)) stop(`${build.version} was published meanwhile.`);

  // 1. release + uploads (re-running after a failure resumes here safely)
  const tag = releaseTag(app, build.version);
  let rel = await gh('GET', `/releases/tags/${encodeURIComponent(tag)}`);
  if (!rel) rel = await gh('POST', '/releases', JSON.stringify({ tag_name: tag, target_commitish: git('rev-parse', 'HEAD'), name: `${app.name} ${build.version}`, body: notes, make_latest: 'false' }), { 'Content-Type': 'application/json' });
  for (const f of build.files) {
    let asset = rel.assets.find(a => a.name === f.upload);
    if (asset && asset.state !== 'uploaded') {                        // a broken earlier upload: clear it and retry
      say(c.dim(`  removing an unfinished earlier upload of ${f.upload}`));
      await gh('DELETE', `/releases/assets/${asset.id}`); asset = null;
    }
    if (asset && asset.size !== f.size) stop(`Release ${tag} already has a different ${f.upload}. Delete that file on GitHub and run again.`);
    if (!asset) {
      say(`  uploading ${f.upload} (${mb(f.size)})…`);
      asset = await uploadAsset(rel.upload_url, f.full, f.upload);
    }
    f.url = asset.browser_download_url;
  }
  // 2. prove the public copies are byte-for-byte the files on this PC
  for (const f of build.files) {
    process.stdout.write(`  verifying ${f.upload}… `);
    const got = await downloadSha(f.url);
    if (got.sha256 !== f.sha256 || got.size !== f.size) stop(`MISMATCH for ${f.upload}: the public file differs from yours. Nothing was announced. Delete the file from release ${tag} on GitHub and run again.`);
    say(c.ok('ok'));
  }
  // 3. announce: one commit updates page, buttons and feeds together
  release.files = build.files.map(f => ({ kind: f.kind, name: f.upload, url: f.url, size: f.size, sha256: f.sha256 }));
  const raw = readJson(fresh._file);
  raw.releases = [...(raw.releases || []), release].sort((a, b) => cmpVersion(b.version, a.version));
  writeJson(fresh._file, raw);
  try { _data = null; loadData(); } catch (e) { git('checkout', '--', fresh._file); stop(e.message); }
  git('add', fresh._file);
  git('commit', '--quiet', '-m', `${backfill ? 'Add' : 'Publish'} ${app.name} ${build.version}`);
  pushWithRetry();
  say(c.ok(`\nPushed. The site rebuilds in about a minute.`));
  if (!backfill) await waitLive(app, { ...build, notes });
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
  for (const app of apps) {
    say(`\n${c.b(app.name)} ${c.dim(`[${app.visibility}]`)}`);
    for (const p of Object.keys(app.platforms)) {
      const want = latestFor(app, p)?.version || '-';
      let live = '-';
      try { const res = await fetch(`${site.baseUrl}/api/${app.id}/${p}.json?t=${Date.now()}`); if (res.ok) live = (await res.json()).name; } catch { live = '?'; }
      say(`  ${p.padEnd(8)} data ${want.padEnd(8)} live ${live === want ? c.ok(live) : c.bad(live)}`);
    }
    for (const r of (app.releases || []).slice(0, 5)) {
      const n = r.files.reduce((t, f) => t + (counts[f.url] || 0), 0);
      say(`  ${r.version.padEnd(10)} ${r.date}  ${r.status === 'pulled' ? c.bad('pulled') : 'live  '}  ${n} downloads`);
    }
  }
}

async function verify() {
  let bad = 0;
  for (const app of DATA().apps) for (const r of app.releases || []) {
    if (r.status !== 'live') continue;
    for (const f of r.files) {
      process.stdout.write(`${app.id} ${r.version} ${f.name}… `);
      if (flags.deep) {
        const got = await downloadSha(f.url);
        if (got.sha256 === f.sha256) say(c.ok('hash ok')); else { bad++; say(c.bad('HASH MISMATCH')); }
      } else {
        const res = await fetch(f.url, { method: 'HEAD', redirect: 'follow' });
        const len = Number(res.headers.get('content-length'));
        if (res.ok && len === f.size) say(c.ok('ok')); else { bad++; say(c.bad(`${res.status}, size ${len} (expected ${f.size})`)); }
      }
    }
  }
  say(bad ? c.bad(`\n${bad} problem(s).`) : c.ok('\nAll live files are reachable' + (flags.deep ? ' and match their hashes.' : '.')));
  if (bad) process.exitCode = 1;
}

/** Stops a publish when the app's policy isn't ready (Studio Standards workflow). */
function policyGuard(app) {
  if (app.visibility === 'private') stop(`${app.name} is private. Its files would still be public on GitHub. Set "visibility" to "unlisted" or "public" first.`);
  if (!fs.existsSync(path.join(ROOT, 'content', 'apps', app.id, 'privacy.html')))
    stop(`${app.name} has no privacy policy section yet. Ask the hub chat: "add ${app.name} to the hub".`);
  const sheet = CONFIG.standardsDir && path.join(CONFIG.standardsDir, `${app.name}.md`);
  if (!sheet || !fs.existsSync(sheet)) { say(c.dim(`(No Studio Standards sheet found for ${app.name}; skipping the pending-changes check.)`)); return; }
  const pending = pendingPolicyChanges(fs.readFileSync(sheet, 'utf8'));
  if (pending.length) stop(`${app.name} has pending policy changes in Studio Standards:\n  - ${pending.join('\n  - ')}\nAsk the hub chat to "update ${app.name}'s policy", then publish.`);
}

/** No command: list apps, what's live and what's waiting, then publish the one you pick. */
async function menu() {
  const rows = [];
  for (const app of DATA().apps) {
    if (!CONFIG.apps[app.id] || app.visibility === 'private') continue;
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
  say(c.b('\nZenith Gen Orbit: publish\n'));
  rows.forEach((r, i) => say(`  ${String(i + 1).padStart(2)}. ${r.app.name.padEnd(18)} live ${r.live.padEnd(9)} ${r.state}`));
  say(c.dim('\n  s = status and download counts, v = check all links, q = quit'));
  const pick = (await ask('\nChoose: ')).toLowerCase();
  if (pick === 's') return status();
  if (pick === 'v') return verify();
  const row = rows[Number(pick) - 1];
  if (!row) return say('Nothing chosen.');
  pos[0] = row.app.id;
  return publish();
}

const COMMANDS = { publish, pull, status, verify };
try {
  if (!cmd) await menu();
  else if (!COMMANDS[cmd]) { say(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 10).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exitCode = 1; }
  else await COMMANDS[cmd]();
} catch (e) {
  if (e instanceof Stop) { console.error(c.bad('\n✗ ' + e.message)); process.exitCode = 1; }
  else throw e;
}
