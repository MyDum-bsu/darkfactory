---
name: model-prompting-guides
description: Choose the correct model-family prompt shape and write Scope Fence labels for Darkfactory cards. Use when preparing or reviewing worker intake prompts, critic prompts, or cards that pin allowed_paths.
---

# Model Prompting Guides and Scope Fence

Use this skill when a card is routed to a specific worker or critic family. The prompt profile adapts presentation only; it never weakens digest-pinned decisions, project memory, lessons, owner precheck rules, handoff typing, sandbox boundaries, or verification gates.

## Family rules

1. **Cognition / Devin** (`acp-devin/*`, `swe-*`): use a wide-and-shallow assignment. Put the complete contract at the start as the authoritative Context, name the repository reference pattern, give a short step-by-step plan, state clear verification criteria, and end with the Scope Fence. Do not hide the handoff contract inside paraphrase.
2. **DeepSeek** (`*deepseek*`): use a flat user-prompt contract. Keep instructions direct and explicit, frame complete file content with `[file content begin]` and `[file content end]`, and state scope constraints plainly rather than relying on inference.
3. **Google / Gemini** (`google/*`, `gemini*`): put specification and context first. Use the explicit transition “Based on the specification and context provided above…” and place rules plus output instructions at the end. For review prompts, role, rules, and the JSON contract must be terminal.
4. **OpenAI** (`openai/*`, `gpt-*`, `codex`): use an operator-style XML contract with `<task>`, `<structured_output_contract>`, `<default_follow_through_policy>`, `<verification_loop>`, and `<grounding_rules>`. Make follow-through, verification, and evidence grounding explicit.
5. **Anthropic / Claude** (`anthropic/*`, `claude*`): be concise and default to action. State a verification-driven goal and explicitly note that hard constraints are enforced by sandbox/gates rather than by prompt wording alone.
6. **Default or unknown**: use clean neutral English and preserve every contract input verbatim. Do not invent a family-specific structure.

## Non-negotiable preserved content

Every worker profile must preserve these blocks byte-for-byte inside the base assignment:

- digest-pinned owner decisions and project memory;
- canonical distilled lessons;
- the owner precheck and product-question rules when enabled;
- the atomic `submission.json` instructions and required field types;
- `Do not touch other threads or boards.`

Profile formatting may surround this material, but must not rewrite, reorder within, truncate, or contradict it.

## Scope Fence card checklist

Before marking a card ready, decide whether it needs `allowed_paths`.

- Omit `allowed_paths` only when unrestricted legacy scope is intentional.
- Use comma-separated relative paths; no absolute paths, backslashes, NUL bytes, empty entries, or `..` traversal.
- Use an exact file path for one file, for example `board_pipeline/intake-prompt.mjs`.
- Use a trailing slash for a directory prefix, for example `ops/control-room/`.
- Include every test, integration file, and skill/documentation file needed for the task.
- Keep the fence minimal but sufficient; do not use it as a broad substitute for a clear specification.
- Expect the trusted verifier to compute the committed diff and return rework with reason `scope_fence_violation` when any path is outside the fence.
- Incidental defects outside the fence should be reported, not fixed in the same candidate.

## Lead review checks

- The routed family was resolved from the actual executor, not from the card title or free text.
- The base assignment remains intact inside the adapted prompt.
- The critic prompt shape matches the actual critic family.
- The Scope Fence is syntactically valid and covers the approved scope exactly.
- A worker-facing fence is never treated as enforcement by itself; the deterministic verify gate is authoritative.
