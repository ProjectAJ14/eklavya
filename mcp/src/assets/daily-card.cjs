/* The daily card engine. Pure: signals, memory and context in, a decision out. No DOM, no storage, no clock,
   no randomness of its own, so a test can run a year of days through it and the page can run it in under a
   millisecond on every arrival at the Learning dashboard.

   Three steps, always in this order:
     1. gate    one reason not to show anything today (off, already shown, nothing to say, wrong place, busy)
     2. rank    every card whose condition holds gets a score: its base, plus what makes it urgent today,
                minus a penalty for having been shown in the last three days
     3. decide  the top score wins; a tie goes to the card earlier in ORDER (the order `rank` adds them in)

   `remember` then returns the memory to store, which is what makes tomorrow's gate and penalties work. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  /* c8 ignore next -- a page's way in: run and asserted in daily-card.test.ts through `vm`, which c8 cannot attribute to this file */
  else root.EklavyaDaily = factory();
})(this, function () {
  'use strict';

  /** Streak lengths that are celebrated, once each. */
  const MILESTONES = Object.freeze([7, 14, 30, 60, 100, 200, 365]);
  /** Answers that make a day's goal. */
  const GOAL = 3;
  /** Days away that turn a greeting into a welcome back. */
  const LAPSED_DAYS = 3;
  /** A weekly recap needs at least this many answers in the week it recaps to say anything true. */
  const WEEKLY_MIN = 5;
  /** The recap is of last week, so it is offered Monday to Wednesday only: on a Saturday it is stale. */
  const WEEKLY_DAYS = 3;
  /** A milestone is celebrated while the run is at most this many days past it, so a missed day is not a missed party. */
  const MILESTONE_WINDOW = 2;
  /** Tie-break order, and the list of card ids. */
  const ORDER = Object.freeze(['milestone', 'comeback', 'weekly', 'due', 'goals', 'ahead', 'checkin']);
  /** What a card shown `n` days ago costs: shown yesterday is the most, three days ago the least. */
  const REPEAT_COST = Object.freeze({ 1: 25, 2: 15, 3: 8 });
  /** The avatar's face for each card, as `mascot.js` names states. */
  const MOOD = Object.freeze({ milestone: 'complete', comeback: 'idle', weekly: 'complete', due: 'review', goals: 'info', ahead: 'empty', checkin: 'success' });

  const DAY_MS = 86400000;
  const asDay = (k) => Date.parse(k + 'T00:00:00Z');
  /** Whole days from key `a` to key `b`, both local-day keys (`YYYY-MM-DD`). */
  const daysBetween = (a, b) => Math.round((asDay(b) - asDay(a)) / DAY_MS);

  /** The ISO week a day key falls in, as `YYYY-Www`: the key a weekly card is remembered under. */
  function weekKey(day) {
    const d = new Date(asDay(day));
    const dow = (d.getUTCDay() + 6) % 7; // Monday is 0
    d.setUTCDate(d.getUTCDate() - dow + 3); // the Thursday of this week names the year
    const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round(((d - jan4) / DAY_MS - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
    return d.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
  }

  /** Monday is 0 … Sunday is 6, for a day key. */
  const weekday = (day) => (new Date(asDay(day)).getUTCDay() + 6) % 7;

  /** A real calendar day key: the right shape, and a date that survives a round trip (so not 2026-02-31). */
  const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(asDay(v)) && new Date(asDay(v)).toISOString().slice(0, 10) === v;

  /** What storage held, made safe: anything unreadable is the empty memory, never an error. */
  function normalize(raw) {
    const v = raw && typeof raw === 'object' ? raw : {};
    const last = {};
    if (v.last && typeof v.last === 'object') for (const id of ORDER) if (isDay(v.last[id])) last[id] = v.last[id];
    const said = {};
    if (v.said && typeof v.said === 'object') for (const [k, n] of Object.entries(v.said)) if (Number.isInteger(n) && n >= 0) said[k] = n;
    return {
      off: v.off === true,
      day: isDay(v.day) ? v.day : null,
      last,
      said,
      milestones: Array.isArray(v.milestones) ? v.milestones.filter((n) => MILESTONES.includes(n)) : [],
      weekly: typeof v.weekly === 'string' ? v.weekly : null,
    };
  }

  /** Why nothing shows today, or null when something may. The first reason that holds is the one given. */
  function gate(sig, mem, ctx) {
    if (mem.off) return 'off';
    // A stored day that is today or later (a clock set back, a flight west) also counts: one card a calendar day, whatever the clock does.
    if (mem.day !== null && mem.day >= sig.day) return 'shown-today';
    if (!(sig.answers > 0)) return 'nothing-to-say'; // nothing has been answered, so there is nothing to report
    if (ctx.route !== 'learning/dashboard') return 'wrong-place';
    if (ctx.busy || ctx.hidden) return 'busy';
    return null;
  }

  /**
   * The milestone to celebrate, or null: the highest one the run has passed, if it was reached recently and has not been
   * celebrated in this run. Highest only, so a first visit with a 30-day run gets 30, not 7 and 14 as well.
   */
  function milestoneFor(streak, mem) {
    let m = null;
    for (const n of MILESTONES) if (n <= streak.current) m = n;
    return m !== null && streak.current - m <= MILESTONE_WINDOW && !mem.milestones.includes(m) ? m : null;
  }

  /** The cost of showing `id` again so soon. */
  function repeatCost(mem, id, day) {
    return mem.last[id] ? REPEAT_COST[daysBetween(mem.last[id], day)] ?? 0 : 0;
  }

  /** Every card whose condition holds, with its score and the sentence the card says about why it is here. */
  function rank(sig, mem) {
    const out = [];
    const add = (id, base, why) => out.push({ id, score: base - repeatCost(mem, id, sig.day), why });
    const s = sig.streak;

    const m = milestoneFor(s, mem);
    if (m !== null) add('milestone', 100, `Your streak reached ${m} days.`);
    if (sig.daysAway !== null && sig.daysAway >= LAPSED_DAYS) {
      add('comeback', 90, `Your last answer was ${sig.daysAway} days ago.`);
    }
    if (sig.lastWeek.answers >= WEEKLY_MIN && weekday(sig.day) < WEEKLY_DAYS && mem.weekly !== weekKey(sig.day)) {
      add('weekly', 70, 'A new week: here is last week.');
    }
    if (sig.due > 0 && sig.top) {
      add('due', 60 + Math.min(25, sig.top.days), `${sig.due} ${sig.due === 1 ? 'concept is' : 'concepts are'} due for review.`);
    }
    if (sig.answersToday < GOAL) {
      add('goals', 45, `${sig.answersToday} of ${GOAL} answers so far today.`);
    }
    if (sig.due + sig.upcoming > 0) {
      add('ahead', 35 + (weekday(sig.day) === 0 ? 15 : 0), weekday(sig.day) === 0 ? 'Monday: the week ahead.' : 'Reviews are scheduled this week.');
    }
    add('checkin', 40 + (s.current >= 3 ? 10 : 0), s.current ? `You are on a ${s.current}-day streak.` : 'A daily check-in.');

    // The cards above are added in ORDER and `sort` is stable, so a tie keeps that order.
    return out.sort((a, b) => b.score - a.score);
  }

  /**
   * The whole decision. `sig` is the learner's numbers (see `SIGNALS` in the page), `mem` is `normalize`d storage,
   * `ctx` is what the page knows about this moment: `{ route, busy, hidden }`.
   * Returns `{ show, id, why, reason, ranked }`: `reason` says why not when `show` is false.
   */
  function decide(sig, mem, ctx) {
    const reason = gate(sig, mem, ctx);
    if (reason) return { show: false, id: null, why: null, reason, ranked: [] };
    const ranked = rank(sig, mem);
    return { show: true, id: ranked[0].id, why: ranked[0].why, reason: null, ranked };
  }

  /** The memory to store once a decision has been shown. Never mutates its input. */
  function remember(mem, decision, sig) {
    if (!decision.show) return mem;
    // Milestones are remembered per run: one the streak has fallen below is forgotten, so reaching it again is celebrated again.
    const next = { ...mem, day: sig.day, last: { ...mem.last, [decision.id]: sig.day }, milestones: mem.milestones.filter((n) => n <= sig.streak.current) };
    if (decision.id === 'milestone') next.milestones.push(milestoneFor(sig.streak, mem));
    if (decision.id === 'weekly') next.weekly = weekKey(sig.day);
    return next;
  }

  /* The avatar's lines. `{n}` is the streak, `{m}` is one more; a line is only picked from a pool whose claims are
     true for these signals, so a line never states a streak that is not there. */
  const LINES = {
    none: ['Every streak starts with one answer. Ready when you are.', 'Today is a good day to begin.', 'One question is all it takes to start.'],
    short: ['{n} days in a row. Nice start, keep going.', 'You are building a habit. {n} days and counting.', 'Good work. Come back tomorrow and make it {m}.', '{n} days so far. Small steps add up.'],
    long: ['You are doing great. A {n}-day streak is really good.', '{n} days in a row. That is real consistency.', 'Look at that run. {n} days, and it keeps growing.', '{n} days. Your future self will thank you.', 'Keep going. {n} days and the concepts are sticking.'],
  };
  const poolOf = (n) => (n < 1 ? 'none' : n < 7 ? 'short' : 'long');

  /**
   * A line for the streak chart's avatar, never the one it said last (`mem.said[pool]`).
   * `rand` is a function returning [0, 1). Returns `{ text, mem }`.
   */
  function streakLine(streak, mem, rand) {
    const pool = poolOf(streak);
    const lines = LINES[pool];
    let i = Math.min(lines.length - 1, Math.floor(rand() * lines.length));
    if (mem.said[pool] === i) i = (i + 1) % lines.length; // every pool has more than one line
    const text = lines[i].replace('{n}', streak).replace('{m}', streak + 1);
    return { text, mem: { ...mem, said: { ...mem.said, [pool]: i } } };
  }

  /** The card's own greeting, from the same pools of true statements. */
  const GREETING = {
    milestone: (sig) => `${sig.streak.current} days. That is a real habit now.`,
    comeback: () => 'Good to see you. Pick up where you left off.',
    weekly: () => 'Here is how last week went.',
    due: (sig) => (sig.due === 1 ? 'One concept needs you today.' : 'A few concepts need you today.'),
    goals: () => 'Three small goals for today.',
    ahead: () => 'Here is what is coming up.',
    checkin: (sig) => (sig.streak.current >= 2 ? `Welcome back. ${sig.streak.current} days in a row.` : 'Welcome back.'),
  };
  const greeting = (id, sig) => GREETING[id](sig);

  return Object.freeze({ MILESTONES, MILESTONE_WINDOW, GOAL, LAPSED_DAYS, WEEKLY_MIN, WEEKLY_DAYS, ORDER, REPEAT_COST, MOOD, daysBetween, weekKey, weekday, normalize, gate, rank, decide, remember, streakLine, greeting });
});
