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

  /* ---------- the hero terminal, run by the visitor ----------
     Four states: idle (prompt waiting), running (lines land one by one),
     asking (the picker takes keys and clicks), answered (graded, then the
     task finishes and the prompt comes back as "Run it again"). */
  (function () {
    var term = document.querySelector('[data-term]');
    if (!term) return;

    var form = term.querySelector('[data-term-form]');
    var input = term.querySelector('[data-term-input]');
    var go = term.querySelector('[data-term-go]');
    var typed = term.querySelector('[data-typed]');
    var typeCursor = term.querySelector('[data-type-cursor]');
    var opts = [].slice.call(term.querySelectorAll('.ask__opt'));
    var optWrap = term.querySelector('[data-opts]');
    var lines = {};
    [].slice.call(term.querySelectorAll('[data-line]')).forEach(function (el) {
      lines[el.getAttribute('data-line')] = el;
    });

    var TASK = input.getAttribute('placeholder');
    /* Grades and intervals are the real ones: PASSING_GRADE is 3, multiple
       choice caps at 4, a pass at the second rep schedules 6 days out and
       anything under 3 restarts the ladder at 1 day (mcp/src/srs.ts). */
    var VERDICTS = {
      '1': {
        right: true,
        grade: '✓ grade 4 · recognition caps at 4 · review in 6 days',
        why: 'httpOnly keeps the cookie out of document.cookie, so an injected script can reach the in-memory access token but never the refresh token that mints new ones.'
      },
      '2': {
        grade: '✗ grade 1 · under the passing grade of 3 · review tomorrow',
        why: 'That is CSRF. The browser still attaches the cookie to a forged cross-site request — SameSite is what stops it. httpOnly only hides the value from scripts.'
      },
      '3': {
        grade: '✗ grade 1 · under the passing grade of 3 · review tomorrow',
        why: 'httpOnly is read by the browser, not the server. The cookie arrives on every request either way, so whatever your server logs, it still logs.'
      },
      '4': {
        grade: '✗ grade 1 · under the passing grade of 3 · review tomorrow',
        why: 'Revocation is a server-side decision about the token store. A cookie flag has no say in it — and an access token held in memory is the one you cannot revoke.'
      },
      '5': {
        blank: true,
        grade: '· grade 0 · recorded as "I don\'t know" · review tomorrow',
        why: 'No penalty for saying so. httpOnly hides the refresh cookie from document.cookie, so an XSS payload can steal the access token in memory but not the refresh token — which is why the two live in different places.'
      }
    };

    var finished = false;
    var timers = [];
    function at(ms, fn) { timers.push(setTimeout(fn, reduced ? 0 : ms)); }
    function stop() { timers.forEach(clearTimeout); timers = []; }

    /* The body is the scroller, so every new line pins itself to the bottom
       the way a real terminal does. */
    function toBottom() { term.scrollTop = term.scrollHeight; }
    function show(el) {
      el.hidden = false;
      if (reduced) { el.classList.add('is-on'); toBottom(); return; }
      requestAnimationFrame(function () { el.classList.add('is-on'); toBottom(); });
    }
    function hide(el) { el.hidden = true; el.classList.remove('is-on'); }

    /* Types the task out a character at a time, then calls back. */
    function type(text, done) {
      typed.textContent = '';
      typeCursor.hidden = false;
      if (reduced) { typed.textContent = text; typeCursor.hidden = true; done(); return; }
      var i = 0;
      (function step() {
        typed.textContent = text.slice(0, ++i);
        toBottom();
        if (i < text.length) at(26, step);
        else at(320, function () { typeCursor.hidden = true; done(); });
      }());
    }

    function reset() {
      stop();
      Object.keys(lines).forEach(function (k) { hide(lines[k]); });
      lines.grade.textContent = '';
      lines.grade.className = 'tl tl-grade';
      lines.why.textContent = '';
      opts.forEach(function (o) {
        o.classList.remove('is-right', 'is-wrong', 'is-blank');
        o.querySelector('.ask__mark').textContent = '❯';
        o.setAttribute('aria-disabled', 'true');
      });
      optWrap.classList.remove('is-live');
      form.hidden = false;
      form.classList.remove('is-busy');
      form.classList.add('is-armed');
      input.value = '';
      input.disabled = false;
      go.textContent = 'Press Enter';
      finished = false;
      term.scrollTop = 0;
    }

    function run(task) {
      form.classList.remove('is-armed');
      form.classList.add('is-busy');
      input.disabled = true;
      show(lines.user);
      var own = task !== TASK;
      type(task, function () {
        form.hidden = true;
        if (own) at(200, function () { show(lines.replay); });
        at(420, function () { show(lines.write); });
        at(1150, function () { show(lines.logged); });
        at(1900, function () { show(lines.checkpoint); });
        at(2450, function () {
          show(lines.ask);
          optWrap.classList.add('is-live');
          opts.forEach(function (o) { o.removeAttribute('aria-disabled'); });
          at(260, function () { opts[0].focus({ preventScroll: true }); toBottom(); });
        });
      });
    }

    function answer(el) {
      if (!optWrap.classList.contains('is-live')) return;
      var v = VERDICTS[el.getAttribute('data-opt')];
      optWrap.classList.remove('is-live');
      opts.forEach(function (o) { o.setAttribute('aria-disabled', 'true'); });

      // The correct row is always revealed, whichever one was picked.
      opts[0].classList.add('is-right');
      opts[0].querySelector('.ask__mark').textContent = '✓';
      if (!v.right) {
        el.classList.add(v.blank ? 'is-blank' : 'is-wrong');
        el.querySelector('.ask__mark').textContent = v.blank ? '·' : '✗';
      }

      at(400, function () {
        lines.grade.textContent = v.grade;
        if (!v.right) lines.grade.classList.add(v.blank ? 'is-blank' : 'is-miss');
        show(lines.grade);
      });
      at(900, function () { lines.why.textContent = v.why; show(lines.why); });
      at(1700, function () { show(lines.done); });
      at(2300, function () {
        form.hidden = false;
        form.classList.remove('is-busy');
        form.classList.add('is-armed');
        input.disabled = false;
        go.textContent = 'Run it again';
        finished = true;
        toBottom();
      });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (finished) { reset(); input.focus({ preventScroll: true }); return; }
      run(input.value.trim() || TASK);
    });

    /* Clicking the empty terminal puts you on the prompt, as it would in a shell. */
    term.addEventListener('mousedown', function (e) {
      if (form.hidden || e.target.closest('button, input')) return;
      e.preventDefault();
      input.focus({ preventScroll: true });
    });

    optWrap.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('.ask__opt') : null;
      if (el) answer(el);
    });

    /* Arrows walk the list the way the real picker does; the digits pick
       directly, which is the other thing Claude Code accepts. */
    optWrap.addEventListener('keydown', function (e) {
      if (!optWrap.classList.contains('is-live')) return;
      var i = opts.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        var next = (i + (e.key === 'ArrowDown' ? 1 : opts.length - 1) + opts.length) % opts.length;
        opts[next].focus({ preventScroll: true });
      } else if (/^[1-5]$/.test(e.key)) {
        e.preventDefault();
        answer(opts[Number(e.key) - 1]);
      }
    });

    term.setAttribute('data-ready', '');
    reset();
  }());

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
