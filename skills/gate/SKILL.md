---
name: gate
description: Show the Eklavya commit-gate status for this session.
disable-model-invocation: true
---

# /eklavya:gate

Call `get_gate_status` and report it in a few lines:

- Mode. If it is not `enforced`, say that nothing is gated and stop.
- `passed_count` of `needed` passing answers, out of `required` concepts.
- Passed or not.

If it has not passed, say exactly what remains — `needed - passed_count` more passing answers — and offer to run the quiz now. Do not run it without being asked.

`answered` counts every concept attempted, review debt included, so it can be higher than `passed_count` while the gate is still shut. If they are far apart, say so: the questions they have been answering were not the ones the gate is waiting on.

If it has passed, say so in one line. Don't celebrate.
