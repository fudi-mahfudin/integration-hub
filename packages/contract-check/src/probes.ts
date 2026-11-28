// The fixed requests of a contract check (#16, #48), in the order they are
// sent. Each is sent to the sandbox and to the mock, built from that side's
// own records and what that side answered earlier. Never provoked: 429, 5xx
// and the token-endpoint throttle (we don't flood a shared sandbox), so the
// token probe always sends the right credentials.
import { randomUUID } from 'node:crypto';
import type { TemplateName } from '@integration-hub/mock-satusehat/contract';
import { z } from 'zod';
import type { Exchange } from './shape-diff.js';
import type { Target } from './target.js';

/** What later requests take from earlier answers on the same side. */
export interface Learned {
  token: string;
  kfa: { code: string; display: string; doseForm: { code: string; display: string } };
  patient: string;
  practitioner: string;
  pharmacist: string;
  encounterId: string;
  medicationRequestId: string;
}

/** One side's state during a check: its target, the run's identifiers and what it has answered so far. */
export interface ProbeContext {
  target: Target;
  /** The business identifier values of this run, unique per run because sandbox records can't be deleted (#14). */
  run: { visitId: string; prescriptionId: string; itemId: string };
  /** The check's start; record times are set just before it. */
  now: Date;
  learned: Partial<Learned>;
}

/** A request as sent. `body` is a form (token) or JSON. */
export interface ProbeRequest {
  method: 'GET' | 'POST' | 'PUT';
  url: URL;
  headers: Record<string, string>;
  body?: { form: Record<string, string> } | { json: unknown };
}

/** One fixed request of the contract check. */
export interface Probe {
  name: string;
  /** The response templates of the mock this request's answer comes from. */
  templates: readonly TemplateName[];
  /** The key paths (arrays as `[]`) of the answer the hub reads (`apps/hub/src/satusehat`, `kfa`). */
  hubReads: readonly string[];
  /** The status a good answer has; only a good answer is learned from. */
  expectedStatus: number;
  /** The request, or `undefined` when it needs something this side has not answered (the probe is skipped). */
  request(ctx: ProbeContext): ProbeRequest | undefined;
  /** Takes what later probes need from a good answer. Throws when the body lacks it. */
  learn?(ctx: ProbeContext, answer: Exchange): void;
}

const NIK_SYSTEM = 'https://fhir.kemkes.go.id/id/nik';
const KFA_SYSTEM = 'http://sys-ids.kemkes.go.id/kfa';
const MEDICATION_FORM_SYSTEM = 'http://terminology.kemkes.go.id/CodeSystem/medication-form';
const FHIR_JSON = 'application/fhir+json';

const encounterSystem = (org: string) => `http://sys-ids.kemkes.go.id/encounter/${org}`;
const prescriptionSystem = (org: string) => `http://sys-ids.kemkes.go.id/prescription/${org}`;
const prescriptionItemSystem = (org: string) => `http://sys-ids.kemkes.go.id/prescription-item/${org}`;

/** `YYYY-MM-DDThh:mm:ss+00:00`, `minutes` before `now`: the only time format SATUSEHAT takes. */
const platformTime = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, '+00:00');

const bearer = (ctx: ProbeContext) => (ctx.learned.token === undefined ? undefined : { authorization: `Bearer ${ctx.learned.token}` });

function fhirGet(ctx: ProbeContext, path: string, query: Record<string, string>): ProbeRequest | undefined {
  const auth = bearer(ctx);
  if (!auth) return undefined;
  return { method: 'GET', url: new URL(`${path}?${new URLSearchParams(query)}`, ctx.target.fhirUrl), headers: { ...auth, accept: FHIR_JSON } };
}

function fhirSend(ctx: ProbeContext, method: 'POST' | 'PUT', path: string, json: unknown): ProbeRequest | undefined {
  const auth = bearer(ctx);
  if (!auth) return undefined;
  return { method, url: new URL(path, ctx.target.fhirUrl), headers: { ...auth, accept: FHIR_JSON, 'content-type': FHIR_JSON }, body: { json } };
}

const firstHitId = z.object({ entry: z.array(z.object({ resource: z.object({ id: z.string().min(1) }) })).min(1) });
const storedId = z.object({ id: z.string().min(1) });

/** The fields a search Bundle's hits share that the hub reads. */
const SEARCH_READS = ['resourceType', 'entry[].resource.id'];
/** The fields of a stored record the hub reads from a create or update. */
const STORED_READS = ['id', 'meta.versionId'];

function personByNik(name: string, resourceType: 'Patient' | 'Practitioner', nik: (t: Target) => string, key: 'patient' | 'practitioner' | 'pharmacist'): Probe {
  return {
    name,
    templates: ['searchBundle', resourceType === 'Patient' ? 'patientResource' : 'practitionerResource'],
    hubReads: SEARCH_READS,
    expectedStatus: 200,
    request: (ctx) => fhirGet(ctx, resourceType, { identifier: `${NIK_SYSTEM}|${nik(ctx.target)}` }),
    learn: (ctx, answer) => {
      ctx.learned[key] = firstHitId.parse(answer.body).entry[0]?.resource.id;
    },
  };
}

function encounterBody(ctx: ProbeContext, need: Pick<Learned, 'patient' | 'practitioner'>) {
  const org = ctx.target.organizationId;
  return {
    resourceType: 'Encounter',
    identifier: [{ system: encounterSystem(org), value: ctx.run.visitId }],
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
    subject: { reference: `Patient/${need.patient}` },
    participant: [
      {
        type: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'ATND', display: 'attender' }] }],
        individual: { reference: `Practitioner/${need.practitioner}` },
      },
    ],
    location: [{ location: { reference: `Location/${ctx.target.subjects.locationId}` } }],
    serviceProvider: { reference: `Organization/${org}` },
  };
}

function containedMedication(ctx: ProbeContext, kfa: Learned['kfa'], batch: boolean) {
  return {
    resourceType: 'Medication',
    id: 'medication',
    identifier: [
      { system: `http://sys-ids.kemkes.go.id/medication/${ctx.target.organizationId}`, use: 'official', value: `${ctx.run.prescriptionId}-${ctx.run.itemId}` },
    ],
    code: { coding: [{ system: KFA_SYSTEM, code: kfa.code, display: kfa.display }] },
    status: 'active',
    form: { coding: [{ system: MEDICATION_FORM_SYSTEM, code: kfa.doseForm.code, display: kfa.doseForm.display }] },
    ...(batch ? { batch: { lotNumber: `LOT-${ctx.run.prescriptionId}`, expirationDate: `${ctx.now.getUTCFullYear() + 2}-12-31` } } : {}),
  };
}

function prescriptionIdentifiers(ctx: ProbeContext) {
  const org = ctx.target.organizationId;
  return [
    { system: prescriptionSystem(org), use: 'official', value: ctx.run.prescriptionId },
    { system: prescriptionItemSystem(org), use: 'official', value: ctx.run.itemId },
  ];
}

const doseUnit = (kfa: Learned['kfa']) => ({ unit: kfa.doseForm.display, system: MEDICATION_FORM_SYSTEM, code: kfa.doseForm.code });

/** Every learned value `keys` names, or `undefined` when one is missing. */
function needs<K extends keyof Learned>(ctx: ProbeContext, ...keys: K[]): Pick<Learned, K> | undefined {
  const picked: Partial<Pick<Learned, K>> = {};
  for (const key of keys) {
    const value = ctx.learned[key];
    if (value === undefined) return undefined;
    picked[key] = value;
  }
  // Every key was just checked to be present.
  return picked as Pick<Learned, K>;
}

const kfaLookupSchema = z.object({
  result: z.object({
    kfa_code: z.string().min(1),
    name: z.string().min(1),
    dosage_form: z.object({ code: z.string().min(1), name: z.string().min(1) }),
  }),
});

/** The fixed requests, in sending order. */
export const PROBES: readonly Probe[] = [
  {
    name: 'token',
    templates: ['tokenIssued'],
    hubReads: ['access_token', 'expires_in'],
    expectedStatus: 200,
    request: (ctx) => ({
      method: 'POST',
      url: new URL('accesstoken?grant_type=client_credentials', ctx.target.authUrl),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: { form: { client_id: ctx.target.clientId, client_secret: ctx.target.clientSecret } },
    }),
    learn: (ctx, answer) => {
      ctx.learned.token = z.object({ access_token: z.string().min(1) }).parse(answer.body).access_token;
    },
  },
  {
    name: 'kfa-product',
    templates: ['kfaLookup'],
    hubReads: ['result', 'result.kfa_code', 'result.name', 'result.dosage_form.code', 'result.dosage_form.name', 'result.product_template.kfa_code', 'result.active_ingredients[].kfa_code'],
    expectedStatus: 200,
    request: (ctx) => {
      const auth = bearer(ctx);
      if (!auth) return undefined;
      const query = new URLSearchParams({ identifier: 'kfa', code: ctx.target.subjects.kfaProductCode });
      return { method: 'GET', url: new URL(`products?${query}`, ctx.target.kfaUrl), headers: { ...auth, accept: 'application/json' } };
    },
    learn: (ctx, answer) => {
      const { result } = kfaLookupSchema.parse(answer.body);
      ctx.learned.kfa = { code: result.kfa_code, display: result.name, doseForm: { code: result.dosage_form.code, display: result.dosage_form.name } };
    },
  },
  personByNik('patient-by-nik', 'Patient', (t) => t.subjects.patientNik, 'patient'),
  personByNik('practitioner-by-nik', 'Practitioner', (t) => t.subjects.practitionerNik, 'practitioner'),
  personByNik('pharmacist-by-nik', 'Practitioner', (t) => t.subjects.pharmacistNik, 'pharmacist'),
  {
    name: 'location-search',
    templates: ['searchBundle', 'locationResource'],
    hubReads: SEARCH_READS,
    expectedStatus: 200,
    request: (ctx) => fhirGet(ctx, 'Location', { _id: ctx.target.subjects.locationId }),
  },
  {
    name: 'encounter-create',
    templates: ['storedEncounter'],
    hubReads: STORED_READS,
    expectedStatus: 201,
    request: (ctx) => {
      const need = needs(ctx, 'patient', 'practitioner');
      if (!need) return undefined;
      const start = platformTime(ctx.now, 30);
      const { resourceType, identifier, ...rest } = encounterBody(ctx, need);
      return fhirSend(ctx, 'POST', 'Encounter', { resourceType, identifier, status: 'arrived', ...rest, period: { start }, statusHistory: [{ status: 'arrived', period: { start } }] });
    },
    learn: (ctx, answer) => {
      ctx.learned.encounterId = storedId.parse(answer.body).id;
    },
  },
  {
    name: 'encounter-search',
    templates: ['searchBundle', 'storedEncounter'],
    hubReads: [...SEARCH_READS, 'entry[].resource.meta.versionId', 'entry[].resource.status', 'entry[].resource.subject.reference', 'entry[].resource.participant[].individual.reference', 'entry[].resource.location[].location.reference'],
    expectedStatus: 200,
    request: (ctx) => (needs(ctx, 'encounterId') ? fhirGet(ctx, 'Encounter', { identifier: `${encounterSystem(ctx.target.organizationId)}|${ctx.run.visitId}` }) : undefined),
  },
  {
    name: 'encounter-update',
    templates: ['storedEncounter'],
    hubReads: STORED_READS,
    expectedStatus: 200,
    request: (ctx) => {
      const need = needs(ctx, 'patient', 'practitioner', 'encounterId');
      if (!need) return undefined;
      const start = platformTime(ctx.now, 30);
      const end = platformTime(ctx.now, 1);
      const { resourceType, identifier, ...rest } = encounterBody(ctx, need);
      return fhirSend(ctx, 'PUT', `Encounter/${encodeURIComponent(need.encounterId)}`, {
        resourceType,
        id: need.encounterId,
        identifier,
        status: 'finished',
        ...rest,
        period: { start, end },
        statusHistory: [
          { status: 'arrived', period: { start, end } },
          { status: 'finished', period: { start: end, end } },
        ],
      });
    },
  },
  {
    name: 'medication-request-create',
    templates: ['storedMedicationRequest'],
    hubReads: STORED_READS,
    expectedStatus: 201,
    request: (ctx) => {
      const need = needs(ctx, 'kfa', 'patient', 'practitioner', 'encounterId');
      if (!need) return undefined;
      const unit = doseUnit(need.kfa);
      return fhirSend(ctx, 'POST', 'MedicationRequest', {
        resourceType: 'MedicationRequest',
        contained: [containedMedication(ctx, need.kfa, false)],
        identifier: prescriptionIdentifiers(ctx),
        status: 'completed',
        intent: 'order',
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/medicationrequest-category', code: 'community', display: 'Community' }] }],
        medicationReference: { reference: '#medication', display: need.kfa.display },
        subject: { reference: `Patient/${need.patient}` },
        encounter: { reference: `Encounter/${need.encounterId}` },
        authoredOn: platformTime(ctx.now, 20),
        requester: { reference: `Practitioner/${need.practitioner}` },
        dosageInstruction: [
          {
            sequence: 1,
            text: '1 x 1',
            timing: { repeat: { frequency: 1, period: 1, periodUnit: 'd' } },
            route: { coding: [{ system: 'http://www.whocc.no/atc', code: 'O' }] },
            doseAndRate: [{ doseQuantity: { value: 1, ...unit } }],
          },
        ],
        dispenseRequest: { quantity: { value: 10, ...unit }, performer: { reference: `Organization/${ctx.target.organizationId}` } },
        substitution: { allowedBoolean: true },
      });
    },
    learn: (ctx, answer) => {
      ctx.learned.medicationRequestId = storedId.parse(answer.body).id;
    },
  },
  {
    name: 'medication-request-search',
    templates: ['searchBundle', 'storedMedicationRequest'],
    hubReads: [
      ...SEARCH_READS,
      'entry[].resource.meta.versionId',
      'entry[].resource.status',
      'entry[].resource.subject.reference',
      'entry[].resource.requester.reference',
      'entry[].resource.encounter.reference',
      'entry[].resource.contained[].id',
      'entry[].resource.contained[].code.coding[].system',
      'entry[].resource.contained[].code.coding[].code',
    ],
    expectedStatus: 200,
    request: (ctx) =>
      needs(ctx, 'medicationRequestId') ? fhirGet(ctx, 'MedicationRequest', { identifier: `${prescriptionSystem(ctx.target.organizationId)}|${ctx.run.prescriptionId}` }) : undefined,
  },
  {
    name: 'medication-dispense-create',
    templates: ['storedMedicationDispense'],
    hubReads: STORED_READS,
    expectedStatus: 201,
    request: (ctx) => {
      const need = needs(ctx, 'kfa', 'patient', 'pharmacist', 'encounterId', 'medicationRequestId');
      if (!need) return undefined;
      const pharmacist = { reference: `Practitioner/${need.pharmacist}` };
      return fhirSend(ctx, 'POST', 'MedicationDispense', {
        resourceType: 'MedicationDispense',
        contained: [containedMedication(ctx, need.kfa, true)],
        identifier: prescriptionIdentifiers(ctx),
        status: 'completed',
        medicationReference: { reference: '#medication', display: need.kfa.display },
        subject: { reference: `Patient/${need.patient}` },
        context: { reference: `Encounter/${need.encounterId}` },
        performer: [{ actor: pharmacist }],
        authorizingPrescription: [{ reference: `MedicationRequest/${need.medicationRequestId}` }],
        quantity: { value: 10, ...doseUnit(need.kfa) },
        whenPrepared: platformTime(ctx.now, 10),
        whenHandedOver: platformTime(ctx.now, 5),
        substitution: { wasSubstituted: false },
      });
    },
  },
  {
    name: 'invalid-payload',
    templates: ['payloadRejected'],
    hubReads: ['resourceType', 'issue[].code', 'issue[].details.coding[].code'],
    expectedStatus: 400,
    // An Encounter with none of its mandatory fields: rejected before anything is stored.
    request: (ctx) => fhirSend(ctx, 'POST', 'Encounter', { resourceType: 'Encounter' }),
  },
  {
    name: 'bogus-token',
    templates: ['unauthorized'],
    hubReads: [],
    expectedStatus: 401,
    request: (ctx) => ({
      method: 'GET',
      url: new URL(`Patient?${new URLSearchParams({ identifier: `${NIK_SYSTEM}|${ctx.target.subjects.patientNik}` })}`, ctx.target.fhirUrl),
      headers: { authorization: `Bearer ${randomUUID()}`, accept: FHIR_JSON },
    }),
  },
  {
    name: 'unknown-id',
    templates: ['notFound'],
    hubReads: [],
    expectedStatus: 404,
    request: (ctx) => {
      const auth = bearer(ctx);
      return auth ? { method: 'GET', url: new URL(`Encounter/${randomUUID()}`, ctx.target.fhirUrl), headers: { ...auth, accept: FHIR_JSON } } : undefined;
    },
  },
];
