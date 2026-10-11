/* Mouse-following eyes belong only to the landing-page mascot. */
(function () {
  'use strict';
  var mascot = document.querySelector('.hero eklavya-mascot[data-hero-mascot]');
  if (!mascot || !window.customElements) return;

  customElements.whenDefined('eklavya-mascot').then(function () {
    var motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    var mouse = window.matchMedia('(hover: hover) and (pointer: fine)');
    var eyes = [];
    var inView = !('IntersectionObserver' in window);
    var windowActive = document.hasFocus();
    var pointer = null;
    var frame = null;

    function center() {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      pointer = null;
      eyes.forEach(function (eye) { eye.pupil.setAttribute('transform', 'translate(0 0)'); });
    }

    function canFollow() {
      var box = mascot.getBoundingClientRect();
      return inView && box.bottom > 0 && box.top < window.innerHeight &&
        box.right > 0 && box.left < window.innerWidth &&
        windowActive && !document.hidden && mouse.matches && !motion.matches;
    }

    function decorate() {
      center();
      eyes = [];
      mascot.querySelectorAll('.hero-eye__pupil').forEach(function (pupil) { pupil.remove(); });
      var rectangles = mascot.querySelectorAll('.ek-mascot__face > rect');
      if (rectangles.length !== 2) return;
      rectangles.forEach(function (eye) {
        var width = Number(eye.getAttribute('width'));
        var height = Number(eye.getAttribute('height'));
        var pupil = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
        eye.classList.add('hero-eye');
        pupil.classList.add('hero-eye__pupil');
        pupil.setAttribute('cx', String(Number(eye.getAttribute('x')) + width / 2));
        pupil.setAttribute('cy', String(Number(eye.getAttribute('y')) + height / 2));
        pupil.setAttribute('rx', String(width * .22));
        pupil.setAttribute('ry', String(height * .2));
        pupil.setAttribute('transform', 'translate(0 0)');
        eye.parentNode.appendChild(pupil);
        eyes.push({ eye: eye, pupil: pupil, maxX: width * .2, maxY: height * .18 });
      });
    }

    function follow() {
      frame = null;
      if (!pointer || !canFollow()) { center(); return; }
      eyes.forEach(function (eye) {
        var box = eye.eye.getBoundingClientRect();
        var dx = pointer.x - (box.left + box.width / 2);
        var dy = pointer.y - (box.top + box.height / 2);
        // Keep each pupil inside its green oval, even at the screen's edge.
        var distance = Math.max(100, Math.hypot(dx, dy));
        var x = (dx / distance * eye.maxX).toFixed(3);
        var y = (dy / distance * eye.maxY).toFixed(3);
        eye.pupil.setAttribute('transform', 'translate(' + x + ' ' + y + ')');
      });
    }

    decorate();
    // The shared element can replace its SVG when an attribute changes.
    new MutationObserver(decorate).observe(mascot, { childList: true });

    document.addEventListener('pointermove', function (event) {
      if (event.pointerType !== 'mouse' || !canFollow()) { center(); return; }
      pointer = { x: event.clientX, y: event.clientY };
      if (frame === null) frame = window.requestAnimationFrame(follow);
    }, { passive: true });
    document.addEventListener('pointerout', function (event) {
      if (!event.relatedTarget) center();
    });
    document.addEventListener('visibilitychange', center);
    window.addEventListener('blur', function () { windowActive = false; center(); });
    window.addEventListener('focus', function () { windowActive = true; });
    window.addEventListener('pagehide', function () { windowActive = false; center(); });
    window.addEventListener('pageshow', function () { windowActive = document.hasFocus(); center(); });
    window.addEventListener('resize', center);
    motion.addEventListener('change', center);
    mouse.addEventListener('change', center);

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        inView = entries[0].isIntersecting;
        if (!inView) center();
      }).observe(mascot);
    } else {
      window.addEventListener('scroll', function () { if (!canFollow()) center(); }, { passive: true });
    }
  });
})();
