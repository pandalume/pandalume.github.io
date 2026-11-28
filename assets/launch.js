// Launch screen, once per session: runs before the page is drawn (tiny, cached) so it never flashes.
// The screen itself is CSS (site.css, .zg-launch): it shows only when Zenith was opened from its home-screen
// icon, never blocks taps, and is gone within a second. Later pages in the same session skip it.
try { if (sessionStorage.getItem('zg-launched')) document.documentElement.classList.add('zg-launched'); else sessionStorage.setItem('zg-launched', '1'); } catch { /* private window: show it */ }
