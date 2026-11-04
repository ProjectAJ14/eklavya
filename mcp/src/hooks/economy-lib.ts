/**
 * What the cost-control hooks share (issue #257). Light on purpose: hooks run
 * on every tool call.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeCli } from '../update.js';

/** `EKLAVYA_ECONOMY=off` turns every cost control off for one session, whatever the settings say. */
export const economyOff = (env: NodeJS.ProcessEnv = process.env): boolean => /^(off|0|false|no)$/i.test(env.EKLAVYA_ECONOMY ?? '');

/**
 * The CLI a detached fold should run: the installed runtime when there is one,
 * else the CLI built beside this hook (a development checkout).
 */
export function runtimeCliPath(installed: string = runtimeCli()): string {
  if (fs.existsSync(installed)) return installed;
  return path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'cli.js');
}
