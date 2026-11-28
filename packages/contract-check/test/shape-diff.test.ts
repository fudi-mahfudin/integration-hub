import { describe, expect, it } from 'vitest';
import { diffExchanges, type Exchange } from '../src/shape-diff.js';

const json = { 'content-type': 'application/json' };

function exchange(body: unknown, overrides: Partial<Exchange> = {}): Exchange {
  return { status: 200, headers: json, body, ...overrides };
}

const severities = (findings: ReturnType<typeof diffExchanges>) => findings.map((f) => `${f.severity} ${f.where}`);

describe('diffExchanges', () => {
  it('finds nothing when both answers have the same shape, whatever their values', () => {
    const sandbox = exchange({ resourceType: 'Patient', id: 'P1', name: [{ text: 'A' }, { text: 'B' }] });
    const mock = exchange({ resourceType: 'Patient', id: 'P999', name: [{ text: 'Z' }] });
    expect(diffExchanges({ sandbox, mock, hubReads: ['id'] })).toEqual([]);
  });

  it('fails on a different status', () => {
    const findings = diffExchanges({ sandbox: exchange({}, { status: 201 }), mock: exchange({}, { status: 200 }), hubReads: [] });
    expect(findings).toEqual([{ severity: 'fail', where: 'status', what: 'sandbox 201, mock 200' }]);
  });

  it('fails on a different media type and notes only a different parameter', () => {
    const fhir = exchange({}, { headers: { 'content-type': 'application/fhir+json' } });
    expect(severities(diffExchanges({ sandbox: fhir, mock: exchange({}), hubReads: [] }))).toEqual(['fail header content-type']);
    const charset = exchange({}, { headers: { 'content-type': 'application/json; charset=utf-8' } });
    expect(severities(diffExchanges({ sandbox: charset, mock: exchange({}), hubReads: [] }))).toEqual(['info header content-type']);
  });

  it('fails when Retry-After is on one side only or in another form, since the hub reads it', () => {
    const seconds = exchange({}, { headers: { ...json, 'retry-after': '30' } });
    const date = exchange({}, { headers: { ...json, 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } });
    expect(diffExchanges({ sandbox: seconds, mock: exchange({}), hubReads: [] })).toEqual([
      { severity: 'fail', where: 'header retry-after', what: 'sandbox delta-seconds, mock absent' },
    ]);
    expect(diffExchanges({ sandbox: seconds, mock: date, hubReads: [] })).toEqual([
      { severity: 'fail', where: 'header retry-after', what: 'sandbox delta-seconds, mock http-date' },
    ]);
  });

  it('warns on a Location or ETag only the sandbox sends and notes one only the mock sends', () => {
    const withHeaders = exchange({}, { headers: { ...json, location: 'https://x/Encounter/1/_history/1', etag: 'W/"1"' } });
    expect(severities(diffExchanges({ sandbox: withHeaders, mock: exchange({}), hubReads: [] }))).toEqual([
      'warn header location',
      'warn header etag',
    ]);
    expect(severities(diffExchanges({ sandbox: exchange({}), mock: withHeaders, hubReads: [] }))).toEqual([
      'info header location',
      'info header etag',
    ]);
  });

  it('fails on a different value type at the same path', () => {
    const findings = diffExchanges({ sandbox: exchange({ expires_in: 3599 }), mock: exchange({ expires_in: '3599' }), hubReads: [] });
    expect(findings).toEqual([{ severity: 'fail', where: 'expires_in', what: 'sandbox number, mock string' }]);
  });

  it('fails on a different resourceType, which is compared by value', () => {
    const findings = diffExchanges({ sandbox: exchange({ resourceType: 'Bundle' }), mock: exchange({ resourceType: 'Patient' }), hubReads: [] });
    expect(findings).toEqual([{ severity: 'fail', where: 'resourceType', what: 'sandbox Bundle, mock Patient' }]);
  });

  it('fails when a key the hub reads is missing on either side', () => {
    const findings = diffExchanges({ sandbox: exchange({ entry: [{ resource: {} }] }), mock: exchange({ entry: [{ resource: { id: 'x' } }] }), hubReads: ['entry[].resource.id'] });
    expect(findings).toEqual([{ severity: 'fail', where: 'entry[].resource.id', what: 'read by the hub, missing on the sandbox' }]);
  });

  it('warns on a key only the sandbox has and notes a key only the mock has, when the hub does not read it', () => {
    const findings = diffExchanges({ sandbox: exchange({ id: 'a', text: { div: 'x' } }), mock: exchange({ id: 'b', extra: true }), hubReads: [] });
    expect(severities(findings)).toEqual(['warn text', 'warn text.div', 'info extra']);
  });

  it('fails on different OperationOutcome issue codes or severities, and notes the same issues in another order', () => {
    const outcome = (...issues: { severity: string; code: string }[]) => exchange({ resourceType: 'OperationOutcome', issue: issues }, { status: 400 });
    const invalid = { severity: 'error', code: 'invalid' };
    const required = { severity: 'error', code: 'required' };
    expect(diffExchanges({ sandbox: outcome(required), mock: outcome(invalid), hubReads: [] })).toEqual([
      { severity: 'fail', where: 'issue[]', what: 'sandbox error/required, mock error/invalid' },
    ]);
    expect(severities(diffExchanges({ sandbox: outcome(invalid, required), mock: outcome(required, invalid), hubReads: [] }))).toEqual(['info issue[]']);
  });

  it('compares a body that is not JSON by its absence of keys only', () => {
    const text = exchange(undefined, { headers: { 'content-type': 'text/html' } });
    expect(severities(diffExchanges({ sandbox: text, mock: exchange({ id: 'x' }), hubReads: ['id'] }))).toEqual([
      'fail header content-type',
      'fail id',
    ]);
  });
});
