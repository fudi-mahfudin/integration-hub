import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  accessToken,
  bootMock,
  createdId,
  encounter,
  fhir,
  medicationDispense,
  medicationRequest,
  type BootedMock,
} from './support/boot-mock.js';

const PRESCRIPTION_SYSTEM = 'http://sys-ids.kemkes.go.id/prescription/99000001';

describe('MedicationDispense create and search', () => {
  let mock: BootedMock;
  let token: string;

  beforeAll(async () => {
    mock = await bootMock();
  });
  afterAll(async () => mock?.close());
  beforeEach(async () => {
    await mock.client.reset();
    token = await accessToken(mock.baseUrl);
  });

  /** An Encounter for `visitKey` and a MedicationRequest on it for `prescriptionId`, both held by the mock. */
  async function prescribed(visitKey: string, prescriptionId: string) {
    const encounterId = await createdId(await fhir(mock.baseUrl, token, 'Encounter', encounter(visitKey)));
    const medicationRequestId = await createdId(await fhir(mock.baseUrl, token, 'MedicationRequest', medicationRequest(encounterId, prescriptionId)));
    return { encounterId, medicationRequestId };
  }

  it('stores a valid dispense of a held prescription, logged under its visit and prescription identifier, in order', async () => {
    const { encounterId, medicationRequestId } = await prescribed('V-dispense', 'RX-1');
    const body = medicationDispense(encounterId, medicationRequestId, 'RX-1');

    const res = await fhir(mock.baseUrl, token, 'MedicationDispense', body);

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      ...body,
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      meta: { versionId: '1', lastUpdated: expect.any(String) },
    });
    const [entry] = await mock.client.log({ resourceType: 'MedicationDispense' });
    expect(entry).toMatchObject({ method: 'POST', visitKey: 'V-dispense', businessIdentifier: `${PRESCRIPTION_SYSTEM}|RX-1`, effect: 'created' });
    expect(await mock.client.report()).toMatchObject({ duplicates: [], outOfOrder: [] });
  });

  it('finds stored dispenses by their prescription identifier, logged under their visit', async () => {
    const { encounterId, medicationRequestId } = await prescribed('V-dispense-search', 'RX-2');
    await fhir(mock.baseUrl, token, 'MedicationDispense', medicationDispense(encounterId, medicationRequestId, 'RX-2'));

    const hit = await fhir(mock.baseUrl, token, `MedicationDispense?identifier=${PRESCRIPTION_SYSTEM}|RX-2`);
    const miss = await fhir(mock.baseUrl, token, `MedicationDispense?identifier=${PRESCRIPTION_SYSTEM}|RX-none`);

    expect(await hit.json()).toMatchObject({ resourceType: 'Bundle', total: 1, entry: [{ resource: { resourceType: 'MedicationDispense' } }] });
    expect(await miss.json()).toMatchObject({ total: 0 });
    const searches = (await mock.client.log({ resourceType: 'MedicationDispense' })).filter((e) => e.method === 'GET');
    expect(searches.map((e) => e.visitKey)).toEqual(['V-dispense-search', null]);
  });

  it('judges a substitution against the medication of the prescription it holds', async () => {
    const { encounterId, medicationRequestId } = await prescribed('V-dispense-mismatch', 'RX-3');
    // 93000003 is Parasetamol 650 mg: the same active ingredient as the prescribed 92000001, another strength.
    const body = medicationDispense(encounterId, medicationRequestId, 'RX-3', {
      contained: [{ resourceType: 'Medication', id: 'medication', code: { coding: [{ system: 'http://sys-ids.kemkes.go.id/kfa', code: '93000003' }] } }],
    });

    const res = await fhir(mock.baseUrl, token, 'MedicationDispense', body);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      issue: [{ details: { coding: [{ code: 'SUBSTITUTION_MISMATCH' }] }, expression: ['MedicationDispense.substitution.wasSubstituted'] }],
    });
    const search = await fhir(mock.baseUrl, token, `MedicationDispense?identifier=${PRESCRIPTION_SYSTEM}|RX-3`);
    expect(await search.json()).toMatchObject({ total: 0 });
  });

  it('rejects a dispense authorized by a MedicationRequest it does not hold with 400 REFERENCE_NOT_FOUND', async () => {
    const { encounterId } = await prescribed('V-dispense-unknown', 'RX-4');

    const res = await fhir(mock.baseUrl, token, 'MedicationDispense', medicationDispense(encounterId, '00000000-0000-4000-8000-000000000000', 'RX-4'));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      issue: [{ details: { coding: [{ code: 'REFERENCE_NOT_FOUND' }] }, expression: ['MedicationDispense.authorizingPrescription'] }],
    });
    const [entry] = await mock.client.log({ resourceType: 'MedicationDispense' });
    expect(entry).toMatchObject({ effect: 'none', visitKey: 'V-dispense-unknown' });
  });

  it('answers 401 to a create without a valid token', async () => {
    const { encounterId, medicationRequestId } = await prescribed('V-dispense-noauth', 'RX-5');

    expect((await fhir(mock.baseUrl, null, 'MedicationDispense', medicationDispense(encounterId, medicationRequestId))).status).toBe(401);
  });
});
