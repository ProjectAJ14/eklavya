<div align="center">

<img src="web/public/brand/mark.svg" alt="Eklavya bow-and-arrow icon" width="120" height="120">

# Eklavya

**Learn while your agent works — and carry project context forward.**

*Named for Ekalavya, who mastered archery practicing before a silent statue of his guru. Here, the statue talks back.*

<img src="assets/checkpoint.gif" alt="A checkpoint question arriving in the middle of a task, answered in two keystrokes, and the work carrying straight on" width="760">

[![npm](https://img.shields.io/npm/v/eklavya?style=flat-square&color=0A5751&labelColor=16150f)](https://www.npmjs.com/package/eklavya)
[![license](https://img.shields.io/npm/l/eklavya?style=flat-square&color=0A5751&labelColor=16150f)](LICENSE)
[![node](https://img.shields.io/node/v/eklavya?style=flat-square&color=0A5751&labelColor=16150f)](https://nodejs.org)

</div>

Eklavya helps you understand the work Claude Code produces and remember what
happened in your project.

- **Learn while you build.** Short questions connect to the code Claude just
  wrote. Your answers guide difficulty and spaced reviews.
- **Keep project context.** Local memory captures work evidence and recalls
  relevant history in later Claude sessions.
- **Choose the pace.** Adjust the questions, use memory alone, or require a
  passing quiz before commits.

Eklavya stores its learning history locally. Default memory processing runs on
your machine; recalled history becomes context for Claude. No separate Eklavya
account. It sends anonymous daily usage counts, never code, paths, names or
text; [every field is listed](https://eklavya-run.web.app/docs/usage-analytics/),
and `eklavya telemetry off` stops them.

## Install

With **Claude Code and Node.js 22+** on macOS, Linux or Windows:

```bash
npm install -g eklavya && eklavya install
```

Accept the defaults, restart Claude Code, and start a task. Eklavya updates
itself in the background.

**[Read the documentation →](https://eklavya-run.web.app/docs/)**

Start with [Installing](https://eklavya-run.web.app/docs/installing/) for setup
and other environments, or [Your first session](https://eklavya-run.web.app/docs/first-session/)
to see the workflow. The manual covers commands, settings, memory, the dashboard
and troubleshooting.

## Contributing

Development setup, the manual test scripts and the release process are in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT
