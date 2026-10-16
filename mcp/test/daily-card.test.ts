import fs from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/** The engine is a plain script the dashboard loads; the tests load the same file. */
const FILE = new URL('../src/assets/daily-card.cjs', import.meta.url);
const E = createRequire(import.meta.url)('../src/assets/daily-card.cjs');

type Ranked = { id: string; score: number; why: string };
const WEEK = { answers: 0, right: 0, prev: { answers: 0, right: 0 } };
const sig = (over: Record<string, unknown> = {}) => ({
  day: '2026-10-14', // a Wednesday
  answers: 120,
  answersToday: 0,
  daysAway: 0,
  streak: { current: 5, best: 9, today: false },
  due: 0,
  upcoming: 0,
  top: null,
  lastWeek: WEEK,
  ...over,
});
const ctx = { route: 'learning/dashboard', busy: false, hidden: false };
const mem = (raw: unknown = {}) => E.normalize(raw);
const top = { slug: 'event-loop', name: 'Event loop', days: 9 };
const run = (current: number) => ({ current, best: current, today: true });
const ids = (ranked: Ranked[]) => ranked.map((r) => r.id);
const has = (ranked: Ranked[], id: string) => ranked.some((r) => r.id === id);
const scoreOf = (ranked: Ranked[], id: string) => ranked.find((r) => r.id === id)!.score;
const daysAgo = (n: number, from = '2026-10-14') => new Date(Date.parse(from + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);

describe('the module', () => {
  it('exports a frozen engine to Node, and attaches itself to the window in a page', () => {
    expect(Object.isFrozen(E)).toBe(true);
    // The same file run the way a classic script runs: no `module`, and `this` is the window.
    const win: { EklavyaDaily?: typeof E } = {};
    vm.runInNewContext(fs.readFileSync(FILE, 'utf8'), win, { filename: 'daily-card-in-a-page.js' });
    expect(Object.keys(win.EklavyaDaily!)).toEqual(Object.keys(E));
    expect(win.EklavyaDaily!.decide(sig(), mem(), ctx).show).toBe(true);
  });
});

describe('gate', () => {
  it('names the first reason nothing shows, in order', () => {
    expect(E.decide(sig({ answers: 0 }), mem({ off: true, day: '2026-10-14' }), { ...ctx, busy: true }).reason).toBe('off');
    expect(E.decide(sig({ answers: 0 }), mem({ day: '2026-10-14' }), ctx).reason).toBe('shown-today');
    expect(E.decide(sig({ answers: 0 }), mem(), { ...ctx, route: 'x' }).reason).toBe('nothing-to-say');
    expect(E.decide(sig(), mem(), { ...ctx, route: 'artifacts/view', busy: true }).reason).toBe('wrong-place');
    expect(E.decide(sig(), mem(), { ...ctx, busy: true }).reason).toBe('busy');
    expect(E.decide(sig(), mem(), { ...ctx, hidden: true }).reason).toBe('busy');
    const none = E.decide(sig({ answers: 0 }), mem({ off: true }), ctx);
    expect(none).toEqual({ show: false, id: null, why: null, reason: 'off', ranked: [] });
  });

  it('treats a stored day of today or later as shown, and an earlier one as a new day', () => {
    expect(E.decide(sig(), mem({ day: '2026-10-14' }), ctx).reason).toBe('shown-today');
    expect(E.decide(sig(), mem({ day: '2026-10-15' }), ctx).reason).toBe('shown-today'); // the clock went back, or a flight west
    const fresh = E.decide(sig(), mem({ day: '2026-10-13' }), ctx);
    expect(fresh.show).toBe(true);
    expect(fresh.reason).toBeNull();
  });
});

describe('rank: the card for a plain day', () => {
  it('falls back to the check-in when nothing else holds, and lists only true cards', () => {
    const d = E.decide(sig({ answersToday: 3 }), mem(), ctx);
    expect(d.id).toBe('checkin');
    expect(ids(d.ranked)).toEqual(['checkin']);
    expect(d.why).toBe('You are on a 5-day streak.');
    expect(E.rank(sig({ answersToday: 3, streak: run(0) }), mem())[0].why).toBe('A daily check-in.');
  });

  it('raises the check-in for a streak of three or more', () => {
    expect(scoreOf(E.rank(sig({ streak: run(2), answersToday: 3 }), mem()), 'checkin')).toBe(40);
    expect(scoreOf(E.rank(sig({ streak: run(3), answersToday: 3 }), mem()), 'checkin')).toBe(50);
  });

  it('drops the goals card once the goal is met', () => {
    expect(scoreOf(E.rank(sig({ answersToday: 2 }), mem()), 'goals')).toBe(45);
    expect(E.rank(sig({ answersToday: 2, streak: run(0) }), mem())[0].why).toBe('2 of 3 answers so far today.');
    expect(has(E.rank(sig({ answersToday: 3 }), mem()), 'goals')).toBe(false);
  });
});

describe('rank: milestones', () => {
  const at = (current: number, shown: number[] = []) => E.rank(sig({ streak: run(current) }), mem({ milestones: shown }));

  it('celebrates a milestone the day it is reached, and for two days after', () => {
    for (const n of E.MILESTONES) {
      for (const over of [0, 1, 2]) expect(ids(at(n + over)), `${n}+${over}`).toContain('milestone');
      expect(ids(at(n + 3)), `${n}+3`).not.toContain('milestone');
    }
    expect(E.MILESTONE_WINDOW).toBe(2);
    expect(ids(at(6))).not.toContain('milestone');
    expect(ids(at(0))).not.toContain('milestone');
  });

  it('wins over everything else', () => {
    const s = sig({ streak: run(14), due: 4, top, answersToday: 0, daysAway: 5, lastWeek: { ...WEEK, answers: 40 } });
    const d = E.decide(s, mem(), ctx);
    expect(d.id).toBe('milestone');
    expect(d.why).toBe('Your streak reached 14 days.');
    expect(d.ranked[0].score).toBe(100);
  });

  it('celebrates the highest milestone passed, and says which one', () => {
    const d = E.decide(sig({ streak: run(31) }), mem(), ctx);
    expect(d.why).toBe('Your streak reached 30 days.');
    const next = E.remember(mem(), d, sig({ streak: run(31) }));
    expect(next.milestones).toEqual([30]);
  });

  it('celebrates each milestone once in a run', () => {
    const s = sig({ streak: run(14) });
    const after = E.remember(mem({ milestones: [7] }), E.decide(s, mem({ milestones: [7] }), ctx), s);
    expect(after.milestones).toEqual([7, 14]);
    expect(ids(E.rank(sig({ streak: run(15) }), after))).not.toContain('milestone');
  });

  it('forgets milestones above a streak that has broken, so the next run celebrates them again', () => {
    const lapsed = sig({ streak: run(2), day: '2026-10-20' });
    const forgot = E.remember(mem({ milestones: [7, 14] }), E.decide(lapsed, mem({ milestones: [7, 14] }), ctx), lapsed);
    expect(forgot.milestones).toEqual([]);
    expect(ids(E.rank(sig({ streak: run(7) }), forgot))).toContain('milestone');
  });
});

describe('rank: welcome back', () => {
  it('shows after three days away and not before', () => {
    const away = (daysAway: number | null) => E.rank(sig({ daysAway, streak: run(0) }), mem());
    expect(E.decide(sig({ daysAway: 3, streak: run(0) }), mem(), ctx).id).toBe('comeback');
    expect(E.decide(sig({ daysAway: 3, streak: run(0) }), mem(), ctx).why).toBe('Your last answer was 3 days ago.');
    expect(has(away(2), 'comeback')).toBe(false);
    expect(has(away(null), 'comeback')).toBe(false);
    expect(has(away(0), 'comeback')).toBe(false);
    expect(E.LAPSED_DAYS).toBe(3);
  });
});

describe('rank: last week', () => {
  const week = (answers: number) => ({ answers, right: Math.floor(answers / 2), prev: { answers: 0, right: 0 } });

  it('offers last week on Monday to Wednesday, once a week', () => {
    for (const [day, shown] of [['2026-10-12', true], ['2026-10-13', true], ['2026-10-14', true], ['2026-10-15', false], ['2026-10-18', false]] as const) {
      expect(has(E.rank(sig({ day, lastWeek: week(41) }), mem()), 'weekly'), day).toBe(shown);
    }
    expect(E.WEEKLY_DAYS).toBe(3);
  });

  it('needs enough answers last week to say anything true', () => {
    expect(has(E.rank(sig({ lastWeek: week(4) }), mem()), 'weekly')).toBe(false);
    expect(has(E.rank(sig({ lastWeek: week(5) }), mem()), 'weekly')).toBe(true);
    expect(E.WEEKLY_MIN).toBe(5);
  });

  it('is remembered by ISO week, so the next week offers it again', () => {
    const s = sig({ lastWeek: week(41) });
    const d = E.decide(s, mem(), ctx);
    expect(d.id).toBe('weekly');
    expect(d.why).toBe('A new week: here is last week.');
    const after = E.remember(mem(), d, s);
    expect(after.weekly).toBe('2026-W42');
    expect(has(E.rank(sig({ day: '2026-10-13', lastWeek: week(41) }), after), 'weekly')).toBe(false);
    expect(has(E.rank(sig({ day: '2026-10-19', lastWeek: week(41) }), after), 'weekly')).toBe(true);
  });
});

describe('rank: due now', () => {
  it('scores by how late the worst concept is, capped, and says how many are due', () => {
    const score = (days: number) => scoreOf(E.rank(sig({ due: 2, top: { ...top, days } }), mem()), 'due');
    expect(score(0)).toBe(60);
    expect(score(9)).toBe(69);
    expect(score(25)).toBe(85);
    expect(score(400)).toBe(85);
    const why = (due: number) => E.rank(sig({ due, top }), mem()).find((r: Ranked) => r.id === 'due').why;
    expect(why(1)).toBe('1 concept is due for review.');
    expect(why(7)).toBe('7 concepts are due for review.');
  });

  it('needs the concept itself, not just a count', () => {
    expect(has(E.rank(sig({ due: 3, top: null }), mem()), 'due')).toBe(false);
    expect(has(E.rank(sig({ due: 0, top }), mem()), 'due')).toBe(false);
  });
});

describe('rank: the week ahead', () => {
  it('appears when something is due or scheduled, and is lifted on Mondays only', () => {
    const at = (day: string, over: Record<string, unknown> = { upcoming: 6 }) => E.rank(sig({ day, ...over }), mem()).find((r: Ranked) => r.id === 'ahead');
    expect(at('2026-10-12').score).toBe(50);
    expect(at('2026-10-12').why).toBe('Monday: the week ahead.');
    expect(at('2026-10-14').score).toBe(35);
    expect(at('2026-10-14').why).toBe('Reviews are scheduled this week.');
    expect(at('2026-10-14', { due: 2, top })).toBeDefined();
    expect(at('2026-10-14', {})).toBeUndefined();
  });
});

describe('rank: order and variety', () => {
  const idle = sig({ streak: run(0) });

  it('sorts by score, and breaks a tie by ORDER', () => {
    expect(ids(E.rank(idle, mem()))).toEqual(['goals', 'checkin']);
    // goals 45 - 15 = 30 against the check-in's 40: the check-in now leads.
    expect(ids(E.rank(idle, mem({ last: { goals: daysAgo(2) } })))).toEqual(['checkin', 'goals']);
    // due 60 - 15 = 45 ties goals at 45: the card earlier in ORDER (due) goes first.
    const exact = E.rank(sig({ streak: run(0), due: 1, top: { ...top, days: 0 } }), mem({ last: { due: daysAgo(2) } }));
    expect(scoreOf(exact, 'due')).toBe(45);
    expect(scoreOf(exact, 'goals')).toBe(45);
    expect(ids(exact)).toEqual(['due', 'goals', 'checkin', 'ahead']);
    // A Monday with a streak of three: the week ahead (35 + 15) and the check-in (40 + 10) both score 50. ORDER puts the week ahead first.
    const monday = E.rank(sig({ day: '2026-10-12', streak: run(3), answersToday: 3, upcoming: 1 }), mem());
    expect(scoreOf(monday, 'ahead')).toBe(scoreOf(monday, 'checkin'));
    expect(ids(monday)).toEqual(['ahead', 'checkin']);
  });

  it('charges a card for being shown recently, so the days vary', () => {
    const s = sig({ due: 2, top });
    const fresh = scoreOf(E.rank(s, mem()), 'due');
    const cost = (ago: number) => fresh - scoreOf(E.rank(s, mem({ last: { due: daysAgo(ago) } })), 'due');
    expect([cost(1), cost(2), cost(3), cost(4), cost(30)]).toEqual([25, 15, 8, 0, 0]);
    expect(E.REPEAT_COST).toEqual({ 1: 25, 2: 15, 3: 8 });
  });

  it('never charges for a future or malformed last-shown day', () => {
    const s = sig({ due: 2, top });
    const fresh = scoreOf(E.rank(s, mem()), 'due');
    expect(scoreOf(E.rank(s, mem({ last: { due: '2026-10-20' } })), 'due')).toBe(fresh);
    expect(scoreOf(E.rank(s, mem({ last: { due: '2026-02-31' } })), 'due')).toBe(fresh);
  });
});

describe('rank: properties over many days', () => {
  /** A small deterministic generator, so a failure names the case that broke. */
  const lcg = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const rand = lcg(20261014);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

  it('is always sorted by score, ties follow ORDER, the check-in is always there, and nothing shows twice', () => {
    for (let n = 0; n < 2000; n++) {
      const day = daysAgo(-Math.floor(rand() * 700), '2025-01-01');
      const due = pick([0, 0, 1, 4, 70]);
      const s = sig({
        day, due, top: due ? { ...top, days: pick([0, 1, 9, 30, 200]) } : null,
        upcoming: pick([0, 0, 3, 12]), answersToday: pick([0, 1, 2, 3, 9]),
        daysAway: pick([null, 0, 1, 2, 3, 10]), streak: run(pick([0, 1, 2, 3, 6, 7, 8, 13, 14, 16, 30, 33, 99, 100, 365])),
        lastWeek: { answers: pick([0, 4, 5, 30]), right: 2, prev: { answers: 5, right: 1 } },
      });
      const m = mem({ last: Object.fromEntries(E.ORDER.map((id: string) => [id, rand() < 0.4 ? daysAgo(pick([1, 2, 3, 5]), day) : undefined]).filter(([, v]: [string, unknown]) => v)), milestones: pick([[], [7], [7, 14], [30]]), weekly: pick([null, E.weekKey(day)]) });
      const ranked: Ranked[] = E.rank(s, m);
      const label = JSON.stringify({ s, m });
      expect(ids(ranked), label).toContain('checkin');
      expect(new Set(ids(ranked)).size, label).toBe(ranked.length);
      for (let i = 1; i < ranked.length; i++) {
        const [a, b] = [ranked[i - 1], ranked[i]];
        expect(a.score >= b.score, label).toBe(true);
        if (a.score === b.score) expect(E.ORDER.indexOf(a.id) < E.ORDER.indexOf(b.id), label).toBe(true);
      }
      const d = E.decide(s, m, ctx);
      expect(d.id, label).toBe(ranked[0].id);
      const after = E.remember(m, d, s);
      expect(E.decide(s, after, ctx).reason, label).toBe('shown-today');
      expect(E.normalize(JSON.parse(JSON.stringify(after))), label).toEqual(after);
    }
  });
});

describe('remember', () => {
  it('stores the day and the card without touching its input', () => {
    const m = mem();
    const s = sig({ streak: run(2) });
    const d = E.decide(s, m, ctx);
    const next = E.remember(m, d, s);
    expect(next.day).toBe('2026-10-14');
    expect(next.last[d.id]).toBe('2026-10-14');
    expect(m.day).toBeNull();
    expect(m.last).toEqual({});
  });

  it('returns the very same memory when nothing was shown', () => {
    const m = mem();
    expect(E.remember(m, { show: false }, sig())).toBe(m);
  });

  it('keeps the last-shown day of every other card', () => {
    const m = mem({ last: { due: '2026-10-12' } });
    const s = sig({ answersToday: 3, streak: run(2) });
    const next = E.remember(m, E.decide(s, m, ctx), s);
    expect(next.last).toEqual({ due: '2026-10-12', checkin: '2026-10-14' });
  });
});

describe('normalize', () => {
  const empty = { off: false, day: null, last: {}, said: {}, milestones: [], weekly: null };

  it('turns anything unreadable into the empty memory', () => {
    for (const raw of [null, undefined, 'x', 7, true, [], { day: 'yesterday', last: 'no', said: 3, milestones: 'all', weekly: 5, off: 'yes' }]) {
      expect(E.normalize(raw)).toEqual(empty);
    }
  });

  it('keeps what is valid and drops the rest', () => {
    const m = E.normalize({ off: true, day: '2026-10-13', last: { due: '2026-10-12', nope: '2026-10-12', goals: 'x', ahead: '2026-02-31' }, said: { short: 2, long: -1, odd: 1.5, str: '1' }, milestones: [7, 8, 14], weekly: '2026-W41' });
    expect(m).toEqual({ off: true, day: '2026-10-13', last: { due: '2026-10-12' }, said: { short: 2 }, milestones: [7, 14], weekly: '2026-W41' });
  });

  it('rejects days that are shaped right and are not dates', () => {
    for (const day of ['2026-02-31', '2026-13-01', '2026-00-10', '2026-1-1', '20261014', '']) expect(E.normalize({ day }).day, day).toBeNull();
    expect(E.normalize({ day: '2028-02-29' }).day).toBe('2028-02-29');
  });
});

describe('dates', () => {
  it('names ISO weeks across a year boundary', () => {
    expect(E.weekKey('2026-01-01')).toBe('2026-W01');
    expect(E.weekKey('2024-12-30')).toBe('2025-W01');
    expect(E.weekKey('2021-01-03')).toBe('2020-W53');
    expect(E.weekKey('2026-10-14')).toBe('2026-W42');
    expect(E.weekKey('2026-10-18')).toBe('2026-W42');
    expect(E.weekKey('2026-10-19')).toBe('2026-W43');
  });

  it('counts whole days, across a month and a daylight-saving change', () => {
    expect(E.daysBetween('2026-02-27', '2026-03-02')).toBe(3);
    expect(E.daysBetween('2026-03-28', '2026-03-30')).toBe(2);
    expect(E.daysBetween('2026-10-14', '2026-10-14')).toBe(0);
    expect(E.daysBetween('2026-10-14', '2026-10-10')).toBe(-4);
  });

  it('numbers weekdays from Monday', () => {
    expect(E.weekday('2026-10-12')).toBe(0);
    expect(E.weekday('2026-10-18')).toBe(6);
  });
});

describe('streak line', () => {
  it('only claims streaks that are true, from the right pool', () => {
    expect(E.streakLine(0, mem(), () => 0.5).text).not.toMatch(/\d/);
    expect(E.streakLine(3, mem(), () => 0.99).text).toBe('3 days so far. Small steps add up.');
    expect(E.streakLine(3, mem(), () => 0.5).text).toBe('Good work. Come back tomorrow and make it 4.');
    expect(E.streakLine(6, mem(), () => 0).text).toBe('6 days in a row. Nice start, keep going.');
    expect(E.streakLine(12, mem(), () => 0).text).toBe('You are doing great. A 12-day streak is really good.');
    expect(E.streakLine(12, mem(), () => 1).text).toBe('Keep going. 12 days and the concepts are sticking.');
  });

  it('puts every pool boundary on the right side', () => {
    const pool = (n: number) => E.streakLine(n, mem(), () => 0).text;
    expect(pool(0)).toBe('Every streak starts with one answer. Ready when you are.');
    expect(pool(1)).toMatch(/^1 days? in a row/);
    expect(pool(6)).toMatch(/^6 days/);
    expect(pool(7)).toContain('7-day streak');
  });

  it('never repeats the line it said last, in any pool, whatever the dice say', () => {
    for (const streak of [0, 3, 12]) {
      for (const dice of [0, 0.3, 0.7, 0.999, 1]) {
        let m = mem();
        let previous = '';
        for (let i = 0; i < 12; i++) {
          const r = E.streakLine(streak, m, () => dice);
          expect(r.text, `${streak}/${dice}/${i}`).not.toBe(previous);
          previous = r.text;
          m = r.mem;
        }
      }
    }
  });

  it('keeps each pool apart, and does not touch the memory it was given', () => {
    const m = mem();
    const a = E.streakLine(12, m, () => 0);
    expect(m.said).toEqual({});
    expect(a.mem.said).toEqual({ long: 0 });
    const b = E.streakLine(3, a.mem, () => 0);
    expect(b.mem.said).toEqual({ long: 0, short: 0 });
    expect(E.streakLine(12, b.mem, () => 0).text).not.toBe(a.text);
  });
});

describe('greeting', () => {
  it('has words for every card, and states the streak only when there is a run', () => {
    expect(E.ORDER).toHaveLength(7);
    for (const id of E.ORDER) expect(E.greeting(id, sig({ due: 2, streak: run(14) })).length, id).toBeGreaterThan(5);
    expect(E.greeting('milestone', sig({ streak: run(14) }))).toBe('14 days. That is a real habit now.');
    expect(E.greeting('due', sig({ due: 1 }))).toBe('One concept needs you today.');
    expect(E.greeting('due', sig({ due: 9 }))).toBe('A few concepts need you today.');
    expect(E.greeting('checkin', sig({ streak: run(12) }))).toBe('Welcome back. 12 days in a row.');
    expect(E.greeting('checkin', sig({ streak: run(1) }))).toBe('Welcome back.');
    expect(E.greeting('weekly', sig())).toBe('Here is how last week went.');
  });

  it('gives every card a face the mascot knows', () => {
    const mascot: { EklavyaMascot?: { states: Record<string, string> } } = {};
    vm.runInNewContext(fs.readFileSync(new URL('../../web/public/brand/mascot/mascot.js', import.meta.url), 'utf8'), { self: mascot, window: mascot, globalThis: mascot });
    const known = Object.keys(mascot.EklavyaMascot?.states ?? {});
    expect(known.length).toBeGreaterThan(5);
    for (const id of E.ORDER) expect(known, id).toContain(E.MOOD[id]);
    for (const id of E.ORDER) expect(typeof E.MOOD[id], id).toBe('string');
    expect(Object.keys(E.MOOD).sort()).toEqual([...E.ORDER].sort());
  });
});

describe('a year of days', () => {
  /** A learner who answers most days, lapses now and then, and always has something scheduled. */
  function simulate(opts: { lapseEvery: number; due: (i: number) => boolean }) {
    let m = mem();
    const shown: string[] = [];
    const celebrated: Array<{ i: number; n: number }> = [];
    let streak = 0;
    for (let i = 0; i < 365; i++) {
      const day = daysAgo(-i, '2026-01-01');
      const away = i % opts.lapseEvery === opts.lapseEvery - 1 ? 4 : 0;
      streak = away ? 0 : streak + 1;
      const due = opts.due(i);
      const s = sig({ day, daysAway: away, streak: { current: streak, best: streak, today: false }, due: due ? 3 : 0, top: due ? top : null, upcoming: 2, lastWeek: { answers: 12, right: 9, prev: { answers: 12, right: 8 } }, answersToday: i % 4 });
      const d = E.decide(s, m, ctx);
      expect(d.show).toBe(true);
      expect(d.ranked.length).toBeGreaterThan(0);
      m = E.remember(m, d, s);
      expect(E.decide(s, m, ctx).reason, day).toBe('shown-today');
      shown.push(d.id);
      if (d.id === 'milestone') celebrated.push({ i, n: Number(d.why.match(/\d+/)![0]) });
    }
    return { shown, celebrated };
  }

  it('shows exactly one card a day, never celebrates a milestone twice in a run, and varies the cards', () => {
    const { shown, celebrated } = simulate({ lapseEvery: 40, due: (i) => i % 3 === 0 });
    expect(shown).toHaveLength(365);
    // Runs are 39 days long; within one run no milestone repeats.
    for (let run = 0; run < 9; run++) {
      const inRun = celebrated.filter((c) => Math.floor(c.i / 40) === run).map((c) => c.n);
      expect(new Set(inRun).size, `run ${run}`).toBe(inRun.length);
    }
    // Each new run celebrates 7, 14 and 30 again.
    expect(celebrated.filter((c) => c.n === 7).length).toBeGreaterThanOrEqual(8);
    expect(new Set(shown).size).toBeGreaterThanOrEqual(5);
    expect(shown.filter((id, i) => i > 0 && id === shown[i - 1]).length).toBeLessThan(shown.length * 0.15);
  });

  it('shows the weekly recap at most once a week', () => {
    const { shown } = simulate({ lapseEvery: 1000, due: () => false });
    expect(shown.filter((id) => id === 'weekly').length).toBeLessThanOrEqual(53);
    expect(shown.filter((id) => id === 'weekly').length).toBeGreaterThan(40);
  });

  it('lets an overdue backlog lead without owning every day', () => {
    const { shown } = simulate({ lapseEvery: 1000, due: () => true });
    const due = shown.filter((id) => id === 'due').length;
    expect(due).toBeGreaterThan(60);
    expect(due).toBeLessThan(shown.length * 0.6);
  });

  it('decides in well under a millisecond', () => {
    const s = sig({ due: 4, top, upcoming: 3, lastWeek: { answers: 20, right: 15, prev: { answers: 20, right: 12 } } });
    const m = mem({ last: { due: '2026-10-13' } });
    const t0 = performance.now();
    for (let i = 0; i < 20000; i++) E.decide(s, m, ctx);
    expect((performance.now() - t0) / 20000).toBeLessThan(0.05);
  });
});
