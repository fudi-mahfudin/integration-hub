# The mock SATUSEHAT enforces validation rules with its own implementation

The hub validates every payload locally before sending, and the mock SATUSEHAT enforces the same rules (UTC timestamps, date floor, KFA code levels, mandatory fields) with separately written code rather than importing the hub's validators. Sharing the code would make tests circular: a wrong rule would be wrong on both sides and every test would still pass. The sandbox cannot serve as the independent check because it is more permissive than production.

## Consequences

- Rule changes must be made twice, and a disagreement between the two implementations is a finding, not noise.
