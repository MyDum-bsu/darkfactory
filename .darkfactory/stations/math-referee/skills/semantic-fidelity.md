# semantic-fidelity — formulation fidelity to meaning

## Checks
1. **Quantifiers**: ∀/∃ in the formalization match the statement; swapping
   quantifiers changes the claim — this is P1, not editorial cleanup.
2. **Domain**: input types and constraints in the formalization are neither
   broader nor narrower than the statement; narrowing is weakening, widening
   is strengthening, and both are discrepancies.
3. **Premises**: every condition in the statement is present as a hypothesis;
   a lost premise makes the theorem stronger than claimed — incorrect.
4. **Vacuity**: if premises are impossible or the domain is empty, the theorem
   is vacuously true — vacuousRisk>0; referee it as a failed proof.
5. **Control goals**: explicit instances/controls from the statement must be
   derivable from the proved form — controlsPassed.

## Principle
What is proved is not "something similar" but exactly the card statement:
meaning matters more than tactics. A formulation discrepancy is a blocker
regardless of proof elegance.
