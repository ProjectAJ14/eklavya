import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
