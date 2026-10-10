import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { startDashboard } from '../dist/dashboard.js';
import { tempDbPath, cleanup } from './helpers.js';

const source = new URL('../../web/public/brand/mascot/', import.meta.url);
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('mascot.js', source), 'utf8'), context);
const mascot = context.EklavyaMascot;

describe('shared Archer Cloak mascot', () => {
  it('keeps learner mistakes encouraging and system errors distinct', () => {
    expect(mascot.expressionForState('tip')).toBe('wink');
    expect(mascot.expressionForState('error')).toBe('sad');
    expect(mascot.expressionForState('empty')).toBe('curious');
    expect(mascot.expressionForState('loading')).toBe('excited');
    expect(mascot.expressionForState('toString')).toBe('neutral');
    expect(mascot.svg({ expression:'__proto__' })).toContain('data-expression="neutral"');
  });

  it('escapes accessible labels and constrains user-controlled dimensions', () => {
    const svg = mascot.svg({ label:'<script>&"', size:'100" onload="alert(1)' });
    expect(svg).toContain('<title>&lt;script&gt;&amp;&quot;</title>');
    expect(svg).toContain('width="64"');
    expect(svg).not.toContain('onload');
    expect(mascot.svg()).toContain('aria-hidden="true"');
    expect(mascot.svg({ size: Infinity })).toContain('width="64"');
  });

  it('exports the exact live artwork for every expression and compact face', () => {
    for (const [expression, label] of Object.entries(mascot.expressions)) {
      for (const variant of ['body', 'face']) {
        const svg = mascot.svg({ expression, variant, size:200, label:`Eklavya, ${String(label).toLowerCase()}` });
        const exported = fs.readFileSync(new URL(`expressions/${expression}-${variant}.svg`, source), 'utf8');
        expect(exported.replace(/<style>[\s\S]*?<\/style>/, '')).toBe(svg);
        if (variant === 'face') expect(svg).not.toContain('ek-mascot__bow');
      }
    }
  });

  it('keeps standalone loading exports and token colours current', () => {
    execFileSync(process.execPath, [new URL('../../scripts/generate-mascot.mjs', import.meta.url).pathname, '--check']);
    const exported = fs.readFileSync(new URL('loading.svg', source), 'utf8');
    expect(exported).toContain('data-expression="excited"');
    expect(exported).toContain('--mascot-coral:');
    expect(exported).toContain('prefers-reduced-motion');
  });

  it('ships identical local assets and a gallery in the npm-installed dashboard', async () => {
    const file = tempDbPath('mascot');
    const previousHome = process.env.EKLAVYA_HOME;
    process.env.EKLAVYA_HOME = path.dirname(file);
    const db = openDb(file);
    const server = await startDashboard(db, { port:0 });
    try {
      for (const [route, local, type] of [
        ['/brand/mascot/mascot.js', 'mascot.js', 'text/javascript'],
        ['/brand/mascot/mascot.css', 'mascot.css', 'text/css'],
        ['/mascot.html', '../../mascot.html', 'text/html'],
      ]) {
        const response = await fetch(new URL(route, server.url));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain(type);
        expect(await response.text()).toBe(fs.readFileSync(new URL(local, source), 'utf8'));
      }
      expect((await fetch(new URL('/brand/mascot/private.txt', server.url))).status).toBe(404);
      expect((await fetch(new URL('/toString', server.url))).status).toBe(404);
      const html = await (await fetch(server.url)).text();
      expect(html).toContain('variant="loading"');
      expect(html).toContain('/brand/mascot/mascot.js');
    } finally { server.close(); db.close(); cleanup(file); if (previousHome === undefined) delete process.env.EKLAVYA_HOME; else process.env.EKLAVYA_HOME = previousHome; }
  });
});
