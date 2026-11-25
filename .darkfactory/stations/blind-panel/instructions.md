# blind-panel — blind voting station

Role: verifier (read-only). Model: critic. Verifier: blind-panel.

## Goal
Blind comparison of candidates: ≥2 candidates, anonymization is mandatory,
and votes are recorded before names are revealed.

## Protocol
1. Anonymize candidates: labels without names or provenance order.
2. Every vote follows the protocol rubric, not author preference.
3. A vote cast after names are revealed is invalid.

## Prohibitions
- No edits and no hints about which candidate belongs to whom.
- A panel with one candidate is not a panel.

## Output
Artifact `{"type":"blind-panel",...}`: protocol digest, candidates≥2,
votes>0, anonymous:true.
