import { afterEach, describe, expect, it } from 'vitest';
import { COWORK_NOTE, currentSurface, isCowork, withSurfaceNote } from '../src/surface.js';

const ENTRYPOINT = 'CLAUDE_CODE_ENTRYPOINT';
const OVERRIDE = 'EKLAVYA_SURFACE';

function setEnv(entrypoint?: string, override?: string): void {
  if (entrypoint === undefined) delete process.env[ENTRYPOINT];
  else process.env[ENTRYPOINT] = entrypoint;
  if (override === undefined) delete process.env[OVERRIDE];
  else process.env[OVERRIDE] = override;
}

afterEach(() => setEnv(undefined, undefined));

describe('currentSurface', () => {
  it('reads Cowork from the entrypoints Claude Desktop stamps', () => {
    for (const entrypoint of ['local-agent', 'local_agent', 'remote_cowork', 'remote_cowork_trigger']) {
      setEnv(entrypoint);
      expect(currentSurface(), entrypoint).toBe('cowork');
    }
  });

  /**
   * The app treats `claude-coworker` as a prefix family, not a fixed name:
   * `nji = ["claude-coworker"]; rji = e => tji.has(e) || nji.some(t => e.startsWith(t))`.
   * An allowlist would miss every member added after this was written, and miss
   * it silently — the session just gets code-shaped wording. The trailing case
   * is the one that proves the rule is a substring and not four literals.
   */
  it('catches the whole coworker family, including names not invented yet', () => {
    for (const entrypoint of [
      'claude-coworker',
      'claude-coworker-terminal',
      'claude-coworker-something-added-later',
    ]) {
      setEnv(entrypoint);
      expect(currentSurface(), entrypoint).toBe('cowork');
    }
  });

  // The Code tab in Claude Desktop is the same engine on the same ~/.claude, so
  // it must keep behaving exactly like a terminal. This is the assertion that
  // stops someone "fixing" Desktop support by treating claude-desktop as Cowork.
  //
  // The list is every non-Cowork entrypoint in the app's own enum, because the
  // detection is a substring match: this is what proves it cannot over-match.
  it('treats the terminal and the Desktop Code tab alike', () => {
    for (const entrypoint of [
      'cli',
      'mcp',
      'bench',
      'sdk-cli',
      'sdk-ts',
      'sdk-py',
      'claude-vscode',
      'claude-code-github-action',
      'claude-desktop',
      'claude-desktop-3p',
      'claude-security',
      'remote',
      'remote_baku',
      'remote_trigger',
      'remote_desktop',
      'remote_mobile',
      'claude_in_slack',
      'claude-in-slack',
      'claude-in-teams',
      'ssh-remote',
    ]) {
      setEnv(entrypoint);
      expect(currentSurface(), entrypoint).toBe('code');
    }
  });

  it('defaults to code when the host says nothing', () => {
    setEnv(undefined);
    expect(currentSurface()).toBe('code');
  });

  it('defaults to code for an entrypoint it has never heard of', () => {
    setEnv('some-future-surface');
    expect(currentSurface()).toBe('code');
  });

  it('lets EKLAVYA_SURFACE win either way', () => {
    setEnv('cli', 'cowork');
    expect(currentSurface()).toBe('cowork');
    setEnv('local-agent', 'code');
    expect(currentSurface()).toBe('code');
  });

  it('ignores a nonsense override rather than trusting it', () => {
    setEnv('local-agent', 'banana');
    expect(currentSurface()).toBe('cowork');
  });
});

describe('withSurfaceNote', () => {
  it('leaves text untouched on Claude Code', () => {
    setEnv('cli');
    expect(withSurfaceNote('ground it in the diff')).toBe('ground it in the diff');
    expect(isCowork()).toBe(false);
  });

  it('appends the note on Cowork, with the separator asked for', () => {
    setEnv('local-agent');
    expect(withSurfaceNote('ground it in the diff')).toBe(`ground it in the diff\n${COWORK_NOTE}`);
    expect(withSurfaceNote('ground it in the diff', ' ')).toBe(`ground it in the diff ${COWORK_NOTE}`);
  });

  // The note only works if it actually overrides the words it is appended to.
  it('names the nouns the code-shaped strings use', () => {
    expect(COWORK_NOTE).toContain('code');
    expect(COWORK_NOTE).toContain('diff');
    expect(COWORK_NOTE).toContain('Cowork');
  });
});
