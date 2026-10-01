import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { droppedCount, spoolEvent, spoolPath, takeSpooled } from '../src/memory/spool.js';

/** The spool's degraded paths: every one of them must drop or defer, never throw. */

let home = '';
const origHome = process.env.EKLAVYA_HOME;
const spoolDir = () => path.dirname(spoolPath());
const dropped = () => path.join(spoolDir(), 'dropped.json');

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-spool-cov-'));
  process.env.EKLAVYA_HOME = home;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.EKLAVYA_HOME;
  else process.env.EKLAVYA_HOME = origHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('spoolEvent', () => {
  it('drops past the cap and counts every drop', () => {
    fs.mkdirSync(spoolDir(), { recursive: true });
    // A legacy claimed file counts toward the cap like a live one.
    fs.writeFileSync(`${spoolPath()}.replay-old`, 'x'.repeat(4 * 1024 * 1024 + 1));
    expect(droppedCount()).toBe(0);
    expect(spoolEvent({ n: 1 })).toBe('dropped');
    expect(spoolEvent({ n: 2 })).toBe('dropped');
    expect(droppedCount()).toBe(2);
    expect(fs.existsSync(spoolPath())).toBe(false);
  });

  it('still drops when the drop counter itself cannot be written', () => {
    fs.mkdirSync(dropped(), { recursive: true });
    fs.writeFileSync(`${spoolPath()}.taking-1`, 'x'.repeat(4 * 1024 * 1024 + 1));
    expect(spoolEvent({ n: 1 })).toBe('dropped');
    expect(droppedCount()).toBe(0);
  });

  it('reads a counter without a count as zero', () => {
    fs.mkdirSync(spoolDir(), { recursive: true });
    fs.writeFileSync(dropped(), '{}');
    expect(droppedCount()).toBe(0);
  });

  it('ignores a claimed file that vanished between listing and stat', () => {
    fs.mkdirSync(spoolDir(), { recursive: true });
    fs.symlinkSync(path.join(home, 'gone'), `${spoolPath()}.taking-dangling`);
    expect(spoolEvent({ n: 1 })).toBe('spooled');
    expect(fs.readFileSync(spoolPath(), 'utf8')).toBe('{"n":1}\n');
  });

  it('drops rather than throws when the spool directory cannot be made', () => {
    fs.writeFileSync(path.join(home, 'spool'), 'a file, not a directory');
    expect(spoolEvent({ n: 1 })).toBe('dropped');
  });
});

describe('takeSpooled', () => {
  it('returns nothing when no spool has ever been written', () => {
    const taken = takeSpooled();
    expect(taken.records).toEqual([]);
    expect(() => taken.commit()).not.toThrow();
  });

  it('returns nothing when the spool directory is unreadable as a directory', () => {
    fs.writeFileSync(path.join(home, 'spool'), 'a file, not a directory');
    expect(takeSpooled().records).toEqual([]);
  });

  it('skips a torn line and a claim that cannot be read, keeping the rest', () => {
    spoolEvent({ n: 1 });
    fs.appendFileSync(spoolPath(), '{torn\n');
    // A claim that is a directory neither blocks the live file nor is read.
    fs.mkdirSync(`${spoolPath()}.taking-dir`);
    // Nor does one that points at nothing.
    fs.symlinkSync(path.join(home, 'gone'), `${spoolPath()}.taking-dangling`);
    const taken = takeSpooled();
    expect(taken.records).toEqual([{ n: 1 }]);
    taken.commit();
    expect(fs.existsSync(`${spoolPath()}.taking-dir`)).toBe(true);
    expect(fs.readdirSync(spoolDir()).filter((n) => n.includes('.taking-') && !n.endsWith('-dir') && !n.endsWith('-dangling'))).toEqual([]);
  });

  it('commit leaves a claim it cannot remove for the next drain', () => {
    spoolEvent({ n: 1 });
    const taken = takeSpooled();
    const claim = fs.readdirSync(spoolDir()).find((n) => n.startsWith('events.jsonl.taking-'))!;
    const full = path.join(spoolDir(), claim);
    fs.rmSync(full);
    fs.mkdirSync(full);
    fs.writeFileSync(path.join(full, 'inside'), 'x');
    expect(() => taken.commit()).not.toThrow();
    expect(fs.existsSync(full)).toBe(true);
  });
});
