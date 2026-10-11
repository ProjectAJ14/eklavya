/* A fixed example session. No model calls, grading service or learner data leave this page. */
(function () {
  'use strict';
  var terminal = document.querySelector('[data-terminal]');
  var model = window.EklavyaPanelDemo;
  if (!terminal || !model) return;
  var strings = model.strings;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var find = function (selector) { return document.querySelector(selector); };
  var panel = find('[data-panel]');
  var options = Array.from(document.querySelectorAll('[data-option]'));
  var transcript = find('[data-transcript]');
  var prompt = find('[data-prompt]');
  var status = find('[data-demo-status]');
  var state = 'idle';
  var selected = null;
  var timers = [];
  var closer = null;
  var paneTab = false;

  document.querySelectorAll('[data-panel-label]').forEach(function (element) {
    element.textContent = strings[element.dataset.panelLabel];
  });
  find('[data-panel-wordmark]').textContent = model.wordmark;
  find('[data-other-answer]').placeholder = strings.otherPlaceholder;
  find('[data-empty]').textContent = strings.empty;
  find('[data-result]').prepend(find('.quiz-stem').cloneNode(true));
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
  function later(ms, fn) { timers.push(setTimeout(fn, reduced ? 0 : ms)); }
  function stop() { timers.forEach(clearTimeout); timers = []; clearTimeout(closer); closer = null; }
  function showPanel() {
    panel.hidden = false;
    find('[data-terminal-body]').classList.remove('is-panel-closed');
    find('[data-reopen]').hidden = true;
  }
  function hidePanel() {
    var restoreFocus = panel.contains(document.activeElement);
    panel.hidden = true;
    find('[data-terminal-body]').classList.add('is-panel-closed');
    find('[data-reopen]').hidden = false;
    if (restoreFocus) prompt.focus({ preventScroll: true });
  }
  function syncSubmit() {
    find('[data-submit]').disabled = !selected || (selected === 'other' && !find('[data-other-answer]').value.trim());
  }
  function choose(value, focus) {
    if (state !== 'awaiting') return;
    selected = value;
    options.forEach(function (option) {
      var picked = option.dataset.option === value;
      option.setAttribute('aria-pressed', String(picked));
      option.querySelector('.quiz-option__tick').textContent = picked ? '✓' : '';
    });
    find('[data-other]').hidden = value !== 'other';
    find('[data-notice]').hidden = true;
    syncSubmit();
    if (focus && value === 'other') find('[data-other-answer]').focus();
    else if (focus) options.find(function (option) { return option.dataset.option === value; }).focus({ preventScroll: true });
  }
  function openQuestion() {
    state = 'awaiting';
    find('[data-question]').hidden = false;
    find('[data-empty]').hidden = true;
    find('[data-topic]').hidden = false;
    showPanel();
    status.textContent = 'Claude keeps working. Pick an answer, then press Submit answer.';
  }
  function finishResult() {
    clearTimeout(closer);
    hidePanel();
    state = 'none';
    find('[data-question]').hidden = true;
    find('[data-result]').hidden = true;
    find('[data-topic]').hidden = true;
    find('[data-empty]').hidden = false;
    find('[data-empty]').textContent = strings.empty;
    status.textContent = 'Question finished. Replay the demo to try another answer.';
  }
  function result(skipped) {
    if (state !== 'awaiting') return;
    if (!skipped && !selected) return;
    if (!skipped && selected === 'other') {
      if (!find('[data-other-answer]').value.trim()) return;
      find('[data-notice]').textContent = 'Your words stay in this browser. The live panel uses Claude to check them; for this replay, pick one of the four example answers.';
      find('[data-notice]').hidden = false;
      return;
    }
    state = skipped ? 'skipped' : 'feedback';
    var right = selected === '1';
    var verdict = find('[data-verdict]');
    verdict.textContent = skipped ? strings.skipped : right ? strings.correct : strings.wrong;
    verdict.classList.toggle('is-miss', !skipped && !right);
    verdict.classList.toggle('is-skipped', skipped);
    find('[data-correct-answer]').hidden = skipped || right;
    find('[data-correct-answer]').textContent = "The answer was: So injected scripts can't read the refresh token";
    var explanations = {
      '1': 'httpOnly hides the refresh cookie from document.cookie. Injected scripts can still make authenticated requests, so it limits token theft without preventing every XSS attack.',
      '2': 'httpOnly hides a cookie from scripts. SameSite and CSRF protections control when cookies can accompany cross-site requests.',
      '3': 'httpOnly restricts browser scripts. It does not control what your server logs when the browser sends the cookie.',
      '4': 'Revocation depends on server-side validation. Keeping a token in memory or setting a cookie flag does not make it instantly revocable.'
    };
    find('[data-explanation]').textContent = skipped ? '' : explanations[selected];
    find('[data-result] .quiz-stem').hidden = skipped;
    find('[data-auto-close]').textContent = strings.autoClose;
    find('[data-question]').hidden = true;
    find('[data-result]').hidden = false;
    status.textContent = skipped ? 'Question skipped. Claude can keep working.' : right ? 'Correct. Read the explanation, then press Done or replay the demo.' : 'Needs another look. Read the explanation, then try again with Replay demo.';
    find('[data-done]').focus({ preventScroll: true });
    closer = setTimeout(finishResult, 15000);
  }
  function run() {
    stop();
    state = 'running';
    selected = null;
    find('[data-replay]').textContent = 'Replay demo ↻';
    find('[data-ready]').hidden = true;
    find('[data-task-log]').hidden = false;
    find('[data-running]').hidden = false;
    find('[data-question]').hidden = true;
    find('[data-result]').hidden = true;
    find('[data-topic]').hidden = true;
    find('[data-empty]').hidden = false;
    find('[data-empty]').textContent = strings.loading;
    find('[data-other]').hidden = true;
    find('[data-other-answer]').value = '';
    find('[data-notice]').hidden = true;
    find('[data-submit]').disabled = true;
    options.forEach(function (option) {
      option.setAttribute('aria-pressed', 'false');
      option.querySelector('.quiz-option__tick').textContent = '';
    });
    find('[data-send]').disabled = true;
    showPanel();
    status.textContent = 'Claude is adding auth to the example API.';
    var steps = Array.from(document.querySelectorAll('[data-step]'));
    steps.forEach(function (step, i) {
      step.hidden = true;
      later(350 + i * 550, function () {
        step.hidden = false;
        transcript.scrollTop = transcript.scrollHeight;
        if (i === 3) openQuestion();
        if (i === 5) {
          find('[data-running]').hidden = true;
          find('[data-send]').disabled = false;
          if (state === 'awaiting') status.textContent = 'Auth is in place. Pick an answer, then press Submit answer.';
        }
      });
    });
  }
  find('[data-replay]').addEventListener('click', run);
  find('[data-prompt-form]').addEventListener('submit', function (event) { event.preventDefault(); if (!find('[data-send]').disabled) run(); });
  options.forEach(function (option) { option.addEventListener('click', function () { choose(option.dataset.option, option.dataset.option === 'other'); }); });
  find('[data-other-answer]').addEventListener('input', syncSubmit);
  find('[data-submit]').addEventListener('click', function () { result(false); });
  find('[data-skip]').addEventListener('click', function () { result(true); });
  find('[data-done]').addEventListener('click', finishResult);
  find('[data-close]').addEventListener('click', hidePanel);
  find('[data-reopen]').addEventListener('click', function () { showPanel(); panel.focus({ preventScroll: true }); });
  terminal.addEventListener('keydown', function (event) {
    if (event.ctrlKey && event.key.toLowerCase() === 'x') { paneTab = true; event.preventDefault(); return; }
    if (paneTab && event.key === 'Tab') { paneTab = false; event.preventDefault(); showPanel(); panel.focus({ preventScroll: true }); return; }
    paneTab = false;
    if (!panel.contains(event.target)) return;
    if (event.key === 'Escape') { event.preventDefault(); hidePanel(); return; }
    // Typing an answer must never trigger the panel's single-letter hotkeys.
    if (event.target.matches('textarea, input') || event.ctrlKey || event.metaKey || event.altKey) return;
    if ((state === 'feedback' || state === 'skipped') && event.key.toLowerCase() === 'd') { event.preventDefault(); finishResult(); return; }
    if (state !== 'awaiting') return;
    if (/^[1-4]$/.test(event.key)) { event.preventDefault(); choose(event.key, true); }
    else if (event.key.toLowerCase() === 'o') { event.preventDefault(); choose('other', true); }
    else if (event.key.toLowerCase() === 's') { event.preventDefault(); result(false); }
    else if (event.key.toLowerCase() === 'k') { event.preventDefault(); result(true); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      var index = options.findIndex(function (option) { return option.dataset.option === selected; });
      var next = index < 0 ? 0 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      choose(options[next].dataset.option, true);
    }
  });
})();
