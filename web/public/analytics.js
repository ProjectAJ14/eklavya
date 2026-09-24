/* ---------------------------------------------------------------
   Website analytics, shared by the landing page and the manual.

   Nothing loads until the visitor accepts: no Google script, no
   cookie, no request. The choice lives in localStorage under
   `eklavya-analytics` ('granted' | 'denied'); any element with
   [data-analytics-choice] reopens the banner so it can be changed.

   What is sent once granted (see /docs/usage-analytics/):
     page_view      GA4's own, one per page load
     section_view   landing only: a section scrolled into view, once
     copy_command   a Copy button on a shell command
     scroll_depth   manual only: 25/50/75/100% of a page, once each
     search         manual only: the search box, debounced
   GA4's enhanced measurement adds outbound clicks.
   --------------------------------------------------------------- */
(function () {
  var ID = 'G-26B0W7GSV0';
  var KEY = 'eklavya-analytics';
  var started = false;

  function read() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function write(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }

  function send(name, params) {
    if (started && window.gtag) window.gtag('event', name, params || {});
  }

  function start() {
    if (started) return;
    started = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', ID);
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + ID;
    document.head.appendChild(s);
    track();
  }

  function track() {
    var docs = location.pathname.indexOf('/docs/') === 0;

    document.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('.cmd-copy, .expressive-code .copy button');
      if (btn) send('copy_command', { where: docs ? 'docs' : 'landing' });
    });

    if (!docs && 'IntersectionObserver' in window) {
      var seen = {};
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          var name = en.target.getAttribute('data-section');
          if (!en.isIntersecting || seen[name]) return;
          seen[name] = true;
          io.unobserve(en.target);
          send('section_view', { section: name });
        });
      }, { threshold: 0.3 });
      document.querySelectorAll('header.hero, body section').forEach(function (el) {
        var name = el.id || el.getAttribute('aria-labelledby') || el.className.split(' ')[0];
        el.setAttribute('data-section', name.replace(/-title$/, ''));
        io.observe(el);
      });
    }

    if (docs) {
      var marks = [25, 50, 75, 100], hit = {};
      window.addEventListener('scroll', function () {
        var h = document.documentElement;
        var pct = (h.scrollTop + h.clientHeight) / h.scrollHeight * 100;
        marks.forEach(function (m) {
          if (pct >= m - 1 && !hit[m]) { hit[m] = true; send('scroll_depth', { percent: m }); }
        });
      }, { passive: true });

      var timer;
      document.addEventListener('input', function (e) {
        if (!e.target.closest || !e.target.closest('site-search')) return;
        clearTimeout(timer);
        var q = e.target.value.trim();
        timer = setTimeout(function () { if (q.length > 2) send('search', { search_term: q.slice(0, 100) }); }, 1200);
      });
    }
  }

  function banner() {
    if (document.getElementById('ek-consent')) return;
    var css = document.createElement('style');
    css.textContent =
      '#ek-consent{position:fixed;left:16px;right:16px;bottom:16px;z-index:1000;max-width:560px;margin-left:auto;' +
      'background:var(--panel);color:var(--dim);border:1px solid var(--line-2);box-shadow:var(--shadow-lg);' +
      'padding:16px 18px;font:14px/1.55 var(--font-body);border-radius:0}' +
      '#ek-consent p{margin:0 0 12px}#ek-consent a{color:var(--spot)}' +
      '#ek-consent .ek-row{display:flex;gap:8px;flex-wrap:wrap}' +
      '#ek-consent button{font:500 13px var(--font-body);padding:8px 14px;border-radius:0;cursor:pointer;' +
      'border:1px solid var(--line-2);background:transparent;color:var(--ink)}' +
      '#ek-consent button:hover{border-color:var(--spot);color:var(--spot)}' +
      '#ek-consent button.ek-yes{background:var(--spot);border-color:var(--spot);color:var(--spot-ink)}' +
      '#ek-consent button.ek-yes:hover{color:var(--spot-ink)}' +
      '#ek-consent button:focus-visible{outline:none;box-shadow:var(--ring)}';
    document.head.appendChild(css);
    var el = document.createElement('div');
    el.id = 'ek-consent';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Analytics choice');
    el.innerHTML =
      '<p>Can we count visits to this site with Google Analytics? It sets cookies and records which pages and sections are read. ' +
      '<a href="/docs/usage-analytics/">What is collected</a></p>' +
      '<div class="ek-row"><button type="button" class="ek-yes">Allow analytics</button>' +
      '<button type="button" class="ek-no">Decline</button></div>';
    document.body.appendChild(el);
    el.querySelector('.ek-yes').addEventListener('click', function () { write('granted'); el.remove(); start(); });
    el.querySelector('.ek-no').addEventListener('click', function () {
      var was = started;
      write('denied');
      el.remove();
      if (was) window.gtag('consent', 'update', { analytics_storage: 'denied' });
      clearCookies();
      // gtag cannot be unloaded from a live page; a reload drops it.
      if (was) location.reload();
    });
  }

  // Also run on every declined load: gtag can rewrite a cookie on its way out.
  function clearCookies() {
    document.cookie.split(';').forEach(function (c) {
      var n = c.split('=')[0].trim();
      if (n.indexOf('_ga') !== 0) return;
      [location.hostname, '.' + location.hostname, ''].forEach(function (d) {
        document.cookie = n + '=; Max-Age=0; path=/' + (d ? '; domain=' + d : '');
      });
    });
  }

  function init() {
    var choice = read();
    if (choice === 'granted') start();
    else if (choice === 'denied') clearCookies();
    else banner();
    document.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('[data-analytics-choice]')) { e.preventDefault(); banner(); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
