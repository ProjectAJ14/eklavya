/* Eklavya landing page behaviour: copy button + scroll reveals.
   No dependencies, no build step — this file is served as-is. */
(function () {
  'use strict';

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- copy the install commands ---------- */
  var INSTALL = [
    '/plugin marketplace add ProjectAJ14/eklavya',
    '/plugin install eklavya@eklavya',
    '/eklavya:setup'
  ].join('\n');

  var copyBtn = document.querySelector('[data-copy]');
  if (copyBtn) {
    var label = copyBtn.querySelector('[data-copy-label]');
    var resetTimer;
    copyBtn.addEventListener('click', function () {
      var done = function (text) {
        if (!label) return;
        label.textContent = text;
        clearTimeout(resetTimer);
        resetTimer = setTimeout(function () { label.textContent = 'Copy'; }, 1600);
      };
      // navigator.clipboard is absent on http:// origins and older browsers;
      // fall back to a throwaway textarea so the button is never a dead end.
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(INSTALL)
          .then(function () { done('Copied'); })
          .catch(function () { done(legacyCopy(INSTALL) ? 'Copied' : 'Press ⌘C'); });
      } else {
        done(legacyCopy(INSTALL) ? 'Copied' : 'Press ⌘C');
      }
    });
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  /* ---------- scroll reveals ---------- */
  var reveals = [].slice.call(document.querySelectorAll('[data-reveal]'));
  var grows = [].slice.call(document.querySelectorAll('[data-grow]'));
  var shoots = [].slice.call(document.querySelectorAll('[data-shoot]'));

  function show(el) {
    if (el.dataset.delay) el.style.transitionDelay = el.dataset.delay + 'ms';
    el.classList.add('is-visible');
  }
  function grow(el) { el.style.width = el.dataset.w; }
  /* Restart the whole group from frame zero. A CSS animation only replays when
     its animation-name changes, so drop it inline, force a reflow, then hand it
     back to the stylesheet. Descendants carry their own animations, hence the
     `*` — same set the paused rule in styles.css covers. */
  function fire(el) {
    var parts = [].slice.call(el.querySelectorAll('[data-anim], [data-anim] *'));
    el.classList.remove('is-firing');
    parts.forEach(function (p) { p.style.animation = 'none'; });
    void el.offsetWidth;
    parts.forEach(function (p) { p.style.animation = ''; });
    el.classList.add('is-firing');
  }

  if (reduced || !('IntersectionObserver' in window)) {
    reveals.forEach(show);
    grows.forEach(grow);
    shoots.forEach(fire);
    return;
  }

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      var el = entry.target;
      // [data-shoot] keeps its observer: the loop pauses when the section
      // leaves and replays from the beginning the next time it is on screen.
      if (el.hasAttribute('data-shoot')) {
        if (entry.isIntersecting) fire(el);
        else el.classList.remove('is-firing');
        return;
      }
      if (!entry.isIntersecting) return;
      if (el.hasAttribute('data-grow')) grow(el);
      else show(el);
      io.unobserve(el);
    });
  }, { threshold: 0.15 });

  reveals.concat(grows, shoots).forEach(function (el) { io.observe(el); });
}());
