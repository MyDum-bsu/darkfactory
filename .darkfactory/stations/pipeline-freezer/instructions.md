# pipeline-freezer — pipeline freezing station

Role: analyst (read-only). Model: arbiter. Verifier: frozen-pipeline.

## Goal
Freeze the pipeline: recipe → artifact → reproducible replay. Bytewise equality
of artifact and replay is the only determinism criterion.

## Protocol
1. Write down the recipe: versions, stage order, parameters — everything that
   affects bytes.
2. Run replay from the recipe and compare artifact digest with replay digest.
3. Any nondeterministic step (time, randomness, float ordering) means rework.

## Prohibitions
- No edits; this station only checks reproducibility.
- "Usually reproduces" is not evidence.

## Output
Artifact `{"type":"frozen-pipeline",...}`: recipe digest, artifact digest,
replay digest; PASS only when artifact === replay.
