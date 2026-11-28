// The shape-only comparison of a contract check (#16): two answers to the same
// request are compared by status, headers, key paths and value types, never by
// value. The only values compared are `resourceType` and an OperationOutcome's
// issue severities and codes, and a finding quotes nothing else.

/** One answer, as received: status, lower-cased headers, and the parsed JSON body (`undefined` when it is not JSON). */
export interface Exchange {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: unknown;
}

/**
 * How much a difference matters (#16): `fail` when the status, the media type,
 * a type or a key the hub reads differs; `warn` for a key only the sandbox
 * has, which the hub doesn't read; `info` for ordering and for keys only the
 * mock has, which the hub doesn't read.
 */
export type Severity = 'fail' | 'warn' | 'info';

/** One difference between the sandbox's and the mock's answers. `what` names shapes, never values from the bodies. */
export interface Finding {
  severity: Severity;
  /** `status`, `header <name>`, or a key path like `entry[].resource.id`. */
  where: string;
  what: string;
}

/**
 * Compares the sandbox's and the mock's answers to one request by shape.
 * `hubReads` are the key paths (arrays as `[]`) the hub reads from this
 * answer: one missing on either side is a `fail`, an extra one a `warn`/`info`.
 */
export function diffExchanges(args: { sandbox: Exchange; mock: Exchange; hubReads: readonly string[] }): Finding[] {
  const { sandbox, mock } = args;
  const hubReads = new Set(args.hubReads);
  const findings: Finding[] = [];
  if (sandbox.status !== mock.status) findings.push({ severity: 'fail', where: 'status', what: `sandbox ${sandbox.status}, mock ${mock.status}` });
  findings.push(...diffContentType(sandbox, mock), ...diffRetryAfter(sandbox, mock));
  for (const name of ['location', 'etag']) {
    const inSandbox = sandbox.headers[name] !== undefined;
    const inMock = mock.headers[name] !== undefined;
    if (inSandbox && !inMock) findings.push({ severity: 'warn', where: `header ${name}`, what: 'sandbox only' });
    if (inMock && !inSandbox) findings.push({ severity: 'info', where: `header ${name}`, what: 'mock only' });
  }
  findings.push(...diffKeys(shapeOf(sandbox.body), shapeOf(mock.body), hubReads), ...diffIssues(sandbox.body, mock.body));
  return findings;
}

function diffContentType(sandbox: Exchange, mock: Exchange): Finding[] {
  const sandboxType = sandbox.headers['content-type'] ?? 'absent';
  const mockType = mock.headers['content-type'] ?? 'absent';
  const media = (type: string) => type.split(';')[0]?.trim().toLowerCase() ?? '';
  const where = 'header content-type';
  if (media(sandboxType) !== media(mockType)) return [{ severity: 'fail', where, what: `sandbox ${media(sandboxType)}, mock ${media(mockType)}` }];
  if (sandboxType.replaceAll(' ', '').toLowerCase() !== mockType.replaceAll(' ', '').toLowerCase()) {
    return [{ severity: 'info', where, what: 'same media type, different parameters' }];
  }
  return [];
}

/** The form of a `Retry-After` header: the two RFC 9110 allows, or what else came. */
function retryAfterForm(value: string | undefined): string {
  if (value === undefined) return 'absent';
  if (/^\d+$/.test(value.trim())) return 'delta-seconds';
  return Number.isNaN(Date.parse(value)) ? 'unparseable' : 'http-date';
}

function diffRetryAfter(sandbox: Exchange, mock: Exchange): Finding[] {
  const sandboxForm = retryAfterForm(sandbox.headers['retry-after']);
  const mockForm = retryAfterForm(mock.headers['retry-after']);
  if (sandboxForm === mockForm) return [];
  // The hub reads Retry-After (#13), so any difference in it matters.
  return [{ severity: 'fail', where: 'header retry-after', what: `sandbox ${sandboxForm}, mock ${mockForm}` }];
}

/** Key path → the value types found there, in order of first appearance. `resourceType` is typed by its value. */
type Shape = Map<string, Set<string>>;

function shapeOf(body: unknown): Shape {
  const shape: Shape = new Map();
  const add = (path: string, type: string) => {
    const types = shape.get(path) ?? new Set<string>();
    types.add(type);
    shape.set(path, types);
  };
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, `${path}[]`);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = path === '' ? key : `${path}.${key}`;
      add(childPath, key === 'resourceType' && typeof child === 'string' ? child : typeOf(child));
      walk(child, childPath);
    }
  };
  walk(body, '');
  return shape;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function diffKeys(sandbox: Shape, mock: Shape, hubReads: ReadonlySet<string>): Finding[] {
  const findings: Finding[] = [];
  for (const path of new Set([...sandbox.keys(), ...mock.keys(), ...hubReads])) {
    const sandboxTypes = sandbox.get(path);
    const mockTypes = mock.get(path);
    if (sandboxTypes && mockTypes) {
      const left = [...sandboxTypes].sort().join('|');
      const right = [...mockTypes].sort().join('|');
      if (left !== right) findings.push({ severity: 'fail', where: path, what: `sandbox ${left}, mock ${right}` });
    } else if (hubReads.has(path)) {
      const side = !sandboxTypes && !mockTypes ? 'both sides' : sandboxTypes ? 'the mock' : 'the sandbox';
      findings.push({ severity: 'fail', where: path, what: `read by the hub, missing on ${side}` });
    } else if (sandboxTypes) {
      findings.push({ severity: 'warn', where: path, what: 'sandbox only, not read by the hub' });
    } else {
      findings.push({ severity: 'info', where: path, what: 'mock only, not read by the hub' });
    }
  }
  return findings;
}

/** `severity/code` of each issue of an OperationOutcome body, or null for any other body. */
function issuesOf(body: unknown): string[] | null {
  if (typeof body !== 'object' || body === null || !('resourceType' in body) || body.resourceType !== 'OperationOutcome') return null;
  const issues: unknown[] = 'issue' in body && Array.isArray(body.issue) ? body.issue : [];
  return issues.map((issue) => {
    const field = (name: string) => {
      const value: unknown = typeof issue === 'object' && issue !== null ? Reflect.get(issue, name) : undefined;
      return typeof value === 'string' ? value : '?';
    };
    return `${field('severity')}/${field('code')}`;
  });
}

function diffIssues(sandboxBody: unknown, mockBody: unknown): Finding[] {
  const sandbox = issuesOf(sandboxBody);
  const mock = issuesOf(mockBody);
  if (sandbox === null || mock === null) return [];
  if (sandbox.join() === mock.join()) return [];
  const sameSet = [...sandbox].sort().join() === [...mock].sort().join();
  return [
    sameSet
      ? { severity: 'info', where: 'issue[]', what: 'same severities and codes, another order' }
      : { severity: 'fail', where: 'issue[]', what: `sandbox ${sandbox.join(' ')}, mock ${mock.join(' ')}` },
  ];
}
