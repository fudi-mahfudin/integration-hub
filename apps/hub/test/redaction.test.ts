import { describe, expect, it } from 'vitest';
import { REDACTED, redact } from '../src/observability/redaction.js';

describe('redaction', () => {
  it('redacts personal data by key, at any depth', () => {
    expect(
      redact({
        patient: { nik: '9271060312000001', name: 'Budi Santoso', birthDate: '2000-12-03', gender: 'male' },
        people: [{ address: 'Jl. Fiktif 1', phone: '0812-0000-0000', patientIhsNumber: 'P02000000001' }],
        row: { birth_date: '2000-12-03', ihs_number: 'P02000000001', Mother_NIK: '9271065304765001' },
      }),
    ).toEqual({
      patient: { nik: REDACTED, name: REDACTED, birthDate: REDACTED, gender: REDACTED },
      people: [{ address: REDACTED, phone: REDACTED, patientIhsNumber: REDACTED }],
      row: { birth_date: REDACTED, ihs_number: REDACTED, Mother_NIK: REDACTED },
    });
  });

  it('keeps organization and location ids, KFA and local drug codes, remote identifiers, case ids and error codes', () => {
    const kept = {
      organizationId: '99000001',
      locationId: '77ba0b34-3f32-4c56-816f-e9af07ad4d01',
      kfaCode: '93000001',
      drugCode: 'PCT500-FFA',
      remoteId: 'c4f1a1e2-0b8e-4f7a-9d55-2f6f0f6f2a10',
      caseId: '0f1d3a9e-6a59-4b8f-8a5e-0c2f8f1c9b77',
      errorCode: 'PLATFORM_FORBIDDEN',
      step: 'create_visit',
      attempt: 3,
      api: 'fhir',
      migration: '0001_ingest',
    };
    expect(redact(kept)).toEqual(kept);
  });

  it('scrubs 16-digit runs and IHS-number shapes out of every string, whatever its key', () => {
    expect(
      redact({
        msg: 'no Patient for identifier https://fhir.kemkes.go.id/id/nik|9271060312000001',
        detail: ['subject Patient/P02000000001, performer Practitioner/10009000001', 'a run 12345678901234567 is cut too'],
      }),
    ).toEqual({
      msg: `no Patient for identifier https://fhir.kemkes.go.id/id/nik|${REDACTED}`,
      detail: [`subject Patient/${REDACTED}, performer Practitioner/${REDACTED}`, `a run ${REDACTED} is cut too`],
    });
  });

  it('drops bodies and visitId whole', () => {
    expect(
      redact({
        caseId: 'c-1',
        visitId: 'V-0001',
        body: '{"patient":{"nik":"x"}}',
        requestBody: { resourceType: 'Encounter' },
        responseBody: { resourceType: 'OperationOutcome' },
        operationOutcome: { issue: [] },
      }),
    ).toEqual({ caseId: 'c-1' });
  });

  it('logs an error as its type, scrubbed message and stack, and its cause, never its other properties', () => {
    const cause = new Error('identifier nik|9271060312000001 is unknown');
    class FailedWithFacts extends Error {
      readonly facts = { valuesUsed: { patientIhsNumber: 'P02000000001' }, note: 'Budi Santoso' };
    }
    const err = new FailedWithFacts('the attempt failed for Patient/P02000000001', { cause });
    const logged = redact({ error: err });
    expect(logged).toEqual({
      error: {
        type: 'Error',
        message: `the attempt failed for Patient/${REDACTED}`,
        stack: expect.not.stringMatching(/P02000000001/),
        cause: { type: 'Error', message: `identifier nik|${REDACTED} is unknown`, stack: expect.not.stringMatching(/\d{16}/) },
      },
    });
  });
});
