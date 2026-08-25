/**
 * Concept slugs are the join key across the whole system, and the LLM is allowed
 * to mint new ones (PRD §8 tool 6). Normalizing hard here is what keeps slug
 * sprawl from turning the graph into mush (PRD §15).
 */
export function normalizeSlug(input: string): string {
  return input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 80);
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) && slug.length <= 80;
}
