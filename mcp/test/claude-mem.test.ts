import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guessProjectMap } from '../src/claude-mem.js';
import { PROJECT, buildSource } from './claude-mem-fixture.js';

/**
 * The fixture's one session is `content-1` in `demo-repo`. Claude Code keeps its
 * transcript in a directory named after the checkout, and that transcript
 * records the cwd -- which is what places the project.
 */
let tmp = '';
let claudeHome = '';
let source = '';
let checkout = '';

const transcriptDir = (dir: string) => path.join(claudeHome, 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'));

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-cmem-map-')));
  claudeHome = path.join(tmp, 'claude');
  source = path.join(tmp, 'claude-mem.db');
  buildSource(source);
  checkout = path.join(tmp, 'work', 'demo_repo');
  fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function transcript(dir: string, cwd: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'content-1.jsonl'), `${JSON.stringify({ type: 'user', cwd })}\n`);
}

describe('guessProjectMap', () => {
  it('places a project where its sessions ran', () => {
    transcript(transcriptDir(checkout), path.join(checkout, 'src'));
    expect(guessProjectMap(source, claudeHome)).toEqual({ [PROJECT]: checkout });
  });

  it('follows a checkout that moved: the transcript dir is renamed, the recorded cwd is not', () => {
    // `demo_repo` encodes to `demo-repo` -- lossy, so this also pins the walk.
    transcript(transcriptDir(checkout), path.join(tmp, 'old-place', 'demo_repo'));
    expect(guessProjectMap(source, claudeHome)).toEqual({ [PROJECT]: checkout });
  });

  it('leaves out a project it cannot place, rather than guess', () => {
    transcript(transcriptDir(path.join(tmp, 'gone')), path.join(tmp, 'gone'));
    expect(guessProjectMap(source, claudeHome)).toEqual({});
  });
});
