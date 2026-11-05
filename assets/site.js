// Small conveniences. Everything works without this script; it only adds comfort.
const $ = (s, el = document) => el.querySelector(s), $$ = (s, el = document) => [...el.querySelectorAll(s)];
const ua = navigator.userAgent, MINE = /Android/i.test(ua) ? 'android' : /Windows/i.test(ua) ? 'windows' : '';

function toast(msg) {
  const t = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg, role: 'status' });
  document.body.append(t); setTimeout(() => t.remove(), 1800);
}

// Family & friends and Zenith Owner are "homes": once you're in one, Zenith's Apps link, logo and Home take you
// back there instead of to public Zenith, and other pages (an app's page, What's new, Install help) show a way back.
// Remembered in this browser (signed-in family members, the owner) and per tab (where this visit started).
const HOMES = { '/family/': 'Family & friends', '/owner/': 'Zenith Owner' };
window.zgHome = {
  get() { try { const h = sessionStorage.getItem('zg-home') || localStorage.getItem('zg-home') || ''; return HOMES[h] ? h : ''; } catch { return ''; } },
  // the owner app always wins in its own tab; the Family page doesn't take over a tab the owner app opened
  set(path) {
    try {
      if (path === '/owner/' || !sessionStorage.getItem('zg-home')) sessionStorage.setItem('zg-home', path);
      if (path === '/owner/' || localStorage.getItem('zg-home') !== '/owner/') localStorage.setItem('zg-home', path);
    } catch { /* private window */ }
    homeLinks();
  },
  clear() { try { sessionStorage.removeItem('zg-home'); localStorage.removeItem('zg-home'); } catch { /* ignore */ } },
};
function homeLinks() {
  const home = window.zgHome.get();
  if (!home) return;
  const brand = $('.top .brand'), apps = $('.top nav a[href="/#apps"]'), foot = $('.foot a[href="/"]');
  if (brand) brand.href = home;
  if (apps) apps.href = home;
  if (foot) { foot.href = home; foot.textContent = HOMES[home]; }
  if (location.pathname !== home && !$('.home-back')) {
    const a = Object.assign(document.createElement('a'), { className: 'home-back', href: home, textContent: '← ' + HOMES[home] });
    $('#main')?.prepend(a);
  }
}

// Android APK downloads never open a github.com address. On a phone with the GitHub app installed, Android hands
// github.com links to that app, which only shows "Sign in". And inside the installed Zenith app, github.com opens a
// small browser sheet where Chrome never asks "File might be harmful… Download anyway?", so the APK hangs at 100%.
// So Zenith's server looks up the file's final download address (GitHub doesn't let pages read it), and the page
// goes straight there: Chrome downloads in place and asks properly. Only if that fails twice is the normal link used.
const FAMILY_FN = 'https://oeffkydfujcasphguxjr.supabase.co/functions/v1/family';
const RELEASE_FILE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//;
window.zgOpenDownload = async url => {
  if (MINE === 'android' && RELEASE_FILE.test(url)) {
    for (let i = 0; i < 2; i++) {
      try {
        const r = await fetch(`${FAMILY_FN}?action=link&url=${encodeURIComponent(url)}`);
        const j = await r.json();
        if (j.url) { location.href = j.url; return; }
      } catch { /* try again, then fall back to the normal link */ }
    }
  }
  location.href = url;
};

document.addEventListener('click', async e => {
  const apk = e.target.closest('a[data-kind="apk"], a[href$=".apk"]');
  if (apk && MINE === 'android' && RELEASE_FILE.test(apk.href)) { e.preventDefault(); toast('Starting download…'); window.zgOpenDownload(apk.href); return; }
  const copy = e.target.closest('.copy');
  if (copy) {
    try { await navigator.clipboard.writeText(copy.dataset.copy); toast(copy.dataset.done || 'Copied'); } catch { toast('Copy failed'); }
    return;
  }
  const share = e.target.closest('.share-btn');
  if (share) {
    const d = { title: share.dataset.shareTitle, text: share.dataset.shareText, url: share.dataset.shareUrl };
    if (navigator.share) { try { await navigator.share(d); } catch { /* cancelled */ } }
    else { try { await navigator.clipboard.writeText(d.url); toast('Link copied'); } catch { prompt('Copy this link', d.url); } }
    return;
  }
  const f = e.target.closest('.chip-btn[data-filter]');
  if (f) {
    $$('.chip-btn[data-filter]').forEach(b => b.classList.toggle('on', b === f));
    $$('.app-card[data-platforms]').forEach(c => { c.hidden = !!f.dataset.filter && !c.dataset.platforms.split(' ').includes(f.dataset.filter); });
  }
});

// Your own platform first, and the phone download bar when the download panel is off screen.
document.addEventListener('DOMContentLoaded', () => {
  homeLinks();
  const card = MINE && $(`.dl[data-platform="${MINE}"]`);
  if (card) { card.classList.add('mine'); card.parentElement.prepend(card); }
  const bar = $(`.getbar[data-platform="${MINE || 'android'}"]`) || $('.getbar');
  const panels = $('.dls');
  if (bar && panels && 'IntersectionObserver' in window) {
    bar.hidden = false; document.body.style.paddingBottom = '72px';
    new IntersectionObserver(([en]) => bar.classList.toggle('show', !en.isIntersecting && en.boundingClientRect.top < 0)).observe(panels);
  }
  initGallery();
});

// Tap a screenshot to see it large; arrows, swipe and Esc work.
function initGallery() {
  const g = $('[data-gallery]'); if (!g) return;
  const imgs = $$('img', g).map(i => i.src);
  let i = 0, box = null, x0 = null;
  const show = n => { i = (n + imgs.length) % imgs.length; $('img', box).src = imgs[i]; };
  const close = () => { box?.remove(); box = null; document.removeEventListener('keydown', key); };
  const key = e => { if (e.key === 'Escape') close(); if (e.key === 'ArrowRight') show(i + 1); if (e.key === 'ArrowLeft') show(i - 1); };
  $$('.shot', g).forEach((b, n) => b.addEventListener('click', () => {
    box = document.createElement('div'); box.className = 'lightbox'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Screenshot');
    box.innerHTML = '<img alt=""><button class="lb-close" aria-label="Close">×</button>' + (imgs.length > 1 ? '<button class="lb-prev" aria-label="Previous">‹</button><button class="lb-next" aria-label="Next">›</button>' : '');
    box.addEventListener('click', e => { if (e.target === box || e.target.matches('.lb-close')) close(); if (e.target.matches('.lb-next')) show(i + 1); if (e.target.matches('.lb-prev')) show(i - 1); });
    box.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
    box.addEventListener('touchend', e => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 40) show(i + (dx < 0 ? 1 : -1)); x0 = null; });
    document.body.append(box); document.addEventListener('keydown', key); show(n); $('.lb-close', box).focus();
  }));
}
