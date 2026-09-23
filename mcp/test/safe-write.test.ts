import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BACKUP_SUFFIX,
  UnreadableFileError,
  readJsonForUpdate,
  readJsonStrict,
  writeJsonWithBackup,
  writeWithBackup,
} from '../src/safe-write.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-safe-write-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const posix = process.platform !== 'win32';

describe('readJsonStrict', () => {
  it('tells a missing file apart from an unreadable one', () => {
    expect(readJsonStrict(path.join(dir, 'nope.json'))).toEqual({ kind: 'missing' });
  });

  it('treats an empty or whitespace-only file as missing: there is nothing to lose', () => {
    const file = path.join(dir, 'empty.json');
    fs.writeFileSync(file, '');
    expect(readJsonStrict(file).kind).toBe('missing');
    fs.writeFileSync(file, '  \n\t');
    expect(readJsonStrict(file).kind).toBe('missing');
  });

  it('reads an object, and tolerates a byte-order mark', () => {
    const file = path.join(dir, 'ok.json');
    fs.writeFileSync(file, '﻿{"a":1}');
    expect(readJsonStrict(file)).toEqual({ kind: 'ok', value: { a: 1 } });
  });

  it.each([
    ['a trailing comma', '{"a":1,}'],
    ['a comment', '// mine\n{"a":1}'],
    ['a truncated write', '{"permissions": {"allow": ["Bash'],
    ['an array', '[1,2]'],
    ['a bare string', '"hello"'],
    ['null', 'null'],
  ])('reports %s as invalid rather than as empty', (_label, text) => {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, text);
    expect(readJsonStrict(file).kind).toBe('invalid');
  });

  it('reports a directory in the file position as invalid, not missing', () => {
    const file = path.join(dir, 'actually-a-dir');
    fs.mkdirSync(file);
    expect(readJsonStrict(file).kind).toBe('invalid');
  });
});

describe('readJsonForUpdate', () => {
  it('gives {} for a missing file and the object for a good one', () => {
    const file = path.join(dir, 's.json');
    expect(readJsonForUpdate(file)).toEqual({});
    fs.writeFileSync(file, '{"x":true}');
    expect(readJsonForUpdate(file)).toEqual({ x: true });
  });

  it('throws on an unparseable file, naming the file, and leaves it byte-for-byte alone', () => {
    const file = path.join(dir, 'settings.json');
    const original = '{"permissions":{"allow":["Bash(ls)"]},}\n';
    fs.writeFileSync(file, original);
    expect(() => readJsonForUpdate(file)).toThrow(UnreadableFileError);
    expect(() => readJsonForUpdate(file)).toThrow(file);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });
});

describe('writeWithBackup', () => {
  it('creates a missing file with no backup', () => {
    const file = path.join(dir, 'nested', 'new.json');
    expect(writeWithBackup(file, 'hi\n')).toEqual({ changed: true, backup: null });
    expect(fs.readFileSync(file, 'utf8')).toBe('hi\n');
    expect(fs.existsSync(file + BACKUP_SUFFIX)).toBe(false);
  });

  it('backs up the previous bytes before changing an existing file', () => {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, 'before');
    const result = writeWithBackup(file, 'after');
    expect(result).toEqual({ changed: true, backup: file + BACKUP_SUFFIX });
    expect(fs.readFileSync(file, 'utf8')).toBe('after');
    expect(fs.readFileSync(file + BACKUP_SUFFIX, 'utf8')).toBe('before');
  });

  it('is a no-op for identical content, so a re-run never replaces a useful backup', () => {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, 'v1');
    writeWithBackup(file, 'v2');
    expect(writeWithBackup(file, 'v2')).toEqual({ changed: false, backup: null });
    expect(fs.readFileSync(file + BACKUP_SUFFIX, 'utf8')).toBe('v1');
  });

  it('keeps one rolling backup: the state just before the latest change', () => {
    const file = path.join(dir, 'f');
    fs.writeFileSync(file, 'v1');
    writeWithBackup(file, 'v2');
    writeWithBackup(file, 'v3');
    expect(fs.readFileSync(file + BACKUP_SUFFIX, 'utf8')).toBe('v2');
  });

  it('leaves no temp files behind', () => {
    const file = path.join(dir, 'f');
    fs.writeFileSync(file, 'a');
    writeWithBackup(file, 'b');
    expect(fs.readdirSync(dir).sort()).toEqual(['f', `f${BACKUP_SUFFIX}`]);
  });

  it.runIf(posix)('keeps an executable hook executable, and its backup too', () => {
    const file = path.join(dir, 'pre-commit');
    fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
    fs.chmodSync(file, 0o755);
    writeWithBackup(file, '#!/bin/sh\nexit 0\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o755);
    expect(fs.statSync(file + BACKUP_SUFFIX).mode & 0o777).toBe(0o755);
  });

  it.runIf(posix)('keeps a private file private', () => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '{}');
    fs.chmodSync(file, 0o600);
    writeWithBackup(file, '{"a":1}');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(file + BACKUP_SUFFIX).mode & 0o777).toBe(0o600);
  });

  it.runIf(posix)('honours an explicit mode for a new file regardless of umask', () => {
    const file = path.join(dir, 'secret.json');
    writeWithBackup(file, '{}', { mode: 0o600 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it.runIf(posix)('writes through a symlink instead of replacing it with a regular file', () => {
    const real = path.join(dir, 'dotfiles-settings.json');
    const link = path.join(dir, 'settings.json');
    fs.writeFileSync(real, '{"old":true}');
    fs.symlinkSync(real, link);
    writeWithBackup(link, '{"new":true}');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe('{"new":true}');
    expect(fs.readFileSync(link + BACKUP_SUFFIX, 'utf8')).toBe('{"old":true}');
  });

  it('keeps the pre-run original when one run writes the same file twice', () => {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, 'mine');
    const run = new Set<string>();
    expect(writeWithBackup(file, 'step1', { run }).backup).toBe(file + BACKUP_SUFFIX);
    expect(writeWithBackup(file, 'step2', { run }).backup).toBeNull();
    expect(fs.readFileSync(file, 'utf8')).toBe('step2');
    expect(fs.readFileSync(file + BACKUP_SUFFIX, 'utf8')).toBe('mine');
  });

  it('a file created during the run gets no backup on its second write either', () => {
    const file = path.join(dir, 'new.json');
    const run = new Set<string>();
    writeWithBackup(file, 'a', { run });
    writeWithBackup(file, 'b', { run });
    expect(fs.existsSync(file + BACKUP_SUFFIX)).toBe(false);
  });

  it('a later run backs up again, from the state the last run left', () => {
    const file = path.join(dir, 'f');
    fs.writeFileSync(file, 'v1');
    writeWithBackup(file, 'v2', { run: new Set() });
    writeWithBackup(file, 'v3', { run: new Set() });
    expect(fs.readFileSync(file + BACKUP_SUFFIX, 'utf8')).toBe('v2');
  });

  it('writeJsonWithBackup uses the house format', () => {
    const file = path.join(dir, 'x.json');
    writeJsonWithBackup(file, { a: 1 });
    expect(fs.readFileSync(file, 'utf8')).toBe('{\n  "a": 1\n}\n');
  });
});
