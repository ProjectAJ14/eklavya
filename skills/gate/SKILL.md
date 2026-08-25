---
name: gate
description: Show the Eklavya commit-gate status for this session.
disable-model-invocation: true
---

# /eklavya:gate

Call `get_gate_status` and report it in a few lines:

- Mode. If it is not `enforced`, say that nothing is gated and stop.
- `answered` of `required` concepts, and the `pass_threshold` they need to clear.
- Passed or not.

If it has not passed, say exactly what remains and offer to run the quiz now. Do not run it without being asked.

If it has passed, say so in one line. Don't celebrate.
