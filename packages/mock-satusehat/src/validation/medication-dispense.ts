/**
 * The mock's own MedicationDispense rules (ADR 0006), written from the
 * mandatory-field union and KFA rules of #2 / #9, never from the hub's code.
 * Stricter than the sandbox: the dispensed Medication must be contained
 * with a catalogue 93; it must be the prescribed 93 or a child of the
 * prescribed 92, or else share its active ingredients (a substitution);
 * `wasSubstituted` must say which; and `authorizingPrescription` must be a
 * MedicationRequest the mock holds (dictionary rule 10394).
 */
import type { Violation } from '../templates/outcome.js';
import { FLOOR_MS, isObject, nonEmpty, parseUtc, reference } from './common.js';
import type { KfaProduct } from '../world/world.js';

export interface MedicationDispenseRuleContext {
  organizationIds: ReadonlySet<string>;
  kfaByCode: ReadonlyMap<string, KfaProduct>;
  hasEncounter(id: string): boolean;
  /** A MedicationRequest the mock holds, by id. */
  medicationRequest(id: string): Record<string, any> | undefined;
}

const PRESCRIPTION = /^http:\/\/sys-ids\.kemkes\.go\.id\/prescription\/([^/]+)$/;
const PRESCRIPTION_ITEM = /^http:\/\/sys-ids\.kemkes\.go\.id\/prescription-item\/([^/]+)$/;
const MEDICATION_ID = /^http:\/\/sys-ids\.kemkes\.go\.id\/medication\/([^/]+)$/;
const KFA_SYSTEM = 'http://sys-ids.kemkes.go.id/kfa';
const MEDICATION_TYPE_URL = 'https://fhir.kemkes.go.id/r4/StructureDefinition/MedicationType';
const SUBSTITUTION_TYPE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v3-substanceAdminSubstitution';
const SUBSTITUTION_TYPES = new Set(['G', 'BC', 'TG', 'TB']);
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const STATUSES = new Set(['preparation', 'in-progress', 'cancelled', 'on-hold', 'completed', 'entered-in-error', 'stopped', 'declined', 'unknown']);

type Fail = (rule: string, path: string, message: string, code?: string) => void;

export function validateMedicationDispense(body: unknown, ctx: MedicationDispenseRuleContext): Violation[] {
  const out: Violation[] = [];
  const v: Fail = (rule, path, message, code = 'PAYLOAD_INVALID') => out.push({ code, rule, path, message });
  const m = (isObject(body) ? body : {}) as Record<string, any>;

  if (m.resourceType !== 'MedicationDispense') v('RESOURCE_TYPE', 'MedicationDispense.resourceType', 'resourceType must be MedicationDispense');

  // identifiers: the prescription's own systems (rule 10389), one known org
  const ids: any[] = Array.isArray(m.identifier) ? m.identifier : [];
  const orgOf = (re: RegExp) => {
    const i = ids.find((x) => typeof x?.system === 'string' && re.test(x.system) && nonEmpty(x.value));
    const org = i ? re.exec(i.system)![1]! : null;
    return org !== null && ctx.organizationIds.has(org) ? org : null;
  };
  if (ids.length === 0) v('REQUIRED', 'MedicationDispense.identifier', 'identifier is required');
  else {
    const org = orgOf(PRESCRIPTION);
    const itemOrg = orgOf(PRESCRIPTION_ITEM);
    if (org === null) v('IDENTIFIER_SYSTEM', 'MedicationDispense.identifier', 'needs a valued identifier http://sys-ids.kemkes.go.id/prescription/{organization id}');
    if (itemOrg === null) v('IDENTIFIER_SYSTEM', 'MedicationDispense.identifier', 'needs a valued identifier http://sys-ids.kemkes.go.id/prescription-item/{organization id}');
    if (org !== null && itemOrg !== null && org !== itemOrg) v('ORGANIZATION_MISMATCH', 'MedicationDispense.identifier', 'prescription and prescription-item must name one organization');
  }

  if (!nonEmpty(m.status)) v('REQUIRED', 'MedicationDispense.status', 'status is required');
  else if (!STATUSES.has(m.status)) v('VALUE_SET', 'MedicationDispense.status', `status ${String(m.status)} is not in the MedicationDispense status value set`);

  // the dispensed medication: contained, non-compound, a catalogue 93
  let product: KfaProduct | undefined;
  if (!isObject(m.medicationReference) || !nonEmpty(m.medicationReference.reference)) {
    v('REQUIRED', 'MedicationDispense.medicationReference.reference', 'medicationReference is required');
  } else {
    const ref = String(m.medicationReference.reference);
    const contained: any[] = Array.isArray(m.contained) ? m.contained : [];
    const med = ref.startsWith('#') ? contained.find((c) => c?.resourceType === 'Medication' && c.id === ref.slice(1)) : undefined;
    if (!med) v('REFERENCE_TYPE', 'MedicationDispense.medicationReference.reference', 'must reference a contained Medication (#id)');
    else product = medication(med, v, ctx);
  }

  reference(m.subject, 'Patient', 'MedicationDispense.subject.reference', v);
  if (reference(m.context, 'Encounter', 'MedicationDispense.context.reference', v)) {
    const id = String(m.context.reference).split('/')[1]!;
    if (!ctx.hasEncounter(id)) v('REFERENCE_NOT_FOUND', 'MedicationDispense.context.reference', `Encounter/${id} does not exist`, 'REFERENCE_NOT_FOUND');
  }
  const actor = Array.isArray(m.performer) && isObject(m.performer[0]) ? m.performer[0].actor : undefined;
  reference(actor, 'Practitioner', 'MedicationDispense.performer[0].actor.reference', v);

  // rule 10394: the authorizing MedicationRequest must exist
  let prescription: Record<string, any> | undefined;
  const auth = Array.isArray(m.authorizingPrescription) ? m.authorizingPrescription[0] : undefined;
  if (reference(auth, 'MedicationRequest', 'MedicationDispense.authorizingPrescription[0].reference', v)) {
    const id = String(auth.reference).split('/')[1]!;
    prescription = ctx.medicationRequest(id);
    if (!prescription) {
      v('REFERENCE_NOT_FOUND', 'MedicationDispense.authorizingPrescription[0].reference', `MedicationRequest/${id} does not exist`, 'REFERENCE_NOT_FOUND');
    }
  }

  for (const field of ['whenPrepared', 'whenHandedOver']) {
    if (m[field] === undefined) continue;
    const ms = parseUtc(m[field]);
    if (ms === null) v('TIME_FORMAT', `MedicationDispense.${field}`, 'time must be YYYY-MM-DDThh:mm:ss+00:00');
    else if (ms < FLOOR_MS) v('DATE_FLOOR', `MedicationDispense.${field}`, 'time must not be before 2014-06-03T00:00:00+00:00');
  }

  if (isObject(m.quantity) && product?.doseForm !== undefined && m.quantity.code !== product.doseForm.code) {
    v('VALUE_SET', 'MedicationDispense.quantity.code', `quantity unit must be the dose form ${product.doseForm.code} of ${product.code}`);
  }

  substitution(m.substitution, v, product, prescription ? prescribedProduct(prescription, ctx) : undefined);
  return out;
}

/** Checks the contained Medication and its batch; returns its catalogue product when it is a 93. */
function medication(med: Record<string, any>, v: Fail, ctx: MedicationDispenseRuleContext): KfaProduct | undefined {
  const ids: any[] = Array.isArray(med.identifier) ? med.identifier : [];
  if (!ids.some((i) => typeof i?.system === 'string' && MEDICATION_ID.test(i.system) && nonEmpty(i.value))) {
    v('REQUIRED', 'Medication.identifier', 'needs a valued identifier http://sys-ids.kemkes.go.id/medication/{organization id}');
  }
  const exts: any[] = Array.isArray(med.extension) ? med.extension : [];
  if (!exts.some((e) => e?.url === MEDICATION_TYPE_URL && Array.isArray(e.valueCodeableConcept?.coding) && e.valueCodeableConcept.coding.some((c: any) => c?.code === 'NC'))) {
    v('REQUIRED', 'Medication.extension', 'a non-compound medication needs the MedicationType extension with code NC');
  }
  if (med.batch !== undefined) {
    const batch = isObject(med.batch) ? med.batch : {};
    if (!nonEmpty(batch.lotNumber)) v('REQUIRED', 'Medication.batch.lotNumber', 'batch.lotNumber is required');
    if (batch.expirationDate === undefined) v('REQUIRED', 'Medication.batch.expirationDate', 'batch.expirationDate is required');
    else {
      const ms = parseDate(batch.expirationDate);
      if (ms === null) v('TIME_FORMAT', 'Medication.batch.expirationDate', 'expirationDate must be a date YYYY-MM-DD');
      else if (ms < FLOOR_MS) v('DATE_FLOOR', 'Medication.batch.expirationDate', 'date must not be before 2014-06-03');
    }
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
  if (product.level !== 93) {
    v('KFA_LEVEL', 'Medication.code', `a dispense needs a KFA 93 code; ${product.code} is ${product.level}`, 'KFA_LEVEL_INVALID');
    return undefined;
  }
  return product;
}

/** The catalogue product of a held MedicationRequest's contained Medication. */
function prescribedProduct(mr: Record<string, any>, ctx: MedicationDispenseRuleContext): KfaProduct | undefined {
  const ref = mr.medicationReference?.reference;
  const med = (Array.isArray(mr.contained) ? mr.contained : []).find((c: any) => typeof ref === 'string' && `#${c?.id}` === ref);
  const code = (Array.isArray(med?.code?.coding) ? med.code.coding : []).find((c: any) => c?.system === KFA_SYSTEM)?.code;
  return typeof code === 'string' ? ctx.kfaByCode.get(code) : undefined;
}

/**
 * `wasSubstituted` is required. Against the prescribed product: the same 93
 * or a 93 under the prescribed 92 is no substitution; another 93 with the
 * same set of 91s is one; anything else is refused. When it is one, a type,
 * a reason and the responsible practitioners must be there.
 */
function substitution(s: any, v: Fail, dispensed: KfaProduct | undefined, prescribed: KfaProduct | undefined): void {
  const path = 'MedicationDispense.substitution';
  if (!isObject(s) || typeof s.wasSubstituted !== 'boolean') {
    v('REQUIRED', `${path}.wasSubstituted`, 'substitution.wasSubstituted is required');
  }
  if (dispensed && prescribed) {
    const derived = prescribed.level === 93 ? dispensed.code === prescribed.code : dispensed.parentCode === prescribed.code;
    const ingredients = new Set(dispensed.ingredientCodes);
    const same = prescribed.ingredientCodes.length === ingredients.size && prescribed.ingredientCodes.every((c) => ingredients.has(c));
    if (!derived && !same) {
      v('KFA_PARENTAGE', 'Medication.code', `${dispensed.code} neither derives from nor shares the active ingredients of the prescribed ${prescribed.code}`, 'UNSUPPORTED_THERAPEUTIC_SUBSTITUTION');
    } else if (isObject(s) && typeof s.wasSubstituted === 'boolean' && s.wasSubstituted !== !derived) {
      v('WAS_SUBSTITUTED', `${path}.wasSubstituted`, `wasSubstituted must be ${!derived} for ${dispensed.code} against the prescribed ${prescribed.code}`, 'SUBSTITUTION_MISMATCH');
    }
  }
  if (!isObject(s) || s.wasSubstituted !== true) return;
  const types: any[] = Array.isArray(s.type?.coding) ? s.type.coding : [];
  const type = types.find((c) => c?.system === SUBSTITUTION_TYPE_SYSTEM);
  if (!type) v('REQUIRED', `${path}.type`, `a substitution needs a type from ${SUBSTITUTION_TYPE_SYSTEM}`);
  else if (!SUBSTITUTION_TYPES.has(type.code)) v('VALUE_SET', `${path}.type`, `substitution type ${String(type.code)} is not G, BC, TG or TB`);
  const reasons = Array.isArray(s.reason) ? s.reason : [];
  if (!reasons.some((r: any) => (Array.isArray(r?.coding) && r.coding.length > 0) || nonEmpty(r?.text))) {
    v('REQUIRED', `${path}.reason`, 'a substitution needs a reason');
  }
  const parties: any[] = Array.isArray(s.responsibleParty) ? s.responsibleParty : [];
  if (parties.length === 0) v('REQUIRED', `${path}.responsibleParty`, 'a substitution needs the responsible practitioners (rule 10676)');
  parties.forEach((p, i) => reference(p, 'Practitioner', `${path}.responsibleParty[${i}].reference`, v));
}

function parseDate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = DATE.exec(value);
  if (!m) return null;
  const [y, mo, d] = m.slice(1).map(Number) as [number, number, number];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? ms : null;
}
