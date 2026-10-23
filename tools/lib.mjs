// Shared by build.mjs (site generator) and zgs.mjs (publisher): reading data/, validating it,
// and deciding what each app's "latest" is. One copy of the rules, so the site, the feeds and
// the publisher can never disagree.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLATFORMS = { android: 'Android', windows: 'Windows' };
export const KINDS = { apk: 'android', setup: 'windows', portable: 'windows' };
export const NOTES_MAX = 200;                       // Bambowl shows at most 200 characters

export function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
export function writeJson(file, obj) { fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n'); }

export function loadData(dataDir = path.join(ROOT, 'data')) {
  const site = readJson(path.join(dataDir, 'site.json'));
  const dir = path.join(dataDir, 'apps');
  const apps = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()
    .map(f => ({ ...readJson(path.join(dir, f)), _file: path.join(dir, f) }));
  const errors = validate(site, apps);
  if (errors.length) throw new Error('data/ is not valid:\n  - ' + errors.join('\n  - '));
  apps.sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.name.localeCompare(b.name));
  return { site, apps };
}

/** Compares "1.10.0" > "1.9.2". */
export function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

export function validate(site, apps) {
  const e = [], ids = new Set();
  const https = u => typeof u === 'string' && /^https:\/\/\S+$/.test(u);
  if (!https(site.baseUrl)) e.push('site.baseUrl must be an https URL');
  if (!site.name || !site.developer) e.push('site.name (the storefront) and site.developer (the studio) are required');
  if (!site.repo || !/^[\w.-]+\/[\w.-]+$/.test(site.repo)) e.push('site.repo must be "owner/name"');
  for (const a of apps) {
    const w = m => e.push(`${a.id || a._file}: ${m}`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(a.id || '')) { w('id must be lowercase-with-dashes'); continue; }
    if (ids.has(a.id)) w('duplicate id'); ids.add(a.id);
    if (path.basename(a._file) !== a.id + '.json') w('file name must be <id>.json');
    if (!['public', 'unlisted', 'private'].includes(a.visibility)) w('visibility must be public, unlisted or private');
    if (!a.name || !a.tagline) w('name and tagline are required');
    for (const p of Object.keys(a.platforms || {})) if (!PLATFORMS[p]) w(`unknown platform ${p}`);
    if (a.shotStyle && !['clean', 'phone'].includes(a.shotStyle)) w('shotStyle must be clean or phone');
    for (const s of a.screenshots || []) if (!(typeof s === 'string' ? s : s?.file)) w('each screenshot is a file name or { "file": … }');
    const and = a.platforms?.android;
    if (and && !/^[0-9a-f]{64}$/.test(and.certSha256 || '')) w('platforms.android.certSha256 must be the 64-hex signing certificate digest');
    const seen = new Set();
    let prev = null;
    for (const r of a.releases || []) {
      const rv = m => w(`release ${r.version}: ${m}`);
      if (!/^\d+(\.\d+){1,3}$/.test(r.version || '')) rv('version must look like 1.2.3');
      if (seen.has(r.version)) rv('duplicate version'); seen.add(r.version);
      if (!['live', 'pulled'].includes(r.status)) rv('status must be live or pulled');
      if (r.status === 'pulled' && !r.pulledReason) rv('pulled releases need pulledReason');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) rv('date must be YYYY-MM-DD');
      if (!r.notes || r.notes.length > NOTES_MAX) rv(`notes are required, at most ${NOTES_MAX} characters`);
      if (r.changes != null && (!Array.isArray(r.changes) || r.changes.some(c => typeof c !== 'string' || !c.trim() || c.length > 300))) rv('changes must be a list of short lines (max 300 characters each)');
      if (!r.files?.length) rv('needs at least one file');
      for (const f of r.files || []) {
        if (!KINDS[f.kind]) rv(`file ${f.name}: kind must be apk, setup or portable`);
        if (!a.platforms?.[KINDS[f.kind]]) rv(`file ${f.name}: app has no ${KINDS[f.kind]} platform`);
        if (!https(f.url)) rv(`file ${f.name}: url must be https`);
        if (!/^[0-9a-f]{64}$/.test(f.sha256 || '')) rv(`file ${f.name}: sha256 missing`);
        if (!(f.size > 0)) rv(`file ${f.name}: size missing`);
        if (f.selfDownloads != null && !(Number.isInteger(f.selfDownloads) && f.selfDownloads >= 0)) rv(`file ${f.name}: selfDownloads must be a whole number`);
      }
      const apk = r.files?.find(f => f.kind === 'apk');
      if (apk && !Number.isInteger(r.code)) rv('a release with an APK needs its versionCode as "code"');
      // newest first: every older entry must have a lower version and (for Android) a lower code
      if (prev) {
        if (cmpVersion(prev.version, r.version) <= 0) w(`releases must be newest first (${prev.version} before ${r.version})`);
        if (prev.code != null && r.code != null && prev.code <= r.code) w(`versionCode must rise with each version (${prev.version}=${prev.code}, ${r.version}=${r.code})`);
      }
      prev = r;
    }
  }
  return e;
}

/** The newest live release that has a file for this platform. */
export function latestFor(app, platform) {
  return (app.releases || []).find(r => r.status === 'live' && r.files.some(f => KINDS[f.kind] === platform)) || null;
}

export function appUrl(site, app) { return `${site.baseUrl}/apps/${app.id}/`; }

/** Bambowl's format ({name, code, apk, notes}) plus fields older apps ignore. */
export function androidFeed(site, app) {
  const r = latestFor(app, 'android');
  if (!r) return null;
  const f = r.files.find(x => x.kind === 'apk');
  return { name: r.version, code: r.code, apk: f.url, notes: r.notes, sha256: f.sha256, size: f.size, published: r.date, page: appUrl(site, app) };
}

export function windowsFeed(site, app) {
  const r = latestFor(app, 'windows');
  if (!r) return null;
  const files = {};
  for (const f of r.files) if (KINDS[f.kind] === 'windows') files[f.kind] = { url: f.url, size: f.size, sha256: f.sha256 };
  return { name: r.version, notes: r.notes, published: r.date, page: appUrl(site, app), files };
}

export function releaseTag(app, version) { return `${app.id}-${version}`; }
export function assetUrl(site, app, version, name) {
  return `https://github.com/${site.repo}/releases/download/${releaseTag(app, version)}/${encodeURIComponent(name)}`;
}

/** Reads the "## Pending policy changes" section of a Studio Standards sheet. Returns the
 *  pending lines, or [] when the section says "(none)" or is empty. */
export function pendingPolicyChanges(markdown) {
  const m = /^##\s+Pending policy changes\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(markdown);
  if (!m) return [];
  return m[1].split(/\r?\n/).map(l => l.replace(/^[-*]\s*/, '').trim()).filter(l => l && !/^\(none\)$/i.test(l));
}

/** Every live release across apps, newest first (for the What's new page and feed). */
export function timeline(apps) {
  return apps.flatMap(app => (app.releases || []).filter(r => r.status === 'live').map(r => ({ app, r })))
    .sort((a, b) => b.r.date.localeCompare(a.r.date) || cmpVersion(b.r.version, a.r.version));
}
