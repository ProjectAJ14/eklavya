import { afterEach, describe, expect, it } from 'vitest';
import { stripAskHeader } from '../src/ask.js';
import {
  COWORK_NOTE,
  attributionRule,
  currentSurface,
  isCowork,
  needsInlineAttribution,
  withSurfaceNote,
} from '../src/surface.js';

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

/**
 * A separate axis from `Surface`, and the tests say so on purpose: the Code tab
 * in Claude Desktop stays `code` for every pedagogical decision above, and is
 * still a host that never paints the `header` chip. Anyone who later collapses
 * the two will fail both this block and the one that keeps `claude-desktop` out
 * of Cowork.
 */
describe('needsInlineAttribution', () => {
  it('is false in a terminal, where the chip is painted', () => {
    for (const entrypoint of ['cli', 'mcp', 'bench', 'sdk-cli', 'ssh-remote']) {
      setEnv(entrypoint);
      expect(needsInlineAttribution(), entrypoint).toBe(false);
    }
  });

  // The VS Code extension runs Claude Code in an integrated terminal, so it
  // paints the chip like any other terminal. It is the near-miss this pattern
  // has to not catch.
  it('leaves the VS Code extension alone', () => {
    setEnv('claude-vscode');
    expect(needsInlineAttribution()).toBe(false);
  });

  it('is true on every Claude Desktop host, named or not yet named', () => {
    for (const entrypoint of [
      'claude-desktop',
      'claude-desktop-3p',
      'claude-desktop-something-added-later',
      'remote_desktop',
    ]) {
      setEnv(entrypoint);
      expect(needsInlineAttribution(), entrypoint).toBe(true);
    }
  });

  // Cowork is Claude Desktop too: no terminal, no chip, no status bar.
  it('is true on Cowork, which spells none of its entrypoints "desktop"', () => {
    for (const entrypoint of ['local-agent', 'claude-coworker', 'remote_cowork']) {
      setEnv(entrypoint);
      expect(needsInlineAttribution(), entrypoint).toBe(true);
    }
  });

  /**
   * An unknown host is assumed to paint the chip. That is the direction to be
   * wrong in: the cost is one host losing attribution until someone adds it,
   * against a redundant prefix on every question in the terminal, which is
   * where nearly every session runs.
   */
  it('assumes a chip when the host says nothing it recognises', () => {
    setEnv(undefined);
    expect(needsInlineAttribution()).toBe(false);
    setEnv('some-future-surface');
    expect(needsInlineAttribution()).toBe(false);
  });

  it('follows EKLAVYA_SURFACE into Cowork', () => {
    setEnv('cli', 'cowork');
    expect(needsInlineAttribution()).toBe(true);
  });

  // The override says what kind of work a session produces. It does not
  // conjure a terminal onto a host that draws a card, so the prefix stays.
  it('does not let EKLAVYA_SURFACE=code claim a chip Desktop never paints', () => {
    setEnv('claude-desktop', 'code');
    expect(currentSurface()).toBe('code');
    expect(needsInlineAttribution()).toBe(true);
  });
});

describe('attributionRule', () => {
  it('asks for the chip alone in a terminal, and says to keep the stem clean', () => {
    setEnv('cli');
    const rule = attributionRule();
    expect(rule).toContain('Header "Eklavya"');
    expect(rule).not.toContain('[Eklavya]');
    expect(rule).toContain('status bar');
  });

  // The whole point of the change: on a card, the prefix is the attribution.
  it('asks for the stem prefix on a host with no chip', () => {
    setEnv('claude-desktop');
    const rule = attributionRule();
    expect(rule).toContain('[Eklavya]');
    expect(rule).not.toContain('status bar');
  });

  /**
   * The prefix the rule asks for has to be the one `stripAskHeader` takes back
   * off, or the stem is stored with it and the fingerprint drifts. Stated as a
   * test because the two live in different files.
   */
  it('asks for exactly the prefix ask.ts strips', () => {
    setEnv('claude-desktop');
    const stem = 'Why is httpOnly set on the refresh cookie here?';
    expect(attributionRule()).toContain('[Eklavya]');
    expect(stripAskHeader(`[Eklavya]\n${stem}`)).toBe(stem);
  });
});
