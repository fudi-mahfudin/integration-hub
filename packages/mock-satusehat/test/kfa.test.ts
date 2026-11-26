import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessToken, bootMock, type BootedMock } from './support/boot-mock.js';

/** `GET /kfa-v2/products?…` with a bearer token. */
function kfa(baseUrl: URL, token: string | null, query: string): Promise<Response> {
  return fetch(new URL(`kfa-v2/products?${query}`, baseUrl), {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

describe('KFA v2 product lookup', () => {
  let mock: BootedMock;
  let token: string;

  beforeAll(async () => {
    mock = await bootMock();
    token = await accessToken(mock.baseUrl);
  });
  afterAll(async () => mock?.close());

  it('answers an actual product (93) with its dose form, its virtual product and its active ingredients', async () => {
    const res = await kfa(mock.baseUrl, token, 'identifier=kfa&code=93000004');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      total: 1,
      result: {
        kfa_code: '93000004',
        name: 'Amoksisilin 500 mg Kapsul (Fiktif Farma C)',
        active: true,
        dosage_form: { code: 'BS019', name: 'Kapsul' },
        product_template: { kfa_code: '92000003', name: 'Amoksisilin 500 mg Kapsul' },
        active_ingredients: [{ kfa_code: '91000002', zat_aktif: 'Amoksisilin' }],
      },
    });
  });

  it('answers a virtual product (92) with no product template', async () => {
    const res = await kfa(mock.baseUrl, token, 'identifier=kfa&code=92000004');

    expect(await res.json()).toMatchObject({
      total: 1,
      result: {
        kfa_code: '92000004',
        dosage_form: { code: 'BS066', name: 'Tablet' },
        product_template: null,
        active_ingredients: [{ kfa_code: '91000002' }, { kfa_code: '91000003' }],
      },
    });
  });

  it('answers an ingredient (91) with no dose form, so a level check can reject it', async () => {
    const res = await kfa(mock.baseUrl, token, 'identifier=kfa&code=91000001');

    expect(await res.json()).toMatchObject({
      total: 1,
      result: { kfa_code: '91000001', name: 'Parasetamol', dosage_form: null, product_template: null, active_ingredients: [] },
    });
  });

  it('answers an unknown code with no result', async () => {
    const res = await kfa(mock.baseUrl, token, 'identifier=kfa&code=93999999');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 0, result: null });
  });

  it('answers 400 to any other query and 401 without a valid token', async () => {
    expect((await kfa(mock.baseUrl, token, 'code=93000004')).status).toBe(400);
    expect((await kfa(mock.baseUrl, null, 'identifier=kfa&code=93000004')).status).toBe(401);
  });

  it('logs each lookup with no visit and no effect', async () => {
    await kfa(mock.baseUrl, token, 'identifier=kfa&code=93000001');

    const [entry] = (await mock.client.log({ resourceType: 'KfaProduct' })).slice(-1);
    expect(entry).toMatchObject({ method: 'GET', visitKey: null, effect: 'none', response: { status: 200 } });
  });
});
