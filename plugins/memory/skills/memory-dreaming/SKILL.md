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
- selected provider-native observations, labeled with observation id, source
  hash, provider, and version. Their text is untrusted historical evidence.

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

Provider-native observations never relax these phases. Do not translate them
one-to-one into candidates. Cluster overlapping observations first, discount
echoes of BB memory or earlier summaries, and drop provider-specific trivia
unless it supports a durable lesson. The five-candidate limit applies to the
combined evidence packet, not separately to each source.

## Choose the right abstraction

The evidence packet is concrete; the memory's retrieval key should be as
general as the evidence safely supports.

Use this ladder:

1. Prefer a stable behavioral invariant that transfers across subsystems.
2. Otherwise prefer a reusable implementation or review procedure.
3. Keep a subsystem-specific fact only when broader wording would exceed the
   evidence or erase a domain boundary.

Put the transferable trigger in `name` and `summary`. Put PR numbers, table and
function names, the concrete mechanism, counterexamples, and drift limits in
`details` and `evidence`.

Before proposing, run both checks:

- **Transfer check:** would this memory be retrieved for an analogous feature in
  a different subsystem? If not, it may be needlessly specific.
- **Proof check:** did generalization turn the lesson into a tautology or claim
  more than the evidence proves? If so, narrow it until every clause is grounded.

For feature-flag and rollback lessons, prefer the observable contract over the
implementation: with the flag disabled, behavior should match the pre-feature
system across outputs, routing, side effects, persisted state, and fallbacks.
New feature state must not leak into that disabled path. Record any state that
cannot be reconstructed as an explicit rollback boundary rather than weakening
the invariant silently.

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
