/* Ground selection. Runs before the stylesheets so the page never
   paints one ground and then swaps — custom properties inherit, so
   setting this one attribute resolves every role for the whole tree.
   `ink` is the default and an absent choice stays ink: that is a
   presentation decision, deliberately not the reader's OS setting.
   The key is shared with the docs, so a choice made on either page
   carries to the other. */
(function () {
  window.eklavyaGround = {
    read: function () {
      try { return localStorage.getItem('eklavya-ground') === 'paper' ? 'paper' : 'ink'; }
      catch (e) { return 'ink'; }
    },
    apply: function (mode) {
      document.documentElement.setAttribute('data-mode', mode);
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', mode === 'paper' ? '#f0ede6' : '#17171a');
      document.querySelectorAll('[data-ground]').forEach(function (b) {
        b.setAttribute('aria-pressed', String(b.dataset.ground === mode));
      });
      return mode;
    },
    save: function (mode) {
      try { localStorage.setItem('eklavya-ground', mode); } catch (e) {}
    },
    set: function (mode) { this.save(this.apply(mode)); }
  };
  window.eklavyaGround.apply(window.eklavyaGround.read());
})();
