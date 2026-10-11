/* Shared navigation and colour choice for the landing page and demo. */
(function () {
  'use strict';
  var docs = {
    how: 'how-it-works', 'how-title': 'how-it-works',
    dials: 'dials', 'dials-title': 'dials', modes: 'dials',
    commands: 'commands', 'commands-title': 'commands',
    dashboard: 'dashboard', 'dash-title': 'dashboard', memory: 'memory',
    docs: '', 'docs-title': '',
    'promise-title': 'levels-and-tiers', 'cta-title': 'installing'
  };
  function followOldSection() {
    if (location.pathname !== '/') return;
    var section = location.hash.slice(1);
    if (Object.prototype.hasOwnProperty.call(docs, section)) {
      location.replace('/docs/' + (docs[section] ? docs[section] + '/' : ''));
    }
  }
  followOldSection();
  window.addEventListener('hashchange', followOldSection);
  window.eklavyaGround.apply(window.eklavyaGround.read());
  document.querySelectorAll('[data-ground]').forEach(function (button) {
    button.addEventListener('click', function () { window.eklavyaGround.set(button.dataset.ground); });
  });
  var shot = document.querySelector('[data-shoot]');
  var motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (shot && !motion.matches && 'IntersectionObserver' in window) {
    var shotObserver = new IntersectionObserver(function (entries) {
      if (!entries[0].isIntersecting) return;
      shot.classList.add('is-firing');
      shotObserver.disconnect();
    }, { threshold: .2 });
    shotObserver.observe(shot.querySelector('.shot'));
    motion.addEventListener('change', function () {
      if (motion.matches) shotObserver.disconnect();
    });
  }
  var stars = document.querySelector('[data-stars]');
  if (stars) {
    var cacheKey = 'eklavya-github-stars';
    var cacheAge = 60 * 60 * 1000;
    function validCount(count) {
      return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
    }
    function showCount(count) {
      stars.textContent = count.toLocaleString('en-US');
      stars.closest('a').setAttribute('aria-label', 'Star Eklavya on GitHub, ' + count.toLocaleString('en-US') + ' stars');
    }
    try {
      var cached = JSON.parse(localStorage.getItem(cacheKey));
      var elapsed = cached && Date.now() - cached.checkedAt;
      if (cached && validCount(cached.count) && typeof cached.checkedAt === 'number' && elapsed >= 0 && elapsed < cacheAge) showCount(cached.count);
    } catch (_) {}
    fetch('https://api.github.com/repos/ProjectAJ14/eklavya')
      .then(function (reply) { return reply.ok ? reply.json() : null; })
      .then(function (repo) {
        if (!repo || !validCount(repo.stargazers_count)) return;
        var count = repo.stargazers_count;
        showCount(count);
        try { localStorage.setItem(cacheKey, JSON.stringify({ count: count, checkedAt: Date.now() })); } catch (_) {}
      }).catch(function () {});
  }
})();
