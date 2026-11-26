// The mock SATUSEHAT itself: tokens, searches, the KFA v2 product lookup and
// Encounter, MedicationRequest and MedicationDispense create, answered
// from the world dataset and the records it holds. Each handler returns the
// response and what it did; the server logs it. All state is in memory.
import { randomBytes, randomUUID } from 'node:crypto';
import type { Clock } from './clock.js';
import type { Effect } from './submission-log.js';
import * as templates from './templates/index.js';
import { NIK_SYSTEM } from './templates/resources.js';
import { validateEncounter } from './validation/encounter.js';
import { validateMedicationDispense } from './validation/medication-dispense.js';
import { validateMedicationRequest } from './validation/medication-request.js';
import type { World, WorldEntries } from './world/world.js';

/** An answer plus what the request was about and what it changed, for the submission log. */
export interface PlatformResponse {
  status: number;
  body: unknown;
  resourceType: string | null;
  visitKey: string | null;
  businessIdentifier: string | null;
  effect: Effect;
}

/** Settings the platform behaves by. */
export interface PlatformSettings {
  tokenExpiresInSeconds: number;
  tokenThrottleWindowSeconds: number;
}

/** What a request that changed nothing and concerned no one visit was about. */
export function noEffect(resourceType: string | null): Omit<PlatformResponse, 'status' | 'body'> {
  return { resourceType, visitKey: null, businessIdentifier: null, effect: 'none' };
}

const ENCOUNTER_SYSTEM = /^http:\/\/sys-ids\.kemkes\.go\.id\/encounter\/\d+$/;
const PRESCRIPTION_SYSTEM = /^http:\/\/sys-ids\.kemkes\.go\.id\/prescription\/\d+$/;

/** In-memory SATUSEHAT state and behaviour. */
export class Platform {
  private world: World;
  private tokens = new Map<string, number>();
  private throttledUntilMs = 0;
  private encounters: fhir4.Encounter[] = [];
  private medicationRequests: fhir4.MedicationRequest[] = [];
  private medicationDispenses: fhir4.MedicationDispense[] = [];

  constructor(
    private readonly baseWorld: World,
    private readonly settings: PlatformSettings,
    private readonly clock: Clock,
  ) {
    this.world = structuredClone(baseWorld);
  }

  /** Clears records, issued tokens and throttle state, and reloads the world dataset. */
  reset(): void {
    this.world = structuredClone(this.baseWorld);
    this.tokens.clear();
    this.throttledUntilMs = 0;
    this.encounters = [];
    this.medicationRequests = [];
    this.medicationDispenses = [];
  }

  /** Adds entries to the world until the next reset. Entries that clash with existing ones are kept, so tests can make a lookup ambiguous. */
  seed(entries: WorldEntries): void {
    this.world.kfaIngredients.push(...entries.kfaIngredients);
    this.world.kfaProducts.push(...entries.kfaProducts);
    this.world.patients.push(...entries.patients);
    this.world.practitioners.push(...entries.practitioners);
    this.world.locations.push(...entries.locations);
  }

  /** Invalidates every issued token, so the next FHIR call gets 401. */
  revokeTokens(): void {
    this.tokens.clear();
  }

  /**
   * `POST /oauth2/v1/accesstoken?grant_type=client_credentials`. After a failed
   * request, every token request in the throttle window gets 429; a 429 does
   * not extend the window. Reissuing leaves older tokens valid (unverified, so
   * the mock takes the permissive side).
   */
  requestToken(grantType: string | null, clientId: unknown, clientSecret: unknown): PlatformResponse {
    const now = this.clock();
    const answer = (status: number, body: unknown): PlatformResponse => ({ status, body, ...noEffect(null) });
    if (now.getTime() < this.throttledUntilMs) return answer(429, templates.tokenThrottled(this.settings.tokenThrottleWindowSeconds));

    const fail = (status: number, reason: string): PlatformResponse => {
      this.throttledUntilMs = now.getTime() + this.settings.tokenThrottleWindowSeconds * 1000;
      return answer(status, templates.tokenRejected(reason));
    };
    if (grantType !== 'client_credentials') {
      return fail(400, `grant_type must be "client_credentials" in the query string, got "${grantType ?? ''}"`);
    }
    const { organization } = this.world;
    if (clientId !== organization.clientId || clientSecret !== organization.clientSecret) {
      return fail(401, 'invalid client_id or client_secret');
    }
    const accessToken = randomBytes(24).toString('base64url');
    this.tokens.set(accessToken, now.getTime() + this.settings.tokenExpiresInSeconds * 1000);
    return answer(
      200,
      templates.tokenIssued({
        accessToken,
        expiresInSeconds: this.settings.tokenExpiresInSeconds,
        issuedAt: now,
        clientId: organization.clientId,
        organizationName: organization.name,
      }),
    );
  }

  /** Whether an `Authorization` header carries a token that is issued, unexpired and unrevoked. */
  isAuthorized(authorization: string | undefined): boolean {
    const token = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1];
    const expiresAtMs = token === undefined ? undefined : this.tokens.get(token);
    return expiresAtMs !== undefined && this.clock().getTime() < expiresAtMs;
  }

  /**
   * A FHIR search. Only the parameters the hub uses are implemented; anything
   * else is a hub bug and gets 400.
   */
  search(resourceType: string, params: URLSearchParams): PlatformResponse {
    const names = [...params.keys()];
    const single = (name: string): string | undefined =>
      names.length === 1 && names[0] === name && params.getAll(name).length === 1 ? params.get(name) ?? undefined : undefined;
    const answer = (resources: fhir4.FhirResource[], about: Partial<PlatformResponse>): PlatformResponse => ({
      status: 200, body: templates.searchBundle(resources), ...noEffect(resourceType), ...about,
    });
    const identifier = splitToken(single('identifier'));

    if ((resourceType === 'Patient' || resourceType === 'Practitioner') && identifier?.system === NIK_SYSTEM) {
      const businessIdentifier = `${NIK_SYSTEM}|${identifier.value}`;
      const hits =
        resourceType === 'Patient'
          ? this.world.patients.filter((p) => p.nik === identifier.value).map((p) => templates.patientResource(p))
          : this.world.practitioners.filter((p) => p.nik === identifier.value).map((p) => templates.practitionerResource(p));
      return answer(hits, { businessIdentifier });
    }
    const locationId = resourceType === 'Location' ? single('_id') : undefined;
    if (locationId !== undefined) {
      const hits = this.world.locations.filter((l) => l.id === locationId);
      return answer(hits.map((l) => templates.locationResource(l, this.world.organization)), {});
    }
    if (resourceType === 'Encounter' && identifier && ENCOUNTER_SYSTEM.test(identifier.system)) {
      const hits = this.encounters.filter((e) =>
        e.identifier?.some((i) => i.system === identifier.system && i.value === identifier.value),
      );
      return answer(hits, { visitKey: identifier.value, businessIdentifier: `${identifier.system}|${identifier.value}` });
    }
    if (resourceType === 'MedicationRequest' && identifier && PRESCRIPTION_SYSTEM.test(identifier.system)) {
      const hits = this.medicationRequests.filter((m) =>
        m.identifier?.some((i) => i.system === identifier.system && i.value === identifier.value),
      );
      const [first] = hits;
      return answer(hits, {
        visitKey: first ? this.visitKeyOf(first.encounter?.reference) : null,
        businessIdentifier: `${identifier.system}|${identifier.value}`,
      });
    }
    if (resourceType === 'MedicationDispense' && identifier && PRESCRIPTION_SYSTEM.test(identifier.system)) {
      const hits = this.medicationDispenses.filter((m) =>
        m.identifier?.some((i) => i.system === identifier.system && i.value === identifier.value),
      );
      const [first] = hits;
      return answer(hits, {
        visitKey: first ? this.visitKeyOf(first.context?.reference) : null,
        businessIdentifier: `${identifier.system}|${identifier.value}`,
      });
    }
    return {
      status: 400,
      body: templates.unsupportedSearch(resourceType, [...params].map(([k, v]) => `${k}=${v}`)),
      ...noEffect(resourceType),
    };
  }

  /**
   * `GET /kfa-v2/products?identifier=kfa&code={code}`, answered from the
   * world's KFA catalogue: a product (92 or 93) with its dose form, template
   * and ingredients, or an ingredient (91). Any other query gets 400.
   */
  kfaProduct(params: URLSearchParams): PlatformResponse {
    const names = [...params.keys()].sort();
    const code = params.get('code');
    if (names.join('&') !== 'code&identifier' || params.get('identifier') !== 'kfa' || !code || params.getAll('code').length !== 1) {
      return {
        status: 400,
        body: templates.unsupportedSearch('KfaProduct', [...params].map(([k, v]) => `${k}=${v}`)),
        ...noEffect('KfaProduct'),
      };
    }
    const { kfaProducts, kfaIngredients } = this.world;
    const product = kfaProducts.find((p) => p.code === code);
    const ingredient = kfaIngredients.find((i) => i.code === code);
    const found = product
      ? {
          product,
          template: product.level === 93 ? kfaProducts.find((p) => p.code === product.parent) : undefined,
          ingredients: product.ingredients.flatMap((c) => kfaIngredients.filter((i) => i.code === c)),
        }
      : ingredient && { ingredient };
    return { status: 200, body: templates.kfaLookup(found), ...noEffect('KfaProduct') };
  }

  /**
   * `POST /Encounter`. A valid Encounter is stored with a new id and
   * `meta.versionId` "1". A second create for the same business identifier is
   * stored too, so a duplicate submission becomes visible in the report.
   */
  createEncounter(body: unknown): PlatformResponse {
    const visitIdentifier = findIdentifier(body, ENCOUNTER_SYSTEM);
    const about = {
      resourceType: 'Encounter',
      visitKey: visitIdentifier?.value ?? null,
      businessIdentifier: visitIdentifier ? `${visitIdentifier.system}|${visitIdentifier.value}` : null,
    };
    const violations = validateEncounter(body, this.world.organization.id);
    if (violations.length > 0) {
      return { status: 400, body: templates.payloadRejected(violations), effect: 'none', ...about };
    }
    const stored = templates.storedEncounter({
      // validateEncounter accepted it, so it has every field the mock relies on.
      body: body as fhir4.Encounter,
      id: randomUUID(),
      versionId: '1',
      lastUpdated: this.clock(),
    });
    this.encounters.push(stored);
    return { status: 201, body: stored, effect: 'created', ...about };
  }

  /**
   * `POST /MedicationRequest`. A valid MedicationRequest on an Encounter the
   * mock holds is stored with a new id and `meta.versionId` "1"; one on an
   * unknown Encounter is rejected with `REFERENCE_NOT_FOUND`. A second create
   * for the same prescription identifier is stored too, so the duplicate shows
   * in the report. Logged under the visit of the Encounter it references.
   */
  createMedicationRequest(body: unknown): PlatformResponse {
    const prescription = findIdentifier(body, PRESCRIPTION_SYSTEM);
    const encounterReference = isRecord(body) && isRecord(body.encounter) ? body.encounter.reference : undefined;
    const about = {
      resourceType: 'MedicationRequest',
      visitKey: this.visitKeyOf(encounterReference),
      businessIdentifier: prescription ? `${prescription.system}|${prescription.value}` : null,
    };
    const violations = validateMedicationRequest(body, {
      organizationId: this.world.organization.id,
      kfaProducts: this.world.kfaProducts,
      kfaIngredients: this.world.kfaIngredients,
      encounterExists: (id) => this.encounters.some((e) => e.id === id),
    });
    if (violations.length > 0) {
      return { status: 400, body: templates.payloadRejected(violations), effect: 'none', ...about };
    }
    const stored = templates.storedMedicationRequest({
      // validateMedicationRequest accepted it, so it has every field the mock relies on.
      body: body as fhir4.MedicationRequest,
      id: randomUUID(),
      versionId: '1',
      lastUpdated: this.clock(),
    });
    this.medicationRequests.push(stored);
    return { status: 201, body: stored, effect: 'created', ...about };
  }

  /**
   * `POST /MedicationDispense`. A valid dispense on an Encounter the mock
   * holds, authorized by a MedicationRequest it holds, is stored with a new id
   * and `meta.versionId` "1"; its product is judged against that
   * MedicationRequest's (93 only, the 92 → 93 parentage and `wasSubstituted`
   * agreeing). A second create for the same prescription identifier is stored
   * too, so the duplicate shows in the report. Logged under the visit of the
   * Encounter it references.
   */
  createMedicationDispense(body: unknown): PlatformResponse {
    const prescription = findIdentifier(body, PRESCRIPTION_SYSTEM);
    const encounterReference = isRecord(body) && isRecord(body.context) ? body.context.reference : undefined;
    const about = {
      resourceType: 'MedicationDispense',
      visitKey: this.visitKeyOf(encounterReference),
      businessIdentifier: prescription ? `${prescription.system}|${prescription.value}` : null,
    };
    const violations = validateMedicationDispense(body, {
      organizationId: this.world.organization.id,
      kfaProducts: this.world.kfaProducts,
      kfaIngredients: this.world.kfaIngredients,
      encounterExists: (id) => this.encounters.some((e) => e.id === id),
      prescribedKfaCode: (id) => {
        const held = this.medicationRequests.find((m) => m.id === id);
        return held && prescribedKfaCodeOf(held);
      },
    });
    if (violations.length > 0) {
      return { status: 400, body: templates.payloadRejected(violations), effect: 'none', ...about };
    }
    const stored = templates.storedMedicationDispense({
      // validateMedicationDispense accepted it, so it has every field the mock relies on.
      body: body as fhir4.MedicationDispense,
      id: randomUUID(),
      versionId: '1',
      lastUpdated: this.clock(),
    });
    this.medicationDispenses.push(stored);
    return { status: 201, body: stored, effect: 'created', ...about };
  }

  /** The visit key of the Encounter an `Encounter/{id}` reference names, when the mock holds it. */
  private visitKeyOf(reference: unknown): string | null {
    if (typeof reference !== 'string' || !reference.startsWith('Encounter/')) return null;
    const held = this.encounters.find((e) => e.id === reference.slice('Encounter/'.length));
    return held?.identifier?.find((i) => typeof i.system === 'string' && ENCOUNTER_SYSTEM.test(i.system))?.value ?? null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The KFA code of a held MedicationRequest's contained Medication; its validator made sure there is one. */
function prescribedKfaCodeOf(held: fhir4.MedicationRequest): string {
  const reference = held.medicationReference?.reference?.slice(1);
  const medication = held.contained?.find((c): c is fhir4.Medication => c.resourceType === 'Medication' && c.id === reference);
  const code = medication?.code?.coding?.find((c) => c.system === 'http://sys-ids.kemkes.go.id/kfa')?.code;
  if (code === undefined) throw new Error(`held MedicationRequest ${held.id ?? '(no id)'} has no KFA-coded Medication, yet its create was accepted`);
  return code;
}

/** Splits a FHIR token search value `system|value`. */
function splitToken(raw: string | undefined): { system: string; value: string } | undefined {
  const bar = raw?.indexOf('|') ?? -1;
  if (raw === undefined || bar <= 0 || bar === raw.length - 1) return undefined;
  return { system: raw.slice(0, bar), value: raw.slice(bar + 1) };
}

/** A submitted body's identifier under `system`, read leniently so even rejected requests are logged under it. */
function findIdentifier(body: unknown, system: RegExp): { system: string; value: string } | undefined {
  if (typeof body !== 'object' || body === null || !('identifier' in body) || !Array.isArray(body.identifier)) return undefined;
  // Array.isArray narrows to any[]; unknown[] keeps every element checked below.
  for (const id of body.identifier as unknown[]) {
    if (typeof id !== 'object' || id === null) continue;
    // Both fields are read as unknown and type-checked on the next line.
    const { system: idSystem, value } = id as { system?: unknown; value?: unknown };
    if (typeof idSystem === 'string' && system.test(idSystem) && typeof value === 'string' && value !== '') {
      return { system: idSystem, value };
    }
  }
  return undefined;
}
