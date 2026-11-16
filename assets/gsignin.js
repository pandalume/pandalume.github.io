// Google sign-in for Zenith's own pages (Family, Owner) through Zenith's sign-in page (/signin/), so Google
// only ever sees pandalume.github.io, never the Supabase address (that is what lets Google show the studio's
// name and logo). Flow: a random secret (the "nonce") is kept in this tab; Google gets only its SHA-256, and
// Supabase checks that the two match before it turns Google's ID token into a Zenith session.
window.zgGoogle = (() => {
  const KEY = 'zg-google-nonce';
  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  async function start(returnUrl) {
    const raw = hex(crypto.getRandomValues(new Uint8Array(32)));
    try { sessionStorage.setItem(KEY, raw); } catch { /* private window: sign-in can't finish here */ }
    const hashed = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)));
    location.href = `/signin/?return=${encodeURIComponent(returnUrl)}&nonce=${hashed}`;
  }
  // Back from /signin/ with "#id_token=…" (or "#error=…"): returns {session} or {error}, or null if nothing to do.
  async function finish(supabaseUrl, publishableKey) {
    const h = new URLSearchParams(location.hash.slice(1));
    if (!h.get('id_token') && !h.get('error')) return null;
    history.replaceState(null, '', location.pathname + location.search);
    if (h.get('error')) return { error: h.get('error') === 'access_denied' ? 'Sign-in was cancelled.' : `Google said: ${h.get('error')}` };
    let raw = null; try { raw = sessionStorage.getItem(KEY); sessionStorage.removeItem(KEY); } catch { /* ignore */ }
    if (!raw) return { error: 'Sign-in started in another tab or window. Please sign in again here.' };
    try {
      const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=id_token`, {
        method: 'POST', headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'google', id_token: h.get('id_token'), nonce: raw }),
      });
      const t = await res.json();
      if (!res.ok || !t.access_token) return { error: t.msg || t.error_description || t.error || `Sign-in failed (${res.status}).` };
      return { session: { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() / 1000 + (t.expires_in || 3600) } };
    } catch { return { error: 'Couldn\'t reach the server. Check your connection and try again.' }; }
  }
  return { start, finish };
})();
