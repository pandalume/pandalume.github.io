// Copy buttons for file fingerprints, and putting the visitor's own platform first.
document.addEventListener('click', e => {
  const b = e.target.closest('.copy');
  if (!b) return;
  navigator.clipboard?.writeText(b.dataset.copy).then(() => { b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1500); });
});
document.addEventListener('DOMContentLoaded', () => {
  const ua = navigator.userAgent, mine = /Android/i.test(ua) ? 'android' : /Windows/i.test(ua) ? 'windows' : '';
  const card = mine && document.querySelector(`.dl[data-platform="${mine}"]`);
  if (card) { card.classList.add('mine'); card.parentElement.prepend(card); }
});
