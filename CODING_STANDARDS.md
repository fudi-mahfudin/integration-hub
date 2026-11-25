# Coding Standards

General rules for TypeScript services. They don't depend on a single project: decisions that only apply to one project live in that project's ADRs (`docs/adr`) and glossary (`GLOSSARY.md`), and those override this file where they disagree.

Don't restate in review what tooling already enforces (compiler, linter, formatter, CI). Everything below is checked in review.

---

## Language

Use the project's domain vocabulary in code, tests, logs, and docs. If the glossary lists a term's _Avoid_ alternatives, don't use them. One concept has one name everywhere. If a new concept has no name yet, add it to the glossary before code uses it.

Names say what a thing holds or does. A variable holding a URL is `baseUrl`, not `address`. If no honest name comes to mind, the design is probably murky. Single-letter names are only for trivial lambdas.

Don't make claims in code, comments, or docs that the system can't prove. If the system guarantees something weaker than it sounds (for example, "effect-once" rather than "exactly-once"), use the precise term.

---

## TypeScript

Keep `strict` and `noUncheckedIndexedAccess` on, and never weaken them per package. Non-null `!` and `as` casts each need a comment explaining why the value is safe. In tests, build a value of the real type or narrow with `expect`/a type guard instead of casting (`as const` is fine).

No `any`. Data crossing a boundary (HTTP body, environment, file, external API response) arrives as `unknown` and is parsed with a schema (e.g. zod) right at the boundary. Inside the boundary, code trusts the types.

Use `import type` for imports that are types only. Don't use lazy `import()` for Node built-ins or ordinary dependencies.

A primitive that stands for a domain concept (identifiers, codes, keys) gets its own type once it crosses module boundaries, so two different IDs can't be swapped by accident.

Any public function, type, or property exported from a module needs a JSDoc comment saying what it does and why it exists. Don't comment on what the code already says.

---

## Errors

Throw `Error` subclasses (or return typed result values) that callers can tell apart. Don't `throw` strings or plain objects. Error messages name the bad value and what was expected:

```ts
// BAD
throw new Error('invalid port');

// GOOD
throw new Error(`PORT must be an integer 0-65535, got "${raw}"`);
```

Never swallow an error silently. A `catch` either handles the error fully, rethrows it with more context (`{ cause }`), or logs it at the right level and says why carrying on is safe.

Separate transient failures (timeouts, 5xx, 429) from permanent ones (validation, 4xx). Only transient failures are retried, with backoff, jitter, and an attempt limit.

---

## Structure

### Composition root

Infrastructure (database pools, cache clients, HTTP servers, SDK clients) is built in one place: the composition root. The production entry point and the test harness both boot through it. Nothing else constructs infrastructure.

Configuration is read from the environment once, in one module, validated at startup, and passed down as a typed object. Defaults are chosen so a clean clone runs without a `.env`. An invalid value fails at startup with a message naming the variable.

### Module boundaries

Code belongs to one module with one reason to change. A module uses another module only through what that module exports. Never reach into another module's internals.

Don't share integration code between two adapters for different external systems, even when they look alike today, because they will diverge. Pure, system-agnostic utilities are the exception. The test: if you can't tell which external system a function is for by reading it, it's a utility.

### No speculative generality

Don't add a parameter, override, DI token, hook, or abstraction before something uses it. Delete the unused one rather than keep it "for later".

Scrutinise optional parameters closely: they cause bugs by omission. Prefer a required parameter, and prefer correctness over backwards compatibility.

### Test seams

Don't add test-only properties (`_overrideX`, `@internal`) to production types. To change behaviour in tests, inject a different dependency or configuration through the composition root, exactly as production injects its own.

---

## Data and correctness

Data access must keep transactions and locks visible at the call site: use a query builder or plain SQL, not an ORM that hides them.

A state change and the side effects it makes eligible (outbox rows, events) are written in the same transaction. Never dual-write to a database and a second system.

The database enforces uniqueness and idempotency with constraints. Check-then-insert races under concurrency; a test that passes sequentially doesn't prove it's safe.

A cache is never load-bearing. The code must stay correct if the cache loses any key at any time. Don't add a cache without a before-and-after measurement.

Wall-clock time doesn't silently change domain state. If time matters, it raises a visible flag, and a deliberate action makes the change.

### Migrations

Schema changes are versioned migrations applied by a separate one-shot command. A service never migrates itself at startup. Migrations only go forward. Once a migration is merged, it is never edited; a fix is a new migration.

---

## Testing

### Core principle

Tests verify behaviour through public interfaces, not implementation details. The code can change entirely; tests break only when behaviour changes.

```ts
// GOOD: observable behaviour through the public interface
test('a duplicate ingest returns the original result', async () => {
  const first = await post('/events', event);
  const second = await post('/events', event);
  expect(second.body).toEqual(first.body);
});

// BAD: mocks an internal collaborator and tests HOW, not WHAT
test('ingest calls repository.save', async () => {
  const save = vi.spyOn(repository, 'save');
  await ingest(event);
  expect(save).toHaveBeenCalledOnce();
});
```

Red flags:

- mocking your own modules or classes;
- testing private functions;
- asserting the count or order of internal calls;
- a test that breaks on a refactor that didn't change behaviour;
- a test name that describes HOW instead of WHAT;
- verifying through a back door (querying the database directly) instead of through the interface.

### Real dependencies, mocked boundaries

Run tests against real instances of the infrastructure you own (database, cache) in containers, locally and in CI. Don't mock them.

Mock only at system boundaries you don't own: external APIs, time, and randomness. Prefer faking the network (a local fake server) and running the real client, so the test also covers how your code drives it. Prefer SDK-style interfaces over generic fetchers at boundaries, so each call can be faked with a single return shape.

If something can't be tested without mocking internals, redesign the interface.

### Isolation

Tests don't depend on order or on data left by other tests. Each test creates its own data with unique identifiers. Tests boot the service through the production composition root, on a random port.

A concurrency claim (idempotency, exclusive claims, ordering) is proven by a concurrent test, not a sequential one.

### TDD in vertical slices

Don't write all the tests first and then all the code. That produces tests of imagined behaviour. Work one test and one implementation at a time:

```
RED → GREEN: test1 → impl1
RED → GREEN: test2 → impl2
```

Never refactor while red.

### Commitments

Pass criteria and thresholds are fixed before results exist and never loosened afterwards. When an invariant fails, fix the code, not the test. Never delete a test to make a build pass without moving its cases somewhere else.

---

## Interface design

Prefer deep modules: a small interface hiding a lot of implementation. Avoid shallow modules whose many methods just pass through. When designing, ask whether you can remove a method, simplify a parameter, or hide more inside.

Design for testability:

1. **Accept dependencies, don't create them.** Pass collaborators in.
2. **Return results, don't produce side effects** where you can.
3. **Keep the surface small.** Fewer methods and parameters mean fewer tests and simpler setup.

---

## Security and data

- No secrets in the repository or its history. Credentials come only from the environment, and example env files hold placeholders only.
- No real personal data in fixtures, seeds, or tests.
- Logs are structured, carry a correlation ID, and redact personal identifiers. Redaction is covered by a test.
- Never commit raw recordings of third-party responses that may contain credentials or personal data.

---

## Documentation

- A decision that is hard to reverse, surprising, or a real trade-off gets an ADR.
- A new domain term goes in the glossary before code uses it.
- The README keeps the clean-clone run steps working. A change that breaks them updates them in the same commit.
