/** Totals per category for a list of `{ category, amount }` rows. */
export function summarize(rows) {
  const totals = {};
  for (const { category, amount } of rows) totals[category] = (totals[category] ?? 0) + amount;
  return totals;
}
