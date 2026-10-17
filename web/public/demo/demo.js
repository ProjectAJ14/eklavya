/* Launch film: a play button over the poster, click to pause, and a pause when it scrolls away. */
(function () {
  'use strict';
  var video = document.getElementById('demo');
  var button = document.querySelector('[data-demo-play]');
  if (!video || !button) return;
  var player = video.parentNode;
  var sync = function () { player.classList.toggle('is-playing', !video.paused && !video.ended); };
  ['play', 'pause', 'ended'].forEach(function (name) { video.addEventListener(name, sync); });
  button.addEventListener('click', function () { video.play(); video.focus(); });
  // A click on the picture toggles playback; the control bar keeps its own clicks.
  video.addEventListener('click', function (event) {
    if (event.offsetY > video.clientHeight - 56) return;
    if (video.paused) video.play(); else video.pause();
  });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      if (!entries[0].isIntersecting) video.pause();
    }, { threshold: 0.25 }).observe(video);
  }
})();
