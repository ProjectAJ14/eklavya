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
  var heroScene = document.querySelector('[data-hero-shot]');
  if (heroScene) {
    var heroInView = !('IntersectionObserver' in window);
    var heroWindowActive = document.hasFocus();
    function syncHeroScene() {
      var box = heroScene.getBoundingClientRect();
      var visible = heroInView && box.bottom > 0 && box.top < window.innerHeight;
      heroScene.dataset.heroPlaying = String(visible && heroWindowActive && !document.hidden && !motion.matches);
    }
    if ('IntersectionObserver' in window) {
      var heroObserver = new IntersectionObserver(function (entries) {
        heroInView = entries[0].isIntersecting;
        syncHeroScene();
      });
      heroObserver.observe(heroScene);
    } else {
      window.addEventListener('scroll', syncHeroScene, { passive: true });
      window.addEventListener('resize', syncHeroScene);
    }
    document.addEventListener('visibilitychange', syncHeroScene);
    window.addEventListener('blur', function () { heroWindowActive = false; syncHeroScene(); });
    window.addEventListener('focus', function () { heroWindowActive = true; syncHeroScene(); });
    window.addEventListener('pagehide', function () { heroWindowActive = false; syncHeroScene(); });
    window.addEventListener('pageshow', function () { heroWindowActive = document.hasFocus(); syncHeroScene(); });
    motion.addEventListener('change', syncHeroScene);
    syncHeroScene();
  }
  if (shot && 'IntersectionObserver' in window) {
    var scene = shot.querySelector('.shot');
    var shotInView = false;
    function syncShot() {
      shot.classList.toggle('is-firing', shotInView && !motion.matches);
    }
    var shotObserver = new IntersectionObserver(function (entries) {
      // Keep observing: leaving view resets the CSS animation for the next visit.
      shotInView = entries[0].isIntersecting && entries[0].intersectionRatio >= .2;
      syncShot();
    }, { threshold: .2 });
    shotObserver.observe(scene);
    motion.addEventListener('change', syncShot);
    window.addEventListener('pagehide', function () {
      shotInView = false;
      syncShot();
    });
    window.addEventListener('pageshow', function (event) {
      // A Back/Forward cache restore does not rerun this script or necessarily
      // deliver a new intersection entry. Reobserve the restored scene.
      if (!event.persisted) return;
      shotObserver.unobserve(scene);
      shotObserver.observe(scene);
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
