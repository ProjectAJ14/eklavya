/* Eklavya docs page behaviour: table-of-contents highlighting, the mobile
   TOC disclosure, and a copy button on every code block.
   No dependencies, no build step — this file is served as-is. */
(function () {
  'use strict';

  /* ---------- copy buttons on code blocks ---------- */
  [].slice.call(document.querySelectorAll('.doc pre')).forEach(function (pre) {
    var code = pre.querySelector('code');
    if (!code) return;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pre-copy';
    btn.textContent = 'Copy';
    btn.setAttribute('aria-label', 'Copy code to clipboard');

    var timer;
    btn.addEventListener('click', function () {
      var done = function (ok) {
        btn.textContent = ok ? 'Copied' : 'Press ⌘C';
        clearTimeout(timer);
        timer = setTimeout(function () { btn.textContent = 'Copy'; }, 1600);
      };
      var text = code.textContent;
      // navigator.clipboard is absent on http:// origins and older browsers;
      // fall back to a throwaway textarea so the button is never a dead end.
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
          .then(function () { done(true); })
          .catch(function () { done(legacyCopy(text)); });
      } else {
        done(legacyCopy(text));
      }
    });

    pre.appendChild(btn);
  });

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

  /* ---------- mobile TOC disclosure ---------- */
  var toggle = document.querySelector('[data-toc-toggle]');
  var panel = document.getElementById('toc');
  if (toggle && panel) {
    toggle.addEventListener('click', function () {
      var open = panel.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    // Tapping a link on a phone should reveal the section, not leave the
    // whole index sitting on top of it.
    panel.addEventListener('click', function (e) {
      if (e.target.closest('a')) {
        panel.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* ---------- highlight the section being read ---------- */
  var links = [].slice.call(document.querySelectorAll('.doc-nav a[href^="#"]'));
  if (!links.length) return;

  var targets = links.map(function (link) {
    return document.getElementById(link.getAttribute('href').slice(1));
  });

  var current = null;
  function sync() {
    // The section whose top has most recently passed under the sticky nav.
    // Reading positions on every frame would be wasteful; rAF-throttled below.
    var index = 0;
    for (var i = 0; i < targets.length; i++) {
      // getBoundingClientRect rather than offsetTop: the sections sit inside a
      // grid, and offsetTop is measured from whichever ancestor happens to be
      // positioned.
      if (targets[i] && targets[i].getBoundingClientRect().top <= 140) index = i;
    }
    // At the very bottom the last section may be too short to ever cross the
    // line, so claim it explicitly.
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 2) {
      index = links.length - 1;
    }
    if (index === current) return;
    if (current !== null) links[current].classList.remove('is-active');
    links[index].classList.add('is-active');
    current = index;
  }

  var queued = false;
  function onScroll() {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(function () { queued = false; sync(); });
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  sync();
}());
