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
    },
  },
});
