// Translated and adapted from microsoft/TokenEconomizer,
// tokeneconomizer/pricing.py at d3e193b8734ec76230da1e08d7929ba9d14640d8.
// Licensed under the Apache License, Version 2.0 (see ./LICENSE in this folder).
// Changes: Claude models only; the 5-minute (1.25x) and 1-hour (2x) cache
// writes are priced separately; a model with no entry is reported as
// `unpriced` instead of raising, because the fold runs detached and must fail
// open; ratios are matched by model family pattern.

import type { Usage } from './transcript.js';

/**
 * Effective tokens: a session's usage in fresh-input-token equivalents of the
 * model that served it.
 *
 * In an agent loop the conversation is re-sent every request, so most tokens
 * are cache reads billed at a tenth of fresh input, while output costs several
 * times more. A raw token total overstates cheap re-reads and understates
 * output. Weighting each part by its price ratio makes two sessions on the
 * same model comparable in what they cost. Across models the unit differs
 * (an Opus input token costs more than a Haiku one), so `eklavya cost` shows
 * the model beside every figure.
 */
export interface Weights {
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
}

/**
 * Anthropic's published ratios for current Claude models: cache read 0.1x,
 * 5-minute cache write 1.25x, 1-hour cache write 2x, output 5x of the model's
 * input price. Keyed by family pattern so a dated or suffixed id
 * (`claude-sonnet-4-5-20250929`, `claude-opus-4-6[1m]`) finds its row; a
 * model whose ratios differ gets its own row above the general one.
 */
export const MODEL_WEIGHTS: { pattern: RegExp; weights: Weights }[] = [
  {
    pattern: /^claude-(?:opus|sonnet|haiku|fable)-\d/,
    weights: { input: 1, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 },
  },
  {
    // The older naming: claude-3-5-sonnet, claude-3-haiku, claude-3-7-sonnet.
    pattern: /^claude-3(?:-\d)?-(?:opus|sonnet|haiku)/,
    weights: { input: 1, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 },
  },
];

/** A routed id (`anthropic/claude-haiku-4-5`) names a route, not a price: the tail is the model. */
const billedId = (model: string) => model.split('/').pop()!.toLowerCase();

export function weightsFor(model: string): Weights | null {
  const id = billedId(model);
  return MODEL_WEIGHTS.find((row) => row.pattern.test(id))?.weights ?? null;
}

export function effectiveTokens(u: Usage, w: Weights): number {
  return (
    u.input * w.input +
    u.cacheRead * w.cacheRead +
    u.cacheWrite5m * w.cacheWrite5m +
    u.cacheWrite1h * w.cacheWrite1h +
    u.output * w.output
  );
}

export interface Priced {
  /** Sum over the priced models. */
  effective: number;
  /** Models with usage and no price row; their tokens are not in `effective`. */
  unpriced: string[];
}

/** Prices usage split by model. A model with no tokens at all (`<synthetic>`) is skipped, not unpriced. */
export function priceByModel(byModel: Record<string, Usage>): Priced {
  let effective = 0;
  const unpriced: string[] = [];
  for (const [model, u] of Object.entries(byModel)) {
    if (u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h + u.output === 0) continue;
    const w = weightsFor(model);
    if (w) effective += effectiveTokens(u, w);
    else unpriced.push(model);
  }
  return { effective: Math.round(effective), unpriced: unpriced.sort() };
}
