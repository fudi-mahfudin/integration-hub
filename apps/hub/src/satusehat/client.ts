import { z } from 'zod';
import type { OrganizationId } from '../auth/source-systems.js';
import type { Brand } from '../brand.js';
import type { PrescriptionId, RemoteId, RemoteIdentifier, VisitId } from '../cases/case-model.js';
import type { SatusehatConfig } from '../config.js';
import { SatusehatRequestError, SatusehatResponseError } from './errors.js';
import { encounterSystem, prescriptionSystem, type FhirResource } from './resources.js';
import type { AccessTokens } from './token.js';

/** A SATUSEHAT patient's or practitioner's IHS number. */
export type IhsNumber = Brand<string, 'IhsNumber'>;

/** A SATUSEHAT Location id. */
export type LocationId = Brand<string, 'LocationId'>;

/** The visit's business identifier (ADR 0005): `encounter/{org}|{visitId}`. */
export interface VisitIdentifier {
  organizationId: OrganizationId;
  visitId: VisitId;
}

/** A prescription's business identifier (ADR 0005): `prescription/{org}|{prescriptionId}`. */
export interface PrescriptionIdentifier {
  organizationId: OrganizationId;
  prescriptionId: PrescriptionId;
}

/** The name, birthdate and gender SATUSEHAT finds a person by when there is no NIK. */
export interface NameBirthDateGender {
  name: string;
  /** A calendar date `YYYY-MM-DD`. */
  birthDate: string;
  gender: 'male' | 'female';
}

/** A patient a mother's NIK search found: its IHS number and `birthDate`, null when SATUSEHAT holds none. */
export interface MotherNikMatch {
  ihsNumber: IhsNumber;
  birthDate: string | null;
}

/** An Encounter a search found: its remote identifier, and how far the visit it records has got. */
export interface FoundEncounter {
  remote: RemoteIdentifier;
  /** `status`, as SATUSEHAT holds it. */
  status: string;
  /** `period.end` as SATUSEHAT holds it; null when it has none. */
  periodEnd: string | null;
}

/**
 * The SATUSEHAT calls the hub makes, one method per call, so each can be
 * faked with one return shape. An unexpected status throws
 * `SatusehatRequestError`; a body of the wrong shape throws `SatusehatResponseError`.
 */
export interface SatusehatClient {
  /** IHS numbers of the patients found by NIK (`Patient?identifier=…/nik|{nik}`). */
  findPatientsByNik(nik: string): Promise<IhsNumber[]>;
  /**
   * The children of the mother with NIK `motherNik` (`Patient?identifier=…/nik-ibu|{nik}`),
   * each with its birthDate; SATUSEHAT documents no birthdate parameter for this search.
   */
  findPatientsByMotherNik(motherNik: string): Promise<MotherNikMatch[]>;
  /** IHS numbers of the patients found by name, birthdate and gender (`Patient?name=&birthdate=&gender=`). */
  findPatientsByNameBirthDateGender(person: NameBirthDateGender): Promise<IhsNumber[]>;
  /** IHS numbers of the practitioners found by NIK. */
  findPractitionersByNik(nik: string): Promise<IhsNumber[]>;
  /** IHS numbers of the practitioners found by name, birthdate and gender (`Practitioner?name=&birthdate=&gender=`). */
  findPractitionersByNameBirthDateGender(person: NameBirthDateGender): Promise<IhsNumber[]>;
  /** Every Encounter under the visit's business identifier. */
  findEncounters(identifier: VisitIdentifier): Promise<FoundEncounter[]>;
  /** Sends a built Encounter (see `visitEncounterResource`); resolves to the record SATUSEHAT stored. */
  createEncounter(encounter: FhirResource): Promise<RemoteIdentifier>;
  /**
   * Replaces Encounter `id` with a built one (see `finishedEncounterResource`),
   * `PUT Encounter/{id}`; resolves to the record SATUSEHAT stored, with its new `meta.versionId`.
   */
  updateEncounter(id: RemoteId, encounter: FhirResource): Promise<RemoteIdentifier>;
  /** Every MedicationRequest under the prescription's business identifier. */
  findMedicationRequests(identifier: PrescriptionIdentifier): Promise<RemoteIdentifier[]>;
  /** Sends a built MedicationRequest (see `prescriptionMedicationRequestResource`); resolves to the record SATUSEHAT stored. */
  createMedicationRequest(medicationRequest: FhirResource): Promise<RemoteIdentifier>;
  /** Every MedicationDispense under the prescription's business identifier (a dispense reuses it, #9). */
  findMedicationDispenses(identifier: PrescriptionIdentifier): Promise<RemoteIdentifier[]>;
  /** Sends a built MedicationDispense (see `dispenseMedicationDispenseResource`); resolves to the record SATUSEHAT stored. */
  createMedicationDispense(medicationDispense: FhirResource): Promise<RemoteIdentifier>;
}

const NIK_SYSTEM = 'https://fhir.kemkes.go.id/id/nik';
const MOTHER_NIK_SYSTEM = 'https://fhir.kemkes.go.id/id/nik-ibu';

const storedRecordSchema = z.object({ id: z.string().min(1), meta: z.object({ versionId: z.string().optional() }).optional() });
const searchBundleSchema = z.object({
  resourceType: z.literal('Bundle'),
  // Each hit is parsed by its caller's schema, which may need more than an id.
  entry: z.array(z.object({ resource: z.unknown() })).optional(),
});
const motherNikMatchSchema = storedRecordSchema.extend({ birthDate: z.string().optional() });
const foundEncounterSchema = storedRecordSchema.extend({
  status: z.string().min(1),
  period: z.object({ end: z.string().optional() }).optional(),
});

/** Builds the SATUSEHAT client over one process's access tokens. Only the composition root calls this. */
export function createSatusehatClient(deps: {
  config: Pick<SatusehatConfig, 'fhirUrl'>;
  tokens: AccessTokens;
}): SatusehatClient {
  const { config, tokens } = deps;

  async function call(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    expected: number,
    body?: unknown,
  ): Promise<{ url: URL; json: unknown }> {
    const url = new URL(path, config.fhirUrl);
    const token = await tokens.current();
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/fhir+json',
        ...(body === undefined ? {} : { 'content-type': 'application/fhir+json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (res.status !== expected) throw new SatusehatRequestError(method, url, res.status, text);
    try {
      return { url, json: JSON.parse(text) };
    } catch (err) {
      throw new SatusehatResponseError(method, url, 'a body that is not JSON', { cause: err });
    }
  }

  /** Parses a response body at the boundary; a wrong shape is a `SatusehatResponseError`. */
  function parse<T>(schema: z.ZodType<T>, method: string, { url, json }: { url: URL; json: unknown }): T {
    const parsed = schema.safeParse(json);
    if (parsed.success) return parsed.data;
    const problems = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new SatusehatResponseError(method, url, `an unexpected body; ${problems.join('; ')}`);
  }

  /** A search by `identifier`, or by the given parameters. */
  async function search(resourceType: string, query: string | Record<string, string>): Promise<{ url: URL; json: unknown }[]> {
    const path = `${resourceType}?${new URLSearchParams(typeof query === 'string' ? { identifier: query } : query)}`;
    const answer = await call('GET', path, 200);
    const bundle = parse(searchBundleSchema, 'GET', answer);
    return (bundle.entry ?? []).map((e) => ({ url: answer.url, json: e.resource }));
  }
  const searchRecords = async (resourceType: string, query: string | Record<string, string>) =>
    (await search(resourceType, query)).map((hit) => parse(storedRecordSchema, 'GET', hit));

  // The resource id of a Patient or Practitioner is its IHS number.
  const ihsNumbers = (hits: { id: string }[]) => hits.map((h) => h.id as IhsNumber);
  const remoteIdentifierOf =
    (type: RemoteIdentifier['type']) =>
    (r: z.infer<typeof storedRecordSchema>): RemoteIdentifier => ({
      type,
      // SATUSEHAT assigned this id to the record.
      id: r.id as RemoteId,
      version: r.meta?.versionId ?? null,
    });
  const encounterRecord = remoteIdentifierOf('Encounter');
  const medicationRequestRecord = remoteIdentifierOf('MedicationRequest');
  const medicationDispenseRecord = remoteIdentifierOf('MedicationDispense');

  return {
    findPatientsByNik: async (nik) => ihsNumbers(await searchRecords('Patient', `${NIK_SYSTEM}|${nik}`)),
    findPatientsByMotherNik: async (motherNik) =>
      (await search('Patient', `${MOTHER_NIK_SYSTEM}|${motherNik}`)).map((hit) => {
        const found = parse(motherNikMatchSchema, 'GET', hit);
        // The resource id of a Patient is its IHS number.
        return { ihsNumber: found.id as IhsNumber, birthDate: found.birthDate ?? null };
      }),
    findPatientsByNameBirthDateGender: async (person) => ihsNumbers(await searchRecords('Patient', nameBirthDateGenderQuery(person))),
    findPractitionersByNik: async (nik) => ihsNumbers(await searchRecords('Practitioner', `${NIK_SYSTEM}|${nik}`)),
    findPractitionersByNameBirthDateGender: async (person) => ihsNumbers(await searchRecords('Practitioner', nameBirthDateGenderQuery(person))),
    findEncounters: async ({ organizationId, visitId }) =>
      (await search('Encounter', `${encounterSystem(organizationId)}|${visitId}`)).map((hit) => {
        const found = parse(foundEncounterSchema, 'GET', hit);
        return { remote: encounterRecord(found), status: found.status, periodEnd: found.period?.end ?? null };
      }),
    async createEncounter(encounter) {
      const stored = parse(storedRecordSchema, 'POST', await call('POST', 'Encounter', 201, encounter));
      return encounterRecord(stored);
    },
    async updateEncounter(id, encounter) {
      const stored = parse(storedRecordSchema, 'PUT', await call('PUT', `Encounter/${encodeURIComponent(id)}`, 200, encounter));
      return encounterRecord(stored);
    },
    findMedicationRequests: async ({ organizationId, prescriptionId }) =>
      (await searchRecords('MedicationRequest', `${prescriptionSystem(organizationId)}|${prescriptionId}`)).map(medicationRequestRecord),
    async createMedicationRequest(medicationRequest) {
      const stored = parse(storedRecordSchema, 'POST', await call('POST', 'MedicationRequest', 201, medicationRequest));
      return medicationRequestRecord(stored);
    },
    findMedicationDispenses: async ({ organizationId, prescriptionId }) =>
      (await searchRecords('MedicationDispense', `${prescriptionSystem(organizationId)}|${prescriptionId}`)).map(medicationDispenseRecord),
    async createMedicationDispense(medicationDispense) {
      const stored = parse(storedRecordSchema, 'POST', await call('POST', 'MedicationDispense', 201, medicationDispense));
      return medicationDispenseRecord(stored);
    },
  };
}

/** The documented name + birthdate + gender search parameters. */
function nameBirthDateGenderQuery({ name, birthDate, gender }: NameBirthDateGender): Record<string, string> {
  return { name, birthdate: birthDate, gender };
}
