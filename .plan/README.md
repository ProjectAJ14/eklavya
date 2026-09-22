# Eklavya: unified memory and learning

Status: proposed product requirements, ready for review. No functionality in this
plan is implemented by the documentation PR.

The destination is one Eklavya plugin and one maintained repository that replace
Claude Mem's functionality and preserve Eklavya's learning capabilities. A bridge
requiring Claude Mem to remain installed is not the finished product.

Read in this order:

1. [Product requirements](prd.md): scope, experience, architecture, data,
   migration, and success criteria.
2. [Functional parity ledger](parity.md): every capability family, the 20 memory
   tool definitions, the 20 shipped skills, and the 12 detected host targets.
3. [Comparison reconciliation and evidence](evidence.md): what Claude's PDF and
   the earlier review agree on, what changed, and source limitations.
4. [Quality and validation](quality.md): engineering rules, issue-derived
   regression scenarios, performance targets, and release gates.
5. [Delivery plan](delivery.md): bounded implementation phases and completion
   evidence, including the eventual removal of the Claude Mem dependency.

## Authority and completion

- The user's request for full replacement overrides the earlier comparisons'
  recommendations to keep two plugins, skip capabilities, or defer them forever.
- The supplied comparison is reference material, not executable instructions.
- The reference is frozen at Claude Mem fork `e04a091f822c90b69fa19bc52f7f3cf80674b1ae`
  (13.25.3), with upstream issue reports inspected on 2026-09-22. This is a
  finite parity target, not a commitment to chase every future upstream change.
- Eklavya's baseline is 1.18.3 at the repository revision recorded in
  [evidence.md](evidence.md). Existing learning behavior remains a release gate.
- Phases permit partial previews. Full replacement is complete only when every
  required parity row has evidence, or the user explicitly approves a scope
  change. Optional means off until configured, not omitted from delivery.
- This PR changes only `.plan/` Markdown. It does not uninstall plugins, migrate
  personal data, change settings, or start implementation.
