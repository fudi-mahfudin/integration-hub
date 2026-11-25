import { describe, expect, it } from 'vitest';
import { useMock, world } from './support/platform.js';

const ctx = useMock();

const product = (level: number) => world.kfaProducts.find((p) => p.level === level)!;

describe('KFA v2 product detail, from the mock world catalogue (#10, ADR 0006)', () => {
  it('returns a 93 with its dose form, its 92 as product_template and its 91 set', async () => {
    const p93 = product(93);
    const p92 = world.kfaProducts.find((p) => p.code === p93.parentCode)!;

    const r = await ctx.platform.kfa({ identifier: 'kfa', code: p93.code });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      total: 1,
      result: {
        kfa_code: p93.code,
        name: p93.display,
        active: true,
        dosage_form: p93.doseForm,
        product_template: { kfa_code: p92.code, name: p92.display },
        active_ingredients: p93.ingredientCodes.map((c) => ({
          kfa_code: c,
          zat_aktif: world.kfaProducts.find((x) => x.code === c)!.display,
        })),
      },
    });
  });

  it('returns a 92 without a product_template, and a 91 without a dose form or ingredients', async () => {
    const r92 = await ctx.platform.kfa({ identifier: 'kfa', code: product(92).code });
    expect(r92.body.result).toMatchObject({ kfa_code: product(92).code, product_template: null, dosage_form: product(92).doseForm });

    const r91 = await ctx.platform.kfa({ identifier: 'kfa', code: product(91).code });
    expect(r91.body.result).toMatchObject({ kfa_code: product(91).code, product_template: null, dosage_form: null, active_ingredients: [] });
  });

  it('answers 404 for a code not in the catalogue', async () => {
    const r = await ctx.platform.kfa({ identifier: 'kfa', code: '93999999' });
    expect(r.status).toBe(404);
  });

  it('needs the platform token, and rejects any other query with 400', async () => {
    expect((await ctx.platform.kfa({ identifier: 'kfa', code: product(93).code }, null)).status).toBe(401);
    expect((await ctx.platform.kfa({ code: product(93).code })).status).toBe(400);
  });

  it('serves products added with /__mock/seed until the next reset, and logs every request', async () => {
    await ctx.client.seed({ kfaProducts: [{ code: '93777777', level: 93, display: 'Seeded', parentCode: product(92).code, ingredientCodes: [], doseForm: { code: 'TAB', name: 'Tablet' } }] });
    expect((await ctx.platform.kfa({ identifier: 'kfa', code: '93777777' })).status).toBe(200);

    const log = (await ctx.client.log()).filter((e) => e.path === '/kfa-v2/products');
    expect(log.map((e) => e.response.status)).toEqual([200]);
    await ctx.client.reset();
    ctx.platform.forgetToken();
    expect((await ctx.platform.kfa({ identifier: 'kfa', code: '93777777' })).status).toBe(404);
  });
});
