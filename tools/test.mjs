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

execFileSync(process.execPath, [path.join(ROOT, 'tools/build.mjs'), '--no-counts', '--data', DATA, '--out', OUT], { stdio: 'pipe' });
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
  assert.ok(a.includes('id="v1.6.1"') && /<details class="older"><summary>Show 1 older version<\/summary>[\s\S]*id="v1.5.0"/.test(a));
  assert.ok(fs.existsSync(out('apps/bambowl/share.png')) && fs.existsSync(out('assets/og.png')));
});
t('home shows latest updates and no filter row with few apps', () => {
  const h = html('index.html');
  assert.ok(h.includes('Latest updates') && !h.includes('data-filter='));
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
