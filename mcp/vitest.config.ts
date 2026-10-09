import { defineConfig } from 'vitest/config';

// `npm run coverage` measures the whole process tree with c8, because most of
// the CLI, installer and hooks are exercised as spawned `dist/` processes. For
// one consistent map, the suites then import the same compiled `dist/` files
// natively (not through vite's transform) and c8 remaps both to `src/`.
const coverage = !!process.env.EKLAVYA_COVERAGE;

export default defineConfig({
  resolve: coverage ? { alias: [{ find: /^(\.\.\/)+src\/(.*)$/, replacement: `${import.meta.dirname}/dist/$2` }] } : {},
  test: {
    // Hooks, workers and `claude` stand-ins are real processes. Under the whole
    // suite, and more under c8, the 5 second default failed three different
    // tests that pass alone: a limit for a hung test, not a loaded machine.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    ...(coverage ? { server: { deps: { external: [/\/mcp\/dist\//] } }, setupFiles: ['test/coverage-setup.ts'] } : {}),
    env: {
      // Every `git commit` starts a detached `git maintenance run --auto` that
      // can still be writing into `.git` when a test deletes its temp repo,
      // which fails the cleanup with ENOTEMPTY. Switched off for every git the
      // suites spawn (they all inherit this environment) rather than retried
      // around: the tests never want background maintenance anyway.
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'maintenance.auto',
      GIT_CONFIG_VALUE_0: 'false',
      // A suite run from inside a Claude Code session inherits that session's
      // id and host socket, and `resolveSessionId` prefers them over the
      // checkout pointer the tests set up -- green in CI, red on a laptop.
      CLAUDE_CODE_SESSION_ID: '',
      CLAUDE_CODE_MESSAGING_SOCKET: '',
      // Never the developer's own dashboard on 41729: a suite that probed it
      // would see whatever that one is serving, and one that stopped it would
      // stop theirs.
      EKLAVYA_DASHBOARD_PORT: '41730',
    },
  },
});
