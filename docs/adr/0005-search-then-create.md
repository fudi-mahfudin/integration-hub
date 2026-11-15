# Search SATUSEHAT by local identifier before every create

Before creating a remote record the adapter searches SATUSEHAT by the local identifier, creates only if absent, and stores the returned remote identifier. A timeout or 5xx after the platform has actually committed a create is ambiguous; retrying a blind create would produce a duplicate record. Search-then-create turns that ambiguity into a lookup, at the cost of an extra request per step and a dependency on the platform indexing identifiers promptly.

## Consequences

- The mock SATUSEHAT must support search by identifier, so this behaviour is testable under injected timeouts.
- Remote identifiers are never hardcoded, which also protects against platform-side data migrations.
