/* A fixed example session. No model calls, grading service or learner data leave this page. */
(function () {
  'use strict';
  var terminal = document.querySelector('[data-terminal]');
  var model = window.EklavyaPanelDemo;
  if (!terminal || !model) return;

  var find = function (selector) { return terminal.querySelector(selector); };
  var strings = model.strings;
  var panel = find('[data-panel]');
  var panelContent = find('.quiz-panel__content');
  var actions = find('.quiz-actions');
  var body = find('[data-terminal-body]');
  var transcript = find('[data-transcript]');
  var prompt = find('[data-prompt]');
  var options = Array.from(terminal.querySelectorAll('[data-option]'));
  var steps = Array.from(terminal.querySelectorAll('[data-step]'));
  var status = document.querySelector('[data-demo-status]');
  var pauseButton = document.querySelector('[data-demo-pause]');
  var motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var examplePrompt = 'Add JWT auth to the Express API';
  var explanation = 'httpOnly hides the refresh cookie from document.cookie. Injected scripts can still make authenticated requests, so it limits token theft without preventing every XSS attack.';
  var events = [];
  var nextEvent = 0;
  var elapsed = 0;
  var runningSince = null;
  var timer = null;
  var finished = false;
  var userPaused = false;
  var windowActive = document.hasFocus();
  var observedFull = !('IntersectionObserver' in window);

  terminal.querySelectorAll('[data-panel-label]').forEach(function (element) {
    element.textContent = strings[element.dataset.panelLabel];
  });
  find('[data-panel-wordmark]').textContent = model.wordmark;
  find('[data-empty]').textContent = strings.empty;
  find('[data-grading]').textContent = strings.grading;
  find('[data-auto-close]').textContent = strings.autoClose;
  var result = find('[data-result]');
  if (!result.querySelector('.quiz-stem')) result.prepend(find('.quiz-stem').cloneNode(true));
  var logo = find('[data-panel-logo]');
  model.logoRows.forEach(function (row) {
    var line = document.createElement('div');
    row.forEach(function (run) {
      var span = document.createElement('span');
      span.textContent = run.text;
      // The actual mod's fixed logo colours are part of the terminal artwork.
      if (run.fg) span.style.color = run.fg;
      if (run.bg) span.style.backgroundColor = run.bg;
      line.appendChild(span);
    });
    logo.appendChild(line);
  });

  function phase(name, message) {
    terminal.dataset.demoState = name;
    if (status && message) status.textContent = message;
  }
  function panelOpen(open) {
    panel.hidden = !open;
    body.classList.toggle('is-panel-closed', !open);
  }
  function showStep(number) {
    var step = steps.find(function (element) { return element.dataset.step === String(number); });
    if (step) step.hidden = false;
    // Only the transcript moves; the page and keyboard focus stay where they are.
    transcript.scrollTop = transcript.scrollHeight;
  }
  function showInPanel(element) {
    var box = panelContent.getBoundingClientRect();
    var top = box.top + panelContent.clientTop;
    var bottom = top + panelContent.clientHeight;
    var target = element.getBoundingClientRect();
    if (target.bottom > bottom) panelContent.scrollTop += target.bottom - bottom;
    else if (target.top < top) panelContent.scrollTop -= top - target.top;
  }
  function pauseLabel() {
    if (!pauseButton) return;
    pauseButton.hidden = false;
    pauseButton.textContent = finished ? 'Replay demo' : userPaused ? 'Resume animation' : 'Pause animation';
    pauseButton.removeAttribute('aria-disabled');
    if (finished) pauseButton.removeAttribute('aria-pressed');
    else pauseButton.setAttribute('aria-pressed', String(userPaused));
  }
  function clockTime() {
    return elapsed + (runningSince === null ? 0 : Date.now() - runningSince);
  }
  function pauseClock() {
    if (runningSince !== null) elapsed = clockTime();
    runningSince = null;
    clearTimeout(timer);
    timer = null;
    terminal.dataset.demoPaused = 'true';
  }
  function complete() {
    finished = true;
    pauseClock();
    find('[data-running]').hidden = true;
    find('[data-task-done]').hidden = false;
    prompt.textContent = '';
    phase('complete', 'Auth is in place. The example question was answered correctly while Claude kept working.');
    pauseLabel();
    transcript.scrollTop = transcript.scrollHeight;
  }
  function advance() {
    timer = null;
    if (userPaused || document.hidden || !windowActive || !fullyVisible()) {
      pauseClock();
      return;
    }
    var now = clockTime();
    while (nextEvent < events.length && events[nextEvent].at <= now) {
      events[nextEvent].run();
      nextEvent += 1;
    }
    if (!finished && nextEvent < events.length) {
      timer = setTimeout(advance, Math.max(0, events[nextEvent].at - clockTime()));
    }
  }
  function fullyVisible() {
    var box = terminal.getBoundingClientRect();
    var consent = document.getElementById('ek-consent');
    if (consent) {
      var consentBox = consent.getBoundingClientRect();
      var consentStyle = window.getComputedStyle(consent);
      if (consentStyle.visibility === 'visible' && Number(consentStyle.opacity) > 0 &&
          Math.min(box.right, consentBox.right) > Math.max(box.left, consentBox.left) &&
          Math.min(box.bottom, consentBox.bottom) > Math.max(box.top, consentBox.top)) return false;
    }
    return observedFull && box.width > 0 && box.height > 0 && box.top >= 0 && box.left >= 0 &&
      box.bottom <= window.innerHeight && box.right <= window.innerWidth;
  }
  function syncPlayback() {
    if (finished || motion.matches) return;
    if (userPaused || document.hidden || !windowActive || !fullyVisible()) {
      pauseClock();
      return;
    }
    if (runningSince !== null) return;
    runningSince = Date.now();
    terminal.dataset.demoPaused = 'false';
    advance();
  }
  function at(time, run) { events.push({ at: time, run: run }); }

  at(0, function () {
    find('[data-ready]').hidden = true;
    phase('typing', 'The example starts with a request to add auth.');
  });
  Array.from(examplePrompt).forEach(function (_, index) {
    at((index + 1) * 55, function () { prompt.textContent = examplePrompt.slice(0, index + 1); });
  });
  at(2200, function () {
    find('[data-enter]').classList.add('is-pressed');
    phase('submitted', 'The prompt is sent to Claude.');
  });
  at(2600, function () {
    find('[data-enter]').classList.remove('is-pressed');
    prompt.textContent = '';
    find('[data-task-log]').hidden = false;
    find('[data-running]').hidden = false;
    phase('working', 'Claude reads the app and adds the token handlers.');
  });
  at(3400, function () { showStep(0); });
  at(5000, function () { showStep(1); });
  at(6400, function () { showStep(2); });
  at(7200, function () {
    showStep(3);
    find('[data-empty]').hidden = true;
    find('[data-topic]').hidden = false;
    find('[data-question]').hidden = false;
    panelOpen(true);
    panelContent.scrollTop = 0;
    phase('awaiting', 'A question opens in the side panel. Claude keeps working.');
  });
  at(8500, function () { showStep(4); });
  at(9800, function () {
    options.forEach(function (option) {
      var picked = option.dataset.option === '1';
      option.dataset.selected = String(picked);
      option.querySelector('.quiz-option__tick').textContent = picked ? '✓' : '';
    });
    find('[data-submit]').dataset.ready = 'true';
    showInPanel(find('[data-option="1"]'));
    phase('selected', 'The example selects an answer before submitting it.');
  });
  at(11000, function () {
    find('[data-submit]').dataset.ready = 'false';
    find('[data-submit]').classList.add('is-pressed');
    showInPanel(find('[data-submit]'));
    phase('submitting', 'The example submits the selected answer.');
  });
  at(11350, function () {
    find('[data-submit]').classList.remove('is-pressed');
    actions.hidden = true;
    find('[data-grading]').hidden = false;
    showInPanel(find('[data-grading]'));
    phase('grading', 'The answer is submitted. Eklavya checks it.');
  });
  at(11800, function () {
    find('[data-submit]').classList.remove('is-pressed');
    find('[data-grading]').hidden = true;
    find('[data-question]').hidden = true;
    find('[data-verdict]').textContent = strings.correct;
    find('[data-explanation]').textContent = explanation;
    result.hidden = false;
    panelContent.scrollTop = 0;
    phase('feedback', 'Correct. The panel explains why the cookie uses httpOnly.');
  });
  at(12500, function () { showInPanel(find('[data-explanation]')); });
  at(15000, function () {
    showInPanel(find('[data-done]'));
    find('[data-done]').classList.add('is-pressed');
    phase('acknowledging', 'The example closes the answer with Done.');
  });
  at(15400, function () {
    find('[data-done]').classList.remove('is-pressed');
    result.hidden = true;
    find('[data-topic]').hidden = true;
    find('[data-empty]').hidden = false;
    panelOpen(false);
    phase('continuing', 'Question finished. Claude runs the tests.');
  });
  at(16000, function () { showStep(5); });
  at(18000, complete);

  function staticSummary() {
    nextEvent = events.length;
    pauseClock();
    find('[data-ready]').hidden = true;
    find('[data-task-log]').hidden = false;
    steps.forEach(function (step) { step.hidden = false; });
    find('[data-question]').hidden = true;
    find('[data-grading]').hidden = true;
    result.hidden = true;
    find('[data-topic]').hidden = true;
    find('[data-empty]').hidden = false;
    ['[data-enter]', '[data-submit]', '[data-done]'].forEach(function (selector) {
      find(selector).classList.remove('is-pressed');
    });
    panelOpen(false);
    complete();
    transcript.scrollTop = transcript.scrollHeight;
  }

  function reset() {
    pauseClock();
    finished = false;
    userPaused = false;
    nextEvent = 0;
    elapsed = 0;
    prompt.textContent = '';
    find('[data-ready]').hidden = false;
    ['[data-task-log]', '[data-running]', '[data-task-done]', '[data-question]',
      '[data-grading]', '[data-topic]', '[data-result]'].forEach(function (selector) {
      find(selector).hidden = true;
    });
    find('[data-empty]').hidden = false;
    steps.forEach(function (step) { step.hidden = true; });
    options.forEach(function (option) {
      delete option.dataset.selected;
      option.querySelector('.quiz-option__tick').textContent = '';
    });
    actions.hidden = false;
    find('[data-submit]').dataset.ready = 'false';
    find('[data-verdict]').textContent = '';
    find('[data-explanation]').textContent = '';
    ['[data-enter]', '[data-submit]', '[data-done]'].forEach(function (selector) {
      find(selector).classList.remove('is-pressed');
    });
    panelOpen(false);
    panelContent.scrollTop = 0;
    transcript.scrollTop = 0;
    phase('idle', 'The example starts when the whole terminal is in view.');
    pauseLabel();
  }

  reset();
  if (pauseButton) pauseButton.addEventListener('click', function () {
    if (finished) {
      reset();
      if (motion.matches) {
        staticSummary();
        // Let reduced-motion readers revisit the still transcript from the start.
        transcript.scrollTop = 0;
      } else syncPlayback();
      return;
    }
    userPaused = !userPaused;
    pauseLabel();
    syncPlayback();
  });
  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      observedFull = entries[0].isIntersecting && entries[0].intersectionRatio === 1;
      syncPlayback();
    }, { threshold: [0, 1] });
    observer.observe(terminal);
  }
  if ('MutationObserver' in window) {
    // The existing analytics banner is appended to, and removed from, the body.
    new MutationObserver(syncPlayback).observe(document.body, { childList: true });
  }
  window.addEventListener('scroll', syncPlayback, { passive: true });
  window.addEventListener('resize', syncPlayback);
  window.addEventListener('blur', function () { windowActive = false; syncPlayback(); });
  window.addEventListener('focus', function () { windowActive = true; syncPlayback(); });
  document.addEventListener('visibilitychange', syncPlayback);
  window.addEventListener('pagehide', pauseClock);
  window.addEventListener('pageshow', function () { windowActive = document.hasFocus(); syncPlayback(); });
  motion.addEventListener('change', function () {
    if (motion.matches) staticSummary();
  });
  if (motion.matches) staticSummary();
  else syncPlayback();
})();
