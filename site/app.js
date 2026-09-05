/* Eklavya landing page behaviour: the hero terminal + scroll reveals.
   No dependencies, no build step — this file is served as-is. */
(function () {
  'use strict';

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- the hero terminal ----------
     A Claude Code session the visitor drives. It boots itself — types
     `claude`, prints the welcome box and the SessionStart hook, then types
     the task — and stops there, armed, with the keyboard handed over. From
     that point every state is the visitor's: send the prompt, watch the
     tools run, answer the checkpoint question with the arrows the real
     picker takes, read the grade, see the task finish.

     States: boot · armed · running · asking · answered. */
  (function () {
    var term = document.querySelector('[data-term]');
    if (!term) return;

    var screen = term.querySelector('[data-screen]');
    var logEl = screen.querySelector('[data-log]');
    var lineWrap = screen.querySelector('.term__lines');
    var dock = screen.querySelector('[data-dock]');
    var $ = function (sel) { return screen.querySelector(sel); };

    var lines = {};
    [].slice.call(screen.querySelectorAll('[data-line]')).forEach(function (el) {
      lines[el.getAttribute('data-line')] = el;
    });

    var boot = $('[data-boot]'), bootCur = $('[data-boot-cur]');
    var composer = $('[data-composer]'), echo = $('[data-echo]'), echoCur = $('[data-echo-cur]');
    var input = $('[data-input]'), hint = $('[data-hint]');
    var nudge = $('[data-nudge]'), askNudge = $('[data-nudge-ask]');
    var sentEl = $('[data-sent]');
    var glyphEl = $('[data-think-glyph]'), wordEl = $('[data-think-word]');
    var secEl = $('[data-think-t]'), tokEl = $('[data-think-k]');
    var optWrap = $('[data-opts]'), keysEl = $('[data-keys]');
    var opts = [].slice.call(screen.querySelectorAll('.ask__opt'));
    var gradeEl = $('[data-grade]'), whyEl = $('[data-why]'), doneEl = $('[data-done]');

    var TASK = 'add JWT auth to the Express API';

    /* Grades and intervals are the real ones: PASSING_GRADE is 3, a
       multiple-choice question caps at grade 4, a pass at the second rep
       schedules six days out and anything under 3 restarts the ladder at one
       day (mcp/src/srs.ts). */
    var VERDICTS = {
      '1': {
        right: true,
        grade: '✓ correct · grade 4 · recognition caps at 4 · next review in 6 days',
        why: 'httpOnly keeps the cookie out of document.cookie, so an injected script can reach the in-memory access token but never the refresh token that mints new ones.',
        done: 'task complete — 4 files changed. You can explain the split you just shipped.'
      },
      '2': {
        grade: '✗ grade 1 · under the passing grade of 3 · next review tomorrow',
        why: 'That is CSRF. The browser still attaches the cookie to a forged cross-site request — SameSite is what stops it. httpOnly only hides the value from scripts.',
        done: 'task complete — 4 files changed. httponly-cookies goes back in the deck for tomorrow.'
      },
      '3': {
        grade: '✗ grade 1 · under the passing grade of 3 · next review tomorrow',
        why: 'httpOnly is read by the browser, not the server. The cookie arrives on every request either way, so whatever your server logs, it still logs.',
        done: 'task complete — 4 files changed. httponly-cookies goes back in the deck for tomorrow.'
      },
      '4': {
        grade: '✗ grade 1 · under the passing grade of 3 · next review tomorrow',
        why: 'Revocation is a server-side decision about the token store. A cookie flag has no say in it — and an access token held in memory is the one you cannot revoke.',
        done: 'task complete — 4 files changed. httponly-cookies goes back in the deck for tomorrow.'
      },
      '5': {
        blank: true,
        grade: '· grade 0 · recorded as "I don\'t know" · next review tomorrow',
        why: 'No penalty for saying so. httpOnly hides the refresh cookie from document.cookie, so an XSS payload can steal the access token in memory but not the refresh token — which is why the two live in different places.',
        done: 'task complete — 4 files changed. httponly-cookies queued for tomorrow, no penalty.'
      }
    };

    var state = 'boot';
    /* Each nudge fires once per visit. Someone who has already answered a
       question does not need to be told how a second time. */
    var nudged = { composer: false, ask: false };
    var timers = [], idle = null, spin = null;

    function at(ms, fn) { timers.push(setTimeout(fn, reduced ? 0 : ms)); }
    function stop() { timers.forEach(clearTimeout); timers = []; }

    /* The screen is the scroller, so every new line pins itself to the
       bottom the way a real terminal does. */
    function toBottom() { logEl.scrollTop = logEl.scrollHeight; }
    function show(el) {
      el.hidden = false;
      if (reduced) { el.classList.add('is-on'); toBottom(); return; }
      requestAnimationFrame(function () { el.classList.add('is-on'); toBottom(); });
    }
    function hide(el) { el.hidden = true; el.classList.remove('is-on'); }

    function type(el, text, speed, done) {
      if (reduced) { el.textContent = text; done(); return; }
      var i = 0;
      (function step() {
        el.textContent = text.slice(0, ++i);
        toBottom();
        if (i < text.length) at(speed, step);
        else at(240, done);
      }());
    }

    /* ---------- the thinking line ----------
       Claude Code keeps its spinner pinned below the last thing it printed,
       so this line is moved to the end of the log as output lands. */
    var GLYPHS = ['·', '✢', '✳', '∗', '✻', '✽'];
    var WORDS = ['Forging', 'Wrangling', 'Threading', 'Composing'];
    function think(on) {
      clearInterval(spin); spin = null;
      if (!on) { hide(lines.think); return; }
      show(lines.think);
      if (reduced) return;
      var t0 = Date.now(), f = 0;
      spin = setInterval(function () {
        f++;
        glyphEl.textContent = GLYPHS[f % GLYPHS.length];
        var s = Math.floor((Date.now() - t0) / 1000);
        secEl.textContent = s + 's';
        tokEl.textContent = (1.1 + s * 0.6).toFixed(1) + 'k';
        if (f % 24 === 0) wordEl.textContent = WORDS[Math.floor(f / 24) % WORDS.length];
      }, 110);
    }
    function pin() { lineWrap.appendChild(lines.think); }

    /* ---------- boot ---------- */
    function bootUp() {
      bootCur.hidden = false;
      at(650, function () {
        type(boot, 'claude', 90, function () {
          bootCur.hidden = true;
          at(240, function () { show(lines.welcome); });
          at(700, function () { show(lines.hook1); });
          at(880, function () { show(lines.hook2); });
          at(1240, function () {
            show(dock);
            at(340, function () { type(echo, TASK, 32, arm); });
          });
        });
      });
    }

    /* Clicking mid-boot skips to the armed prompt — nobody should have to
       wait out an animation to use the thing. */
    function skipBoot() {
      stop();
      boot.textContent = 'claude';
      bootCur.hidden = true;
      ['welcome', 'hook1', 'hook2'].forEach(function (k) { show(lines[k]); });
      show(dock);
      echo.textContent = TASK;
      arm();
    }

    function arm(again) {
      state = 'armed';
      dock.classList.remove('is-busy');
      input.disabled = false;
      composer.classList.add('is-armed');
      echoCur.hidden = false;
      input.value = echo.textContent;
      hint.hidden = false;
      hint.innerHTML = again
        ? 'type a task, or press <kbd>⏎</kbd> to run it again'
        : 'press <kbd>⏎</kbd> to send';
      toBottom();
      nudgeAfter('composer', nudge, 4200);
    }

    /* Nothing moves until the visitor acts, so say so — but only after long
       enough that it reads as help rather than impatience. */
    function nudgeAfter(key, el, ms) {
      if (nudged[key] || reduced) return;
      clearTimeout(idle);
      idle = setTimeout(function () { nudged[key] = true; show(el); }, ms);
    }
    function calm() {
      // called on every mousemove over the picker, so bail before touching the DOM
      if (!idle && nudge.hidden && askNudge.hidden) return;
      clearTimeout(idle); idle = null; hide(nudge); hide(askNudge);
    }

    /* ---------- the run ---------- */
    function send() {
      if (state !== 'armed') return;
      calm();
      reset();
      var task = (input.value || '').trim() || TASK;
      state = 'running';
      /* Claude Code does not take its prompt away while it works — it greys
         out and waits, so that is what this does. */
      dock.classList.add('is-busy');
      composer.classList.remove('is-armed');
      hint.hidden = true;
      input.disabled = true;
      input.value = '';
      echo.textContent = '';
      sentEl.textContent = task;
      show(lines.sent);
      /* Only the recorded JWT session exists; say so rather than pretending
         to have implemented whatever was typed. */
      if (task !== TASK) at(180, function () { show(lines.replay); });
      at(340, function () { think(true); });
      ['t1', 't2', 't3', 't4'].forEach(function (k, i) {
        at(1200 + i * 720, function () { show(lines[k]); pin(); });
      });
      at(4300, function () {
        think(false);
        show(lines.ask);
        openPicker();
      });
    }

    /* ---------- the picker ---------- */
    var cur = 0;
    function setCur(i) {
      cur = (i + opts.length) % opts.length;
      opts.forEach(function (o, n) { o.classList.toggle('is-cur', n === cur); });
      opts[cur].focus({ preventScroll: true });
      toBottom();
    }
    function openPicker() {
      state = 'asking';
      optWrap.classList.add('is-live');
      keysEl.hidden = false;
      at(220, function () { setCur(0); });
      nudgeAfter('ask', askNudge, 4500);
    }

    function answer(el) {
      if (state !== 'asking') return;
      state = 'answered';
      var v = VERDICTS[el.getAttribute('data-opt')];
      calm();
      optWrap.classList.remove('is-live');
      keysEl.hidden = true;
      opts.forEach(function (o) { o.classList.remove('is-cur'); o.blur(); });

      // The right row is always revealed, whichever one was picked.
      opts[0].classList.add('is-right');
      opts[0].querySelector('.ask__mark').textContent = '✓';
      if (!v.right) {
        el.classList.add(v.blank ? 'is-blank' : 'is-wrong');
        el.querySelector('.ask__mark').textContent = v.blank ? '·' : '✗';
      }

      at(420, function () {
        gradeEl.textContent = v.grade;
        if (!v.right) gradeEl.classList.add(v.blank ? 'is-blank' : 'is-miss');
        show(lines.grade);
      });
      at(980, function () { whyEl.textContent = v.why; show(lines.grade); toBottom(); });
      at(1600, function () { think(true); });
      at(2200, function () { show(lines.t5); pin(); });
      at(2900, function () {
        think(false);
        doneEl.textContent = v.done;
        show(lines.done);
      });
      at(3500, function () {
        arm(true);
        /* They just answered a question in here; "press ⏎ to run it again"
           should be true without hunting for the prompt first. */
        input.focus({ preventScroll: true });
        toBottom();
      });
    }

    /* Everything the last run printed, put back. */
    function reset() {
      stop(); clearInterval(spin); spin = null;
      ['sent', 'replay', 'think', 't1', 't2', 't3', 't4', 'ask', 'grade', 't5', 'done']
        .forEach(function (k) { hide(lines[k]); });
      lineWrap.insertBefore(lines.think, lines.t1);
      gradeEl.textContent = ''; gradeEl.className = '';
      whyEl.textContent = ''; doneEl.textContent = '';
      glyphEl.textContent = '✻'; wordEl.textContent = 'Forging';
      secEl.textContent = '0s'; tokEl.textContent = '1.1k';
      opts.forEach(function (o) {
        o.classList.remove('is-right', 'is-wrong', 'is-blank', 'is-cur');
        o.querySelector('.ask__mark').textContent = '';
      });
      optWrap.classList.remove('is-live');
      keysEl.hidden = false;
      calm();
    }

    /* ---------- input ---------- */
    input.addEventListener('input', function () { echo.textContent = input.value; toBottom(); });
    input.addEventListener('focus', calm);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); send(); }
    });
    nudge.addEventListener('click', function () { calm(); send(); });
    askNudge.addEventListener('click', function () { calm(); setCur(cur); });

    /* Clicking the screen puts you on the prompt, as it would in a shell. */
    screen.addEventListener('mousedown', function (e) {
      if (e.target.closest('button')) return;
      if (state === 'boot') { e.preventDefault(); skipBoot(); return; }
      if (state !== 'armed') return;
      e.preventDefault();
      input.focus({ preventScroll: true });
    });

    optWrap.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('.ask__opt') : null;
      if (el) answer(el);
    });
    optWrap.addEventListener('mousemove', function (e) {
      if (state !== 'asking') return;
      calm();
      var el = e.target.closest ? e.target.closest('.ask__opt') : null;
      var i = opts.indexOf(el);
      if (i > -1 && i !== cur) setCur(i);
    });
    /* Arrows walk the list the way the real picker does; the digits pick
       directly, which is the other thing Claude Code accepts. */
    optWrap.addEventListener('keydown', function (e) {
      if (state !== 'asking') return;
      calm();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setCur(cur + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        answer(opts[cur]);
      } else if (/^[1-5]$/.test(e.key)) {
        e.preventDefault();
        answer(opts[Number(e.key) - 1]);
      }
    });

    screen.setAttribute('data-ready', '');
    /* Don't run the boot into an empty room: a visitor who lands on #commands
       should still find the terminal at its armed prompt when they scroll up. */
    if (reduced || !('IntersectionObserver' in window)) { skipBoot(); return; }
    var seen = new IntersectionObserver(function (entries) {
      if (!entries[0].isIntersecting) return;
      seen.disconnect();
      bootUp();
    }, { threshold: 0.25 });
    seen.observe(term);
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
