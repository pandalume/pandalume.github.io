// Zenith's sign-in page (/signin/), used by Zenith itself and by the apps. It sends the person to Google and
// takes Google's answer back on pandalume.github.io, then hands the ID token to whoever asked:
//
//   /signin/?return=<where to go back>&nonce=<SHA-256 hex of the app's own random secret>
//
// "return" may be a page on this site, a loopback address on the person's own device (http://127.0.0.1:<port>/…
// or http://localhost:…, for Windows apps) or an app's own link scheme (com.example.app://…). Nothing else, so a
// token can never be sent to another website. The token is useless without the app's secret: Supabase (or the
// app's server) checks the secret against the nonce inside the token. Nothing is stored or sent anywhere else.
(() => {
  const root = document.getElementById('signin');
  if (!root) return;
  const CLIENT = root.dataset.client, SELF = location.origin + '/signin/';
  const say = (html, back) => { root.innerHTML = `<div class="card family-signin">${html}${back ? `<p><a class="btn btn-iri" href="${back.replace(/"/g, '&quot;')}">Go back to the app</a></p>` : ''}</div>`; };
  const allowed = r => {
    try {
      const u = new URL(r, location.origin);
      if (u.origin === location.origin) return u.href;
      if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return u.href;
      if (!/^(https?|javascript|data|file|blob|about|intent):$/.test(u.protocol) && /^[a-z][a-z0-9+.-]*:$/.test(u.protocol)) return u.href;
    } catch { /* not a URL */ }
    return null;
  };
  const b64 = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64 = s => atob(s.replace(/-/g, '+').replace(/_/g, '/'));

  // 2. Back from Google: pass the answer on.
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('id_token') || h.get('error')) {
    let back = null; try { back = allowed(JSON.parse(unb64(h.get('state') || '')).r); } catch { /* bad state */ }
    history.replaceState(null, '', SELF);
    if (!back) return say('<p>This sign-in link isn\'t valid. Go back to the app and try again.</p>');
    const to = back.split('#')[0] + '#' + (h.get('id_token') ? 'id_token=' + encodeURIComponent(h.get('id_token')) : 'error=' + encodeURIComponent(h.get('error')));
    const external = !to.startsWith(location.origin);
    if (external) say('<h2>Signed in</h2><p>Returning to the app…</p><p class="small muted">If nothing happens, tap the button.</p>', to);
    location.replace(to);
    return;
  }

  // 1. Asked to sign in: off to Google.
  const q = new URLSearchParams(location.search);
  const back = allowed(q.get('return') || ''), nonce = q.get('nonce') || '';
  if (!back || !/^[0-9a-f]{64}$/.test(nonce)) return say('<p>This sign-in link isn\'t valid. Go back to the app and try again.</p>');
  const p = new URLSearchParams({ client_id: CLIENT, redirect_uri: SELF, response_type: 'id_token', scope: 'openid email profile', nonce, state: b64(JSON.stringify({ r: back })), prompt: 'select_account' });
  say('<p>Opening Google sign-in…</p>');
  location.replace('https://accounts.google.com/o/oauth2/v2/auth?' + p);
})();
