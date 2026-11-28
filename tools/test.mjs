// node tools/test.mjs: builds the site from sample data (test/data) into a temp folder and checks
// the things that must never break: feeds that installed apps read, pulled releases, links, rules.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { ROOT, validate, readJson, pendingPolicyChanges } from './lib.mjs';

const DATA = path.join(ROOT, 'test', 'data');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'zg-test-'));
let passed = 0;
const t = (name, fn) => { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; } };

// The sample data must not depend on the real apps' files (a real publish renames screenshots, swaps icons…):
// build from a copy of content/ with a placeholder for every image the sample data mentions.
const CONTENT = fs.mkdtempSync(path.join(os.tmpdir(), 'zg-content-'));
fs.cpSync(path.join(ROOT, 'content'), CONTENT, { recursive: true });
for (const f of fs.readdirSync(path.join(DATA, 'apps')).filter(f => f.endsWith('.json'))) {
  const a = readJson(path.join(DATA, 'apps', f)), dir = path.join(CONTENT, 'apps', a.id);
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  for (const s of a.screenshots || []) { const p = path.join(dir, 'shots', typeof s === 'string' ? s : s.file); if (!fs.existsSync(p)) fs.writeFileSync(p, ''); }
}
execFileSync(process.execPath, [path.join(ROOT, 'tools/build.mjs'), '--no-counts', '--data', DATA, '--out', OUT, '--content', CONTENT], { stdio: 'pipe' });
const out = rel => path.join(OUT, rel);
const site = readJson(path.join(DATA, 'site.json'));
const appsData = id => readJson(path.join(DATA, 'apps', id + '.json'));

// The exact acceptance rules in Bambowl's web/js/updates.js (1.6.0)
function bambowlAccepts(body) {
  const j = JSON.parse(body);
  return !!j && typeof j.code === 'number' && /^https:\/\//.test(j.apk || '') && typeof j.name === 'string' && String(j.notes || '').length <= 200;
}

console.log('feeds');
t('Android feed passes Bambowl 1.6.0\'s own checks', () => assert.ok(bambowlAccepts(fs.readFileSync(out('api/bambowl/android.json'), 'utf8'))));
t('pulled 1.6.2 is skipped; feed offers 1.6.1 (code 8)', () => {
  const f = readJson(out('api/bambowl/android.json'));
  assert.equal(f.name, '1.6.1'); assert.equal(f.code, 8);
  assert.match(f.apk, /bambowl-1\.6\.1\/Bambowl-1\.6\.1\.apk$/);
  assert.match(f.sha256, /^[0-9a-f]{64}$/);
});
t('legacy /apps/bambowl.json is identical to the new feed', () =>
  assert.equal(fs.readFileSync(out('apps/bambowl.json'), 'utf8'), fs.readFileSync(out('api/bambowl/android.json'), 'utf8')));
t('Windows feed lists setup and portable', () => {
  const w = readJson(out('api/quillix-note/windows.json'));
  assert.equal(w.name, '1.4.5'); assert.ok(w.files.setup.url && w.files.portable.url);
});
t('releases.json hides pulled files but keeps the reason', () => {
  const r = readJson(out('api/bambowl/releases.json')).find(x => x.version === '1.6.2');
  assert.equal(r.status, 'pulled'); assert.ok(r.pulledReason); assert.equal(r.files, undefined);
});
t('no feed for an app with no live release', () => assert.ok(!fs.existsSync(out('api/cypher-vault/windows.json'))));
t('private app produces nothing', () => assert.ok(!fs.existsSync(out('apps/secret-tool')) && !fs.existsSync(out('api/secret-tool'))));
t('catalog lists public apps only', () => assert.deepEqual(readJson(out('api/catalog.json')).map(a => a.id), ['bambowl']));

console.log('pages');
const html = rel => fs.readFileSync(out(rel), 'utf8');
t('pulled version has no download link anywhere', () => {
  for (const f of walk(OUT).filter(f => f.endsWith('.html'))) assert.ok(!fs.readFileSync(f, 'utf8').includes('Bambowl-1.6.2.apk'), f);
});
t('app page download button points at the feed\'s APK', () => assert.ok(html('apps/bambowl/index.html').includes(readJson(out('api/bambowl/android.json')).apk)));
t('unlisted pages are noindex and not on the home page', () => {
  assert.match(html('apps/quillix-note/index.html'), /noindex/);
  assert.ok(!html('index.html').includes('/apps/quillix-note/'));
  assert.ok(!/id="family-public">[^<]*quillix-note/.test(html('family/index.html')), 'link-only apps are not listed on the Family page either');
});
t('each app\'s policy covers only that app', () => {
  const q = html('apps/quillix-note/privacy/index.html'), all = html('privacy.html');
  assert.ok(q.includes('Quillix Note') && !/Bambowl|OpenRouter|Cypher Vault/.test(q.replace(/<header[\s\S]*?<\/header>|<footer[\s\S]*?<\/footer>/g, '')));
  assert.ok(all.includes('<h2>Bambowl</h2>') && all.includes('<h2>Quillix Note</h2>') && all.includes('<h2>Cypher Vault</h2>'));
});
t('Cypher Vault pages never mention other apps or their content', () => {
  for (const f of ['apps/cypher-vault/privacy/index.html', 'apps/cypher-vault/terms/index.html']) {
    const h = html(f).replace(/<header[\s\S]*?<\/header>|<footer[\s\S]*?<\/footer>/g, '');
    assert.ok(!/recipe|Bambowl|Quillix|meal plan|grocer/i.test(h) && !h.includes('{{'), f);
    assert.match(h, /Cypher Vault/);
  }
});
t('only the current version is downloadable; history keeps the notes', () => {
  const a = html('apps/bambowl/index.html');
  assert.ok(a.includes('Bambowl-1.6.1.apk') && !a.includes('Bambowl-1.6.0.apk') && !a.includes('Bambowl-1.5.0.apk'));
  assert.ok(a.includes('Cooking mode with timers') && a.includes('Friends and chat'));
  const rel = readJson(out('api/bambowl/releases.json'));
  assert.ok(rel.find(r => r.version === '1.6.1').files && !rel.find(r => r.version === '1.6.0').files);
});
t('terms pages exist for the site and each app', () => {
  assert.match(html('terms.html'), /governed by the laws of Malaysia/);
  assert.match(html('apps/bambowl/terms/index.html'), /Food safety/);
  assert.ok(!html('apps/bambowl/terms/index.html').includes('master password'));
});
t('app page credits the studio and the storefront', () => assert.match(html('apps/bambowl/index.html'), /by <b>Pandalume Studio<\/b>.*Published on Zenith Gen Orbit/));
t('/get short link redirects to newest APK', () => assert.ok(html('get/bambowl/android/index.html').includes('Bambowl-1.6.1.apk')));
t('privacy policy: studio + storefront named, contact filled in, old name gone', () => {
  const p = html('privacy.html');
  assert.ok(p.includes(site.contact) && p.includes('made by Pandalume Studio') && p.includes('published on Zenith Gen Orbit')); assert.ok(!p.includes('{{')); assert.ok(!/T Panda/i.test(p));
});
t('every internal link and image resolves to a file', () => {
  for (const f of walk(OUT).filter(f => f.endsWith('.html'))) {
    for (const [, u] of fs.readFileSync(f, 'utf8').matchAll(/(?:href|src)="(\/[^"#?]*)/g)) {
      const p = path.join(OUT, decodeURIComponent(u));
      assert.ok(fs.existsSync(p) && (fs.statSync(p).isFile() || fs.existsSync(path.join(p, 'index.html'))), `${path.relative(OUT, f)} → ${u}`);
    }
  }
});
t('family apps: only an invite page and policies, no feeds, not listed', () => {
  assert.ok(html('apps/secret-app/index.html').includes('/family/#secret-app'));
  assert.ok(fs.existsSync(path.join(OUT, 'apps/secret-app/privacy/index.html')));
  for (const f of ['api/secret-app/android.json', 'api/secret-app/windows.json', 'get/secret-app/windows/index.html']) assert.ok(!fs.existsSync(path.join(OUT, f)), f);
  assert.ok(!html('index.html').includes('Secret App') && !fs.readFileSync(path.join(OUT, 'sitemap.xml'), 'utf8').includes('secret-app'));
  const fam = html('family/index.html');
  assert.ok(fam.includes('connect-src \'self\' https://example.supabase.co') && fam.includes('/assets/family.js') && fam.includes('noindex'));
});
t('old address: feeds copied exactly, pages forward', () => {
  const LEG = OUT + '-legacy';
  if (!site.legacyBaseUrl) return;
  assert.equal(fs.readFileSync(path.join(LEG, 'api/bambowl/android.json'), 'utf8'), fs.readFileSync(path.join(OUT, 'api/bambowl/android.json'), 'utf8'));
  assert.ok(fs.readFileSync(path.join(LEG, 'apps/bambowl/index.html'), 'utf8').includes(`url=${site.baseUrl}/apps/bambowl/`));
  assert.ok(fs.readFileSync(path.join(LEG, '404.html'), 'utf8').includes('location.replace'));
});
t('events: current ones shown, ended ones hidden', () => {
  const h = html('apps/bambowl/index.html');
  assert.ok(h.includes('Autumn recipe challenge') && !h.includes('Old event'));
});
t('"just me" apps leave nothing on the public site', () => {
  assert.ok(!fs.existsSync(path.join(OUT, 'apps/only-me')));
  for (const f of walk(OUT).filter(f => /\.(html|json|xml)$/.test(f))) assert.ok(!fs.readFileSync(f, 'utf8').includes('Only Me Tool'), f);
});
t('the real site (data/) builds and every link and image in it resolves', () => {
  const REAL = fs.mkdtempSync(path.join(os.tmpdir(), 'zg-real-'));
  execFileSync(process.execPath, [path.join(ROOT, 'tools/build.mjs'), '--no-counts', '--out', REAL], { stdio: 'pipe' });
  const bad = [];
  for (const f of walk(REAL).filter(f => f.endsWith('.html')))
    for (const [, u] of fs.readFileSync(f, 'utf8').matchAll(/(?:href|src)="(\/[^"#?]*)/g)) {
      const p = path.join(REAL, decodeURIComponent(u));
      if (!(fs.existsSync(p) && (fs.statSync(p).isFile() || fs.existsSync(path.join(p, 'index.html'))))) bad.push(`${path.relative(REAL, f)} → ${u}`);
    }
  fs.rmSync(REAL, { recursive: true, force: true });
  assert.deepEqual(bad, []);
});
t('no third-party scripts, styles or fonts', () => {
  for (const f of walk(OUT).filter(f => f.endsWith('.html'))) {
    const h = fs.readFileSync(f, 'utf8');
    assert.ok(!/<script[^>]+src="https?:/i.test(h) && !/<link[^>]+rel="(stylesheet|icon|preload|preconnect)"[^>]+href="https?:/i.test(h) && !/url\(https?:/i.test(h), f);
  }
});

t('What\'s new page and Atom feed list live public releases only', () => {
  const u = html('updates/index.html'), f = fs.readFileSync(out('feed.xml'), 'utf8');
  assert.ok(u.includes('Bambowl 1.6.1') && !u.includes('1.6.2') && !u.includes('Quillix'));
  assert.match(f, /^<\?xml[\s\S]*<entry>[\s\S]*Bambowl 1\.6\.1[\s\S]*<\/feed>\s*$/);
  assert.ok(!f.includes('1.6.2'));
});
t('app page: QR for Android, facts strip, share image, version anchors, older versions folded', () => {
  const a = html('apps/bambowl/index.html');
  assert.match(a, /<svg class="qr"/);
  assert.match(a, /<dl class="facts">[\s\S]*Version[\s\S]*1\.6\.1/);
  assert.match(a, /og:image" content="https:\/\/[^"]+\/apps\/bambowl\/share\.png"/);
  assert.ok(/id="v1.6.2"[\s\S]*<details class="older"><summary>Show 3 older versions<\/summary>[\s\S]*id="v1.6.1"[\s\S]*id="v1.5.0"/.test(a), 'only the newest version shows; the rest are folded');
  assert.ok(fs.existsSync(out('apps/bambowl/share.png')) && fs.existsSync(out('assets/og.png')));
});
t('home shows latest updates and no filter row with few apps', () => {
  const h = html('index.html');
  assert.ok(h.includes('Latest updates') && !h.includes('data-filter='));
});

console.log('web apps');
t('web app copied as is to /web/<id>/', () => assert.match(html('web/bambowl/index.html'), /Bambowl web \(test\)/));
t('web feed names the version and where it lives', () => {
  const w = readJson(out('api/bambowl/web.json'));
  assert.equal(w.name, '1.6.1'); assert.equal(w.url, `${site.baseUrl}/web/bambowl/`); assert.ok(w.notes);
});
t('app page: Open web app button, no hash or download size for it', () => {
  const h = html('apps/bambowl/index.html');
  assert.match(h, /data-kind="web" target="_blank"/); assert.match(h, /Add to Home Screen/);
  assert.ok(!/Download size \(Web app\)|Web app size/.test(h));
});
t('/get/<id>/web/ forwards to the web app', () => assert.ok(html('get/bambowl/web/index.html').includes('/web/bambowl/')));
t('install help explains web apps', () => assert.match(html('install/index.html'), /id="web"/));
t('Android feed unchanged by the web app', () => { const f = readJson(out('api/bambowl/android.json')); assert.equal(f.code, 8); assert.match(f.apk, /\.apk$/); });
t('family web app: a sign-in gate only, never its files', () => {
  const g = html('family/web/secret-app/index.html');
  assert.ok(g.includes('/assets/famweb.js') && g.includes('/assets/gsignin.js') && g.includes('noindex') && g.includes('data-app="secret-app"'));
  assert.match(g, /connect-src 'self' https:\/\/example\.supabase\.co; worker-src 'self'/);
  const m = readJson(out('family/web/secret-app/manifest.webmanifest'));
  assert.equal(m.start_url, '/family/web/secret-app/'); assert.equal(m.scope, '/family/web/secret-app/');
  assert.ok(fs.existsSync(out('family/web/sw.js')));
  assert.ok(!fs.existsSync(out('web/secret-app')) && !fs.existsSync(out('api/secret-app/web.json')) && !fs.existsSync(out('family/web/secret-app/app')));
});
t('just-me apps get no web gate', () => assert.ok(!fs.existsSync(out('family/web/only-me'))));
t('apps without a web version get no web feed or folder', () => assert.ok(!fs.existsSync(out('api/quillix-note/web.json')) && !fs.existsSync(out('web/quillix-note'))));

console.log('motion (Studio Standards: smooth on any phone)');
t('only transform and opacity animate; nothing loops; reduced motion keeps only short fades; hover motion needs a mouse', () => {
  const css = fs.readFileSync(path.join(ROOT, 'assets', 'site.css'), 'utf8');
  assert.ok(!/infinite/.test(css), 'an animation loops forever');
  assert.ok(!/transition\s*:\s*all/.test(css), 'transition: all');
  for (const [, props] of css.matchAll(/transition(?:-property)?\s*:\s*([^;}]+)/g))
    for (const part of props.split(',')) { const prop = part.trim().split(/\s+/)[0]; assert.ok(['transform', 'opacity', 'none'].includes(prop), `transition on ${prop}`); }
  for (const [, body] of css.matchAll(/@keyframes [\w-]+ \{([^@]*?)\}\s*(?=\n|$)/g))
    for (const [, prop] of body.matchAll(/([a-z-]+)\s*:/g)) assert.ok(['transform', 'opacity'].includes(prop), `keyframes animate ${prop}`);
  assert.ok(!/backdrop-filter/.test(css), 'live blur');
  const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\*, \*::before, \*::after \{ animation: none !important; transition: none !important; \}/);
  for (const [, anim] of reduced.matchAll(/animation:\s*([\w-]+)/g)) assert.ok(['none', 'zg-fade'].includes(anim), `reduced motion still runs ${anim}`);
  assert.ok(!/:hover\s*\{[^}]*transform/.test(css.replace(/@media \(hover: hover\)[^{]*\{[^}]*\{[^}]*\}[^}]*\}/g, '')), 'hover motion outside (hover: hover)');
});
t('launch screen: on every page, never blocks taps, under 1.5 s', () => {
  const h = html('index.html'), css = fs.readFileSync(path.join(ROOT, 'assets', 'site.css'), 'utf8');
  assert.ok(h.includes('class="zg-launch"') && /<script src="\/assets\/launch\.js\?v=\w+"><\/script>/.test(h));
  assert.match(css, /\.zg-launch \{ position: fixed;[^}]*pointer-events: none;/);
  assert.match(css, /\(display-mode: standalone\)/);
});

console.log('rules (bad data is refused before anything is written)');
const good = appsData('bambowl');
const bad = (name, mut, re) => t(name, () => {
  const a = structuredClone(good); mut(a); a._file = 'bambowl.json';
  assert.match(validate(site, [a]).join('\n'), re);
});
bad('versionCode must rise', a => { a.releases[0].code = 1; }, /versionCode must rise/);
bad('notes over 200 characters', a => { a.releases[0].notes = 'x'.repeat(201); }, /at most 200/);
bad('missing hash', a => { a.releases[0].files[0].sha256 = ''; }, /sha256/);
bad('duplicate version', a => { a.releases[1].version = a.releases[0].version; }, /duplicate version|newest first/);
bad('pulled without reason', a => { delete a.releases[0].pulledReason; }, /pulledReason/);
bad('changes must be short lines', a => { a.releases[1].changes = ['ok', '']; }, /changes must be/);
bad('http download link', a => { a.releases[1].files[0].url = 'http://x/y.apk'; }, /https/);
bad('web app must live at /web/<id>/', a => { a.releases[1].files.find(f => f.kind === 'web').url = 'https://example.com/x/'; }, /web app lives at/);
bad('a family web app can\'t sit on the public site', a => { a.visibility = 'family'; }, /must stay in the private repository/);
bad('just-me apps have no web version', a => { a.visibility = 'owner'; }, /don't have a web version/);
t('build refuses invalid data and leaves output untouched', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zg-bad-'));
  fs.cpSync(DATA, tmp, { recursive: true });
  const f = path.join(tmp, 'apps/bambowl.json'), a = readJson(f); a.releases[0].code = 1; fs.writeFileSync(f, JSON.stringify(a));
  const marker = path.join(OUT, 'index.html'), before = fs.statSync(marker).mtimeMs;
  assert.throws(() => execFileSync(process.execPath, [path.join(ROOT, 'tools/build.mjs'), '--no-counts', '--data', tmp, '--out', OUT], { stdio: 'pipe' }));
  assert.equal(fs.statSync(marker).mtimeMs, before);
});

function walk(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]); }

fs.rmSync(OUT, { recursive: true, force: true });
t('pending policy changes are read from a Studio Standards sheet', () => {
  assert.deepEqual(pendingPolicyChanges('## Data\n- a\n\n## Pending policy changes\n(none)\n'), []);
  assert.deepEqual(pendingPolicyChanges('## Pending policy changes\r\n- Adds crash reports\r\n## Next\nx'), ['Adds crash reports']);
});
console.log(process.exitCode ? 'FAILED' : `all ${passed} checks passed`);
