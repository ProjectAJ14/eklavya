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
  Loading your history…
</div>
```

## State mapping

| State | Expression |
| --- | --- |
| info | neutral |
| success | happy |
| complete, milestone | celebrate |
| empty, notFound | curious |
| loading | excited |
| review | focused |
| tip | wink |
| new | surprised |
| validation | confused |
| warning | worried |
| error | sad |
| idle | sleepy |

Use state for product UI and expression for editorial art. Unsupported values fall back to neutral. Faces are explicit variants: use them at 24–40 px, full body at 56 px inline or 64 px and larger in open space, and loaders at 56 px inline / 96 px on a page. Do not use a sad or frustrated face to judge a learner's incorrect answer; the demo uses the encouraging tip state instead.

## Accessibility and motion

The mascot is decorative by default (`aria-hidden` on its SVG). Add `label` for meaningful standalone art. Loading text belongs to one surrounding status region. Do not replace copy with an emotion. The loader draws and releases an arrow over 2.8 seconds using transforms and opacity; `prefers-reduced-motion` stops it. The studio includes a pause control. No animation timers or runtime dependencies are required. `npm run mascot:check` and the website build reject stale exports.

## Current placements

- Website: companion above the interactive terminal, responding to its actual run/question/result states.
- Dashboard: initial and inline loaders, empty lists, missing records, feedback empty/error states, request errors, settings save/validation feedback, retry results, delete confirmation, and a rail link to the studio.
- Studio: all 13 expressions, body/face variants, state selector, size scale, loading motion, ink/paper toggle, and copyable examples.
