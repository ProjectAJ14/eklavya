# Archer Cloak mascot

The Eklavya companion adds personality without changing the name, bow mark, typography, or theme system. It follows the chosen coral character with a verdigris archer cloak and bow. The Helix reference informed the shared state mapping, accessible loaders, compact faces, and interactive gallery.

## Source and reuse

`web/public/brand/mascot/mascot.js` owns the SVG geometry, expression registry, state mapping, and dependency-free `<eklavya-mascot>` element. `web/public/tokens.css` owns the mascot identity colors. `mascot.css` owns motion and shared companion layouts. These exact files are bundled into the npm dashboard by `mcp/scripts/copy-assets.mjs`; assets are served through an explicit allowlist. No remote requests are needed by the dashboard or its gallery.

Run `npm run mascot:generate` after artwork changes to refresh the standalone body/face SVG exports. These are for documentation and other surfaces; live components use the same source. Preview expressions, loading, sizes, and both grounds at `/mascot.html` on the site or dashboard.

```html
<link rel="stylesheet" href="/tokens.css">
<link rel="stylesheet" href="/brand/mascot/mascot.css">
<script src="/brand/mascot/mascot.js" defer></script>

<eklavya-mascot state="empty" size="80"></eklavya-mascot>
<eklavya-mascot expression="wink" variant="face" size="40"></eklavya-mascot>
<div role="status" aria-live="polite">
  <eklavya-mascot state="loading" variant="loading" size="56"></eklavya-mascot>
  <!-- a random verb for each wait, such as Pondering… -->
  <span>Pondering…</span>
</div>
```

## State mapping

| State | Expression |
| --- | --- |
| info | neutral |
| success | happy |
| complete, milestone | celebrate |
| empty, notFound | curious |
| loading | cool |
| review | focused |
| tip | wink |
| new | surprised |
| validation | confused |
| warning | worried |
| error | sad |
| idle | sleepy |

Use state for product UI and expression for editorial art. Unsupported values fall back to neutral. Faces are explicit variants: use them at 24–40 px, full body at 56 px inline or 64 px and larger in open space, and loaders at 56 px inline / 96 px on a page. Do not use a sad or frustrated face to judge a learner's incorrect answer; use the encouraging tip state instead.

## Accessibility and motion

The mascot is decorative by default (`aria-hidden` on its SVG). Add `label` for meaningful standalone art. Loading text belongs to one surrounding status region. The dashboard's `loader()` shows a random Claude Code spinner verb (`LOADER_VERBS`, without "Clauding") instead of "Loading…", fresh for every wait and never fixed to a screen. The verb is all the loader says, to screen readers too; `loader(label)` uses its label only to keep one verb through a wait's redraws. Do not replace copy with an emotion. The loader (`variant="loading"`, cool by default) faces the viewer and walks toward them, holding the arrow point-down in one hand and the bow in the other. The legs alternate over a 1.2-second stride while ground lines recede toward the horizon, so it walks in place, using only transforms and opacity. Any expression works with it. `prefers-reduced-motion` stops it on a static ground. A secondary loader, `variant="draw"`, draws and releases an arrow over 2.8 seconds; use it where a loader fits that moment better, with an expression of your choice. Reduced motion stops it too. The studio includes a pause control. No animation timers or runtime dependencies are required. `npm run mascot:check` and the website build reject stale exports.

## Current placements

- Website: the full Archer Cloak mascot leads the landing page on a dark hero.
  The automatic terminal replay is embedded below it at `/#demo`; `/demo/`
  redirects there. Its text logo and panel labels come from `hooks/panel/model.ts`
  through `web/scripts/demo-panel.mjs`. The panel appears only when the example
  question arrives. The replay answers it and finishes the task automatically,
  without asking visitors to type or answer. It starts when the whole terminal
  is visible, pauses offscreen or in an inactive tab or window, and honors
  reduced motion. Keep the GitHub star box visible with a real count. The home
  also keeps the compact `#legend` name story, its "The name" eyebrow and
  "The archer who taught himself" heading. Its decorative bow, arrow and target
  scene animates once when it enters view and stays static under reduced motion.
- Dashboard: initial and inline loaders, empty lists, missing records, feedback empty/error states, request errors, settings save/validation feedback, retry results, delete confirmation, tip bubbles (the `tip` face, with a fitting `state` on a few tips), and the Settings Companion tab, which links to the studio.
- Studio: all 24 expressions, body/face variants, state selector, size scale, walking loader, secondary bow-draw loader, ink/paper toggle, and copyable examples.
