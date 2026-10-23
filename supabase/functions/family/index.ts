// Zenith Gen Orbit: Family area.
// Deployed to the TinyAi-Personal Supabase project as the "family" edge function. This file is the
// source of truth; redeploy it from here after changes.
//
// Invited people sign in with Google (Supabase Auth). This function checks they are on the invite
// list (table family_members, or an owner email), then serves the family apps' details, images and
// short-lived download links from the private GitHub repository FAMILY_REPO. Nothing is logged.
//
// GET  ?action=catalog                          apps this person may see (no download URLs)
// GET  ?action=file&app=<id>&path=icon          the icon, or shots/<file> for a screenshot (bytes)
// GET  ?action=download&app=<id>&name=<file>    { url } : a GitHub link valid for a few minutes
//                                               (&go=1 answers with a redirect instead)
// GET  ?action=feed&app=<id>&platform=android   the same update feed as public apps, with fresh links
// GET  ?action=members                          owners only: the invite list
// POST ?action=members  {email,name,apps}       owners only: invite or change someone
// DELETE ?action=members&email=<email>          owners only: remove someone
//
// Secrets: FAMILY_GITHUB_TOKEN (fine-grained, read-only Contents on FAMILY_REPO only).
// Optional: FAMILY_REPO (default pandalume/pandalume-family), OWNER_EMAILS (comma-separated).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const REPO = Deno.env.get('FAMILY_REPO') ?? 'pandalume/pandalume-family';
const OWNERS = (Deno.env.get('OWNER_EMAILS') ?? 'tinyaiprojects@gmail.com,dekloongjohn@gmail.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const KINDS: Record<string, string> = { apk: 'android', setup: 'windows', portable: 'windows' };

async function gh(path: string, accept = 'application/vnd.github+json', redirect: RequestRedirect = 'follow') {
  const token = Deno.env.get('FAMILY_GITHUB_TOKEN');
  if (!token) throw new Error('FAMILY_GITHUB_TOKEN is not set');
  return fetch(`https://api.github.com/repos/${REPO}${path}`, {
    redirect,
    headers: { Authorization: `Bearer ${token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'zenith-family' },
  });
}

// App data from the private repo (apps/<id>.json), cached for a minute per warm instance.
let cache: { at: number; apps: any[] } | null = null;
async function allApps(): Promise<any[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.apps;
  const res = await gh('/contents/apps');
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const list = (await res.json()) as { name: string; type: string }[];
  const apps = await Promise.all(list.filter(f => f.type === 'file' && f.name.endsWith('.json')).map(async f => {
    const r = await gh(`/contents/apps/${encodeURIComponent(f.name)}`, 'application/vnd.github.raw');
    return r.ok ? r.json() : null;
  }));
  cache = { at: Date.now(), apps: apps.filter(Boolean).sort((a, b) => (a.order ?? 99) - (b.order ?? 99)) };
  return cache.apps;
}

const latestFor = (app: any, platform: string) =>
  (app.releases ?? []).find((r: any) => r.status === 'live' && r.files.some((f: any) => KINDS[f.kind] === platform)) ?? null;

// What the page needs: everything except internal file ids. Only current versions keep their files.
function publicView(app: any) {
  const current = new Set(Object.keys(app.platforms ?? {}).map(p => latestFor(app, p)).filter(Boolean));
  return {
    ...app,
    releases: (app.releases ?? []).map((r: any) => ({
      version: r.version, date: r.date, status: r.status, notes: r.notes, changes: r.changes, pulledReason: r.pulledReason,
      files: current.has(r) ? r.files.map((f: any) => ({ kind: f.kind, name: f.name, size: f.size, sha256: f.sha256 })) : [],
    })),
  };
}

async function signedUrl(assetId: number) {
  const res = await gh(`/releases/assets/${assetId}`, 'application/octet-stream', 'manual');
  const url = res.headers.get('location');
  if (!url) throw new Error(`GitHub ${res.status} for asset ${assetId}`);
  return url;
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const q = new URL(req.url).searchParams, action = q.get('action') ?? 'catalog';
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: { user } } = await db.auth.getUser(jwt);
    if (!user?.email) return json({ error: 'Sign in first.' }, 401);
    const email = user.email.toLowerCase(), owner = OWNERS.includes(email);
    let member: { apps: string[] } | null = owner ? { apps: ['*'] } : null;
    if (!member) {
      const { data } = await db.from('family_members').select('apps').eq('email', email).maybeSingle();
      member = data;
    }

    if (action === 'members') {
      if (!owner) return json({ error: 'Only the owner can manage invites.' }, 403);
      if (req.method === 'GET') {
        const { data, error } = await db.from('family_members').select('*').order('added_at');
        if (error) throw error;
        return json({ members: data, apps: (await allApps()).map(a => ({ id: a.id, name: a.name })) });
      }
      if (req.method === 'POST') {
        const b = await req.json();
        const e = String(b.email ?? '').trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return json({ error: 'That email address doesn\'t look right.' }, 400);
        const apps = Array.isArray(b.apps) && b.apps.length ? b.apps.map(String) : ['*'];
        const { error } = await db.from('family_members').upsert({ email: e, name: String(b.name ?? '').slice(0, 80) || null, apps });
        if (error) throw error;
        return json({ ok: true });
      }
      if (req.method === 'DELETE') {
        const { error } = await db.from('family_members').delete().eq('email', (q.get('email') ?? '').toLowerCase());
        if (error) throw error;
        return json({ ok: true });
      }
    }

    if (!member) return json({ member: false, email }, action === 'catalog' ? 200 : 403);
    const may = (id: string) => member!.apps.includes('*') || member!.apps.includes(id);
    const apps = (await allApps()).filter(a => may(a.id) && a.visibility === 'family');

    if (action === 'catalog') return json({ member: true, owner, email, apps: apps.map(publicView) });

    const app = apps.find(a => a.id === q.get('app'));
    if (!app) return json({ error: 'No such app for you.' }, 404);

    if (action === 'file') {
      let p = q.get('path') ?? '';
      if (!/^(icon|shots\/[\w.-]+\.(png|webp|jpe?g))$/i.test(p)) return json({ error: 'Bad path.' }, 400);
      let r: Response | null = null;
      for (const cand of p === 'icon' ? ['icon.webp', 'icon.png', 'icon.jpg'] : [p]) {
        r = await gh(`/contents/apps/${app.id}/${cand}`, 'application/vnd.github.raw');
        if (r.ok) { p = cand; break; }
      }
      if (!r?.ok) return json({ error: 'Not found.' }, 404);
      const type = /\.png$/i.test(p) ? 'image/png' : /\.webp$/i.test(p) ? 'image/webp' : 'image/jpeg';
      return new Response(r.body, { headers: { ...CORS, 'Content-Type': type, 'Cache-Control': 'private, max-age=3600' } });
    }

    if (action === 'download') {
      const name = q.get('name');
      const r = Object.keys(app.platforms).map(p => latestFor(app, p)).filter(Boolean)
        .find((r: any) => r.files.some((f: any) => f.name === name));
      const f = r?.files.find((f: any) => f.name === name);
      if (!f) return json({ error: 'Only the current version can be downloaded.' }, 404);
      const url = await signedUrl(f.assetId);
      return q.get('go') ? Response.redirect(url, 302) : json({ url, name: f.name, size: f.size, sha256: f.sha256 });
    }

    if (action === 'feed') {
      const platform = q.get('platform') ?? '';
      const r = latestFor(app, platform);
      if (!r) return json({ error: `No ${platform} version.` }, 404);
      const page = 'https://pandalume.github.io/family/#' + app.id;
      if (platform === 'android') {
        const f = r.files.find((f: any) => f.kind === 'apk');
        return json({ name: r.version, code: r.code, apk: await signedUrl(f.assetId), notes: r.notes, sha256: f.sha256, size: f.size, published: r.date, page });
      }
      const files: Record<string, unknown> = {};
      for (const f of r.files) if (KINDS[f.kind] === 'windows') files[f.kind] = { url: await signedUrl(f.assetId), size: f.size, sha256: f.sha256 };
      return json({ name: r.version, notes: r.notes, published: r.date, page, files });
    }
    return json({ error: 'Unknown action.' }, 400);
  } catch (e) {
    return json({ error: 'Something went wrong. Try again in a minute.', detail: String((e as Error).message ?? e) }, 500);
  }
});
