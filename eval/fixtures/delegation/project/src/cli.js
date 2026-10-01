#!/usr/bin/env node
import fs from 'node:fs';
import { stats } from './stats.js';
import { formatReport } from './format.js';

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: textstats <file>\n');
  process.exit(2);
}
process.stdout.write(`${formatReport(stats(fs.readFileSync(file, 'utf8')))}\n`);
