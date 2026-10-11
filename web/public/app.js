/* Shared navigation and colour choice for the landing page and demo. */
(function () {
  'use strict';
  var docs = {
    how: 'how-it-works', 'how-title': 'how-it-works',
    dials: 'dials', 'dials-title': 'dials', modes: 'dials',
    commands: 'commands', 'commands-title': 'commands',
    dashboard: 'dashboard', 'dash-title': 'dashboard', memory: 'memory',
    docs: '', 'docs-title': '', legend: 'how-it-works', 'legend-title': 'how-it-works',
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
  var stars = document.querySelector('[data-stars]');
  if (stars) {
    fetch('https://api.github.com/repos/ProjectAJ14/eklavya')
      .then(function (reply) { return reply.ok ? reply.json() : null; })
      .then(function (repo) {
        if (!repo || typeof repo.stargazers_count !== 'number') return;
        var count = repo.stargazers_count;
        stars.textContent = count >= 1000 ? (count / 1000).toFixed(1).replace('.0', '') + 'k' : String(count);
        stars.hidden = false;
      }).catch(function () {});
  }
})();
