/**
 * Local semantic vectors (ADR-03).
 *
 * `local-hash-v1` is a dependency-free hashed bag of tokens and character
 * 4-grams, L2-normalised, compared by cosine. The n-grams are what make it more
 * than keyword matching: `migrations`, `migration` and `migrating` land in
 * overlapping buckets, and so do typos. It does *not* know that `cookie` and
 * `session token` are related — that needs a trained model, and the manual says
 * so rather than calling this neural parity.
 *
 * Every vector stores the embedder that produced it, because comparing a
 * hashed vector with a provider embedding is meaningless arithmetic.
 */

export const LOCAL_EMBEDDER = 'local-hash-v1';
export const LOCAL_DIM = 256;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 1);
}

export function embedLocal(text: string, dim = LOCAL_DIM): Float32Array {
  const vec = new Float32Array(dim);
  const tokens = tokenize(text);
  for (const token of tokens) {
    vec[fnv1a(token) % dim]! += 1;
    // Character n-grams, weighted lower: they generalise over morphology but
    // are noisier than the whole token, so they should not outvote it.
    const padded = `^${token}$`;
    for (let i = 0; i + 4 <= padded.length; i++) {
      vec[fnv1a(padded.slice(i, i + 4)) % dim]! += 0.35;
    }
  }
  // Sublinear damping, as TF-IDF does: a word repeated twenty times is not
  // twenty times more about the document than a word used once. `log1p` rather
  // than `1 + log`, which goes negative below 1 -- a single n-gram hit weighs
  // 0.35, and a negative weight makes two related documents score as opposites.
  for (let i = 0; i < dim; i++) {
    const v = vec[i]!;
    if (v > 0) vec[i] = Math.log1p(v);
  }
  return normalise(vec);
}

export function normalise(vec: Float32Array): Float32Array {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm;
  return vec;
}

/** Both arguments must already be normalised, which `embedLocal` guarantees. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}

export function toBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function fromBlob(blob: Buffer): Float32Array {
  // Copy rather than view: better-sqlite3's buffer is not guaranteed aligned
  // for Float32Array, and an unaligned view throws.
  const copy = Buffer.from(blob);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}
