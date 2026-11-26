import { z } from 'zod';
import type { OrganizationId } from '../auth/source-systems.js';
import type { Brand } from '../brand.js';
import type { RemoteId, RemoteIdentifier, VisitId } from '../cases/case-model.js';
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
  prescriptionId: string;
}

/**
 * The SATUSEHAT calls the hub makes, one method per call, so each can be
 * faked with one return shape. An unexpected status throws
 * `SatusehatRequestError`; a body of the wrong shape throws `SatusehatResponseError`.
 */
export interface SatusehatClient {
  /** IHS numbers of the patients found by NIK (`Patient?identifier=…/nik|{nik}`). */
  findPatientsByNik(nik: string): Promise<IhsNumber[]>;
  /** IHS numbers of the practitioners found by NIK. */
  findPractitionersByNik(nik: string): Promise<IhsNumber[]>;
  /** Every Encounter under the visit's business identifier. */
  findEncounters(identifier: VisitIdentifier): Promise<RemoteIdentifier[]>;
  /** Sends a built Encounter (see `visitEncounterResource`); resolves to the record SATUSEHAT stored. */
  createEncounter(encounter: FhirResource): Promise<RemoteIdentifier>;
  /** Every MedicationRequest under the prescription's business identifier. */
  findMedicationRequests(identifier: PrescriptionIdentifier): Promise<RemoteIdentifier[]>;
  /** Sends a built MedicationRequest (see `prescriptionMedicationRequestResource`); resolves to the record SATUSEHAT stored. */
  createMedicationRequest(medicationRequest: FhirResource): Promise<RemoteIdentifier>;
}

const NIK_SYSTEM = 'https://fhir.kemkes.go.id/id/nik';

const storedRecordSchema = z.object({ id: z.string().min(1), meta: z.object({ versionId: z.string().optional() }).optional() });
const searchBundleSchema = z.object({
  resourceType: z.literal('Bundle'),
  entry: z.array(z.object({ resource: storedRecordSchema })).optional(),
});

/** Builds the SATUSEHAT client over one process's access tokens. Only the composition root calls this. */
export function createSatusehatClient(deps: {
  config: Pick<SatusehatConfig, 'fhirUrl'>;
  tokens: AccessTokens;
}): SatusehatClient {
  const { config, tokens } = deps;

  async function call(
    method: 'GET' | 'POST',
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

  async function search(resourceType: string, identifier: string): Promise<z.infer<typeof storedRecordSchema>[]> {
    const path = `${resourceType}?${new URLSearchParams({ identifier })}`;
    const bundle = parse(searchBundleSchema, 'GET', await call('GET', path, 200));
    return (bundle.entry ?? []).map((e) => e.resource);
  }

  // The resource id of a Patient or Practitioner is its IHS number.
  const ihsNumbers = (hits: { id: string }[]) => hits.map((h) => h.id as IhsNumber);
  const record =
    (type: RemoteIdentifier['type']) =>
    (r: z.infer<typeof storedRecordSchema>): RemoteIdentifier => ({
      type,
      // SATUSEHAT assigned this id to the record.
      id: r.id as RemoteId,
      version: r.meta?.versionId ?? null,
    });
  const encounterRecord = record('Encounter');
  const medicationRequestRecord = record('MedicationRequest');

  return {
    findPatientsByNik: async (nik) => ihsNumbers(await search('Patient', `${NIK_SYSTEM}|${nik}`)),
    findPractitionersByNik: async (nik) => ihsNumbers(await search('Practitioner', `${NIK_SYSTEM}|${nik}`)),
    findEncounters: async ({ organizationId, visitId }) =>
      (await search('Encounter', `${encounterSystem(organizationId)}|${visitId}`)).map(encounterRecord),
    async createEncounter(encounter) {
      const stored = parse(storedRecordSchema, 'POST', await call('POST', 'Encounter', 201, encounter));
      return encounterRecord(stored);
    },
    findMedicationRequests: async ({ organizationId, prescriptionId }) =>
      (await search('MedicationRequest', `${prescriptionSystem(organizationId)}|${prescriptionId}`)).map(medicationRequestRecord),
    async createMedicationRequest(medicationRequest) {
      const stored = parse(storedRecordSchema, 'POST', await call('POST', 'MedicationRequest', 201, medicationRequest));
      return medicationRequestRecord(stored);
    },
  };
}
