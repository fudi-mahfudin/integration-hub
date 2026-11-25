/**
 * The mock's own MedicationRequest rules (ADR 0006), written from the
 * mandatory-field union and KFA rules of #2 / #9, never from the hub's code.
 * Stricter than the sandbox: the Medication must be contained, its KFA code
 * must be in the mock's catalogue at level 92 or 93, and a quantity unit
 * must be the product's dose form.
 */
import type { Violation } from '../templates/outcome.js';
import type { KfaProduct } from '../world/world.js';

export interface MedicationRequestRuleContext {
  organizationIds: ReadonlySet<string>;
  kfaByCode: ReadonlyMap<string, KfaProduct>;
  /** Whether the mock holds this Encounter id (`REFERENCE_NOT_FOUND`, #12). */
  hasEncounter(id: string): boolean;
}

const PRESCRIPTION = /^http:\/\/sys-ids\.kemkes\.go\.id\/prescription\/([^/]+)$/;
const PRESCRIPTION_ITEM = /^http:\/\/sys-ids\.kemkes\.go\.id\/prescription-item\/([^/]+)$/;
const MEDICATION_ID = /^http:\/\/sys-ids\.kemkes\.go\.id\/medication\/([^/]+)$/;
const KFA_SYSTEM = 'http://sys-ids.kemkes.go.id/kfa';
const MEDICATION_TYPE_URL = 'https://fhir.kemkes.go.id/r4/StructureDefinition/MedicationType';
const TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+00:00$/;
const FLOOR_MS = Date.UTC(2014, 5, 3);
const STATUSES = new Set(['active', 'on-hold', 'cancelled', 'completed', 'entered-in-error', 'stopped', 'draft', 'unknown']);
const INTENTS = new Set(['proposal', 'plan', 'order', 'original-order', 'reflex-order', 'filler-order', 'instance-order', 'option']);

export function validateMedicationRequest(body: unknown, ctx: MedicationRequestRuleContext): Violation[] {
  const out: Violation[] = [];
  const v = (rule: string, path: string, message: string, code = 'PAYLOAD_INVALID') => out.push({ code, rule, path, message });
  const m = (isObject(body) ? body : {}) as Record<string, any>;

  if (m.resourceType !== 'MedicationRequest') v('RESOURCE_TYPE', 'MedicationRequest.resourceType', 'resourceType must be MedicationRequest');

  // identifiers: prescription/{org} and prescription-item/{org}, one known org
  const ids: any[] = Array.isArray(m.identifier) ? m.identifier : [];
  const orgOf = (re: RegExp) => {
    const i = ids.find((x) => typeof x?.system === 'string' && re.test(x.system) && nonEmpty(x.value));
    const org = i ? re.exec(i.system)![1]! : null;
    return org !== null && ctx.organizationIds.has(org) ? org : null;
  };
  const org = orgOf(PRESCRIPTION);
  const itemOrg = orgOf(PRESCRIPTION_ITEM);
  if (ids.length === 0) v('REQUIRED', 'MedicationRequest.identifier', 'identifier is required');
  else {
    if (org === null) v('IDENTIFIER_SYSTEM', 'MedicationRequest.identifier', 'needs a valued identifier http://sys-ids.kemkes.go.id/prescription/{organization id}');
    if (itemOrg === null) v('IDENTIFIER_SYSTEM', 'MedicationRequest.identifier', 'needs a valued identifier http://sys-ids.kemkes.go.id/prescription-item/{organization id}');
    if (org !== null && itemOrg !== null && org !== itemOrg) v('ORGANIZATION_MISMATCH', 'MedicationRequest.identifier', 'prescription and prescription-item must name one organization');
  }

  if (!nonEmpty(m.status)) v('REQUIRED', 'MedicationRequest.status', 'status is required');
  else if (!STATUSES.has(m.status)) v('VALUE_SET', 'MedicationRequest.status', `status ${String(m.status)} is not in the MedicationRequest status value set`);
  if (!nonEmpty(m.intent)) v('REQUIRED', 'MedicationRequest.intent', 'intent is required');
  else if (!INTENTS.has(m.intent)) v('VALUE_SET', 'MedicationRequest.intent', `intent ${String(m.intent)} is not in the MedicationRequest intent value set`);

  // the medication: a contained, non-compound Medication with a KFA code
  let product: KfaProduct | undefined;
  if (!isObject(m.medicationReference) || !nonEmpty(m.medicationReference.reference)) {
    v('REQUIRED', 'MedicationRequest.medicationReference.reference', 'medicationReference is required');
  } else {
    const ref = String(m.medicationReference.reference);
    const contained: any[] = Array.isArray(m.contained) ? m.contained : [];
    const med = ref.startsWith('#') ? contained.find((c) => c?.resourceType === 'Medication' && c.id === ref.slice(1)) : undefined;
    if (!med) v('REFERENCE_TYPE', 'MedicationRequest.medicationReference.reference', 'must reference a contained Medication (#id)');
    else product = medication(med, v, ctx);
  }

  reference(m.subject, 'Patient', 'MedicationRequest.subject.reference', v);
  if (reference(m.encounter, 'Encounter', 'MedicationRequest.encounter.reference', v)) {
    const id = String(m.encounter.reference).split('/')[1]!;
    if (!ctx.hasEncounter(id)) v('REFERENCE_NOT_FOUND', 'MedicationRequest.encounter.reference', `Encounter/${id} does not exist`, 'REFERENCE_NOT_FOUND');
  }
  reference(m.requester, 'Practitioner', 'MedicationRequest.requester.reference', v);

  if (m.authoredOn === undefined) v('REQUIRED', 'MedicationRequest.authoredOn', 'authoredOn is required');
  else {
    const ms = parseUtc(m.authoredOn);
    if (ms === null) v('TIME_FORMAT', 'MedicationRequest.authoredOn', 'time must be YYYY-MM-DDThh:mm:ss+00:00');
    else if (ms < FLOOR_MS) v('DATE_FLOOR', 'MedicationRequest.authoredOn', 'time must not be before 2014-06-03T00:00:00+00:00');
  }

  const dosages: any[] = Array.isArray(m.dosageInstruction) ? m.dosageInstruction : [];
  if (dosages.length === 0) v('REQUIRED', 'MedicationRequest.dosageInstruction', 'a dosage instruction is required');
  dosages.forEach((d, i) => {
    const path = `MedicationRequest.dosageInstruction[${i}]`;
    if (!isObject(d?.timing) || !isObject(d.timing.repeat)) v('REQUIRED', `${path}.timing.repeat`, 'timing.repeat is required');
    if (!isObject(d?.route) || !Array.isArray(d.route.coding) || d.route.coding.length === 0) v('REQUIRED', `${path}.route`, 'route is required');
    (Array.isArray(d?.doseAndRate) ? d.doseAndRate : []).forEach((r: any, j: number) =>
      unit(r?.doseQuantity, product, `${path}.doseAndRate[${j}].doseQuantity.code`, v),
    );
  });

  const dispense = isObject(m.dispenseRequest) ? m.dispenseRequest : {};
  if (reference(dispense.performer, 'Organization', 'MedicationRequest.dispenseRequest.performer.reference', v) && org !== null) {
    if (dispense.performer.reference !== `Organization/${org}`) {
      v('ORGANIZATION_MISMATCH', 'MedicationRequest.dispenseRequest.performer.reference', 'performer must be the organization of the prescription identifier');
    }
  }
  unit(dispense.quantity, product, 'MedicationRequest.dispenseRequest.quantity.code', v);

  if (!isObject(m.substitution) || typeof m.substitution.allowedBoolean !== 'boolean') {
    v('REQUIRED', 'MedicationRequest.substitution.allowed[x]', 'substitution.allowedBoolean is required');
  }
  return out;
}

type Fail = (rule: string, path: string, message: string, code?: string) => void;

/** Checks the contained Medication; returns its catalogue product when the code is usable. */
function medication(med: Record<string, any>, v: Fail, ctx: MedicationRequestRuleContext): KfaProduct | undefined {
  const ids: any[] = Array.isArray(med.identifier) ? med.identifier : [];
  if (!ids.some((i) => typeof i?.system === 'string' && MEDICATION_ID.test(i.system) && nonEmpty(i.value))) {
    v('REQUIRED', 'Medication.identifier', 'needs a valued identifier http://sys-ids.kemkes.go.id/medication/{organization id}');
  }
  const exts: any[] = Array.isArray(med.extension) ? med.extension : [];
  if (!exts.some((e) => e?.url === MEDICATION_TYPE_URL && Array.isArray(e.valueCodeableConcept?.coding) && e.valueCodeableConcept.coding.some((c: any) => c?.code === 'NC'))) {
    v('REQUIRED', 'Medication.extension', 'a non-compound medication needs the MedicationType extension with code NC');
  }
  const codings: any[] = Array.isArray(med.code?.coding) ? med.code.coding : [];
  const kfa = codings.find((c) => c?.system === KFA_SYSTEM && nonEmpty(c.code));
  if (!kfa) {
    v('REQUIRED', 'Medication.code', `code needs a coding with system ${KFA_SYSTEM}`);
    return undefined;
  }
  const product = ctx.kfaByCode.get(kfa.code);
  if (!product) {
    v('VALUE_SET', 'Medication.code', `KFA code ${String(kfa.code)} is not in the catalogue`);
    return undefined;
  }
  if (product.level !== 92 && product.level !== 93) {
    v('KFA_LEVEL', 'Medication.code', `a prescription needs a KFA 92 or 93 code; ${product.code} is ${product.level}`, 'KFA_LEVEL_INVALID');
    return undefined;
  }
  return product;
}

/** A quantity, when present, must carry the product's dose form as its code. */
function unit(q: unknown, product: KfaProduct | undefined, path: string, v: Fail): void {
  if (!isObject(q) || product?.doseForm === undefined) return;
  if (q.code !== product.doseForm.code) v('VALUE_SET', path, `quantity unit must be the dose form ${product.doseForm.code} of ${product.code}`);
}

function parseUtc(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = TIME.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  const exact =
    back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d &&
    back.getUTCHours() === h && back.getUTCMinutes() === mi && back.getUTCSeconds() === s;
  return exact ? ms : null;
}

function reference(ref: unknown, type: string, path: string, v: Fail): boolean {
  if (!isObject(ref) || !nonEmpty(ref.reference)) {
    v('REQUIRED', path, `${path.replace(/^MedicationRequest\./, '')} is required`);
    return false;
  }
  const [t, id, ...rest] = String(ref.reference).split('/');
  if (t !== type || !nonEmpty(id) || rest.length > 0) {
    v('REFERENCE_TYPE', path, `must reference a ${type}`);
    return false;
  }
  return true;
}

function isObject(x: unknown): x is Record<string, any> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function nonEmpty(x: unknown): x is string {
  return typeof x === 'string' && x.trim() !== '';
}
