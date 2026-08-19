---
name: memory-dreaming
description: Use after a PR, substantial implementation, or review cycle has concrete evidence to synthesize reusable candidate memories, adversarially challenge them, and submit them for workspace-owner promotion.
---

# Memory dreaming

Load this skill only after implementation/review evidence exists. Do not load
it during product discovery or design merely because later learning is likely.

The goal is not to summarize a PR. The goal is to extract a very small number
of future-useful lessons that survive inspection and can be retrieved at the
right phase. All outputs remain candidates until the workspace owner approves
them in Settings → Memory.

## Inputs

Build an evidence packet from the narrowest authoritative artifacts available:

- accepted code diff and final behavior;
- reviewer comments plus their resolution or explicit non-action;
- tests, runtime observations, and verification evidence;
- relevant repository policy or current source that constrains the lesson.

Do not treat a reviewer comment, model critique, or merged change as truth by
itself. Record the disposition: acted on after inspection, preference adopted
without correctness harm, rejected with reason, or still unresolved.

## Dreaming phases

1. **Synthesize.** Generate at most five candidate lessons. Prefer stable
   invariants, adopted maintainer conventions, validated heuristics, reusable
   procedures, or high-value failure episodes. Avoid transient task status.
2. **Ground.** Link every candidate to concrete evidence. Narrow claims to what
   the evidence proves and identify likely drift conditions.
3. **Challenge.** Try to refute each candidate with current source,
   counterexamples, nearby tests, conflicting review feedback, and alternate
   explanations. Attach material challenges with `bb memory challenge`.
4. **Curate.** Drop duplicates, tautologies, restated repository policy, and
   lessons that are cheap to rediscover. A reviewer preference is eligible only
   when it does not harm correctness, security, performance, or explicit user
   goals.
5. **Propose.** Submit surviving items with `bb memory propose`. Use project
   scope unless the evidence clearly supports a cross-project user preference
   or operating convention.
6. **Stop for review.** Report candidate IDs, evidence, counterevidence, and
   unresolved risk. Never approve, reject, edit, or delete active memory from
   an agent path.

## Candidate command

```bash
bb memory propose --scope project \
  --name <stable-retrieval-key> \
  --summary "<when this lesson should be retrieved>" \
  --details "<claim, scope, rationale, caveats, and drift triggers>" \
  --kind fact|preference|decision|procedure|episode|reference \
  --tag pr-learning \
  --evidence "<authoritative artifact 1>" \
  --evidence "<authoritative artifact 2>" \
  --reason "Synthesized from inspected PR and review evidence" \
  --json
```

## Output contract

Return:

- evidence packet boundaries;
- proposed candidate IDs and classifications;
- challenges attached or candidates dropped;
- open testability or drift risks;
- the explicit statement that workspace-owner promotion is still pending.

Do not report the active catalog as changed until an owner decision receipt
exists and `bb memory get <promoted-memory-id>` succeeds.
