import { z } from 'zod';
import type { OrganizationId } from '../auth/source-systems.js';
import type { Brand } from '../brand.js';
import type { SatusehatConfig } from '../config.js';
import { SatusehatRequestError } from './errors.js';
import { platformTime } from './platform-time.js';
import type { AccessTokens } from './token.js';

/** A SATUSEHAT patient's or practitioner's IHS number. */
export type IhsNumber = Brand<string, 'IhsNumber'>;

/** A SATUSEHAT Location id. */
export type LocationId = Brand<string, 'LocationId'>;

/** A record SATUSEHAT holds, by its remote identifier and version. */
export interface RemoteRecord {
  type: 'Encounter';
  id: string;
  /** `meta.versionId`, when SATUSEHAT sends one. */
  version: string | null;
}

/** The visit's business identifier (ADR 0005): `encounter/{org}|{visitId}`. */
export interface VisitIdentifier {
  organizationId: OrganizationId;
  visitId: string;
}

/** What a create-visit Encounter says about its visit. */
export interface VisitEncounter {
  identifier: VisitIdentifier;
  encounterClass: 'AMB' | 'IMP' | 'EMER';
  patient: IhsNumber;
  practitioner: IhsNumber;
  location: LocationId;
  startedAt: Date;
}

/**
 * The SATUSEHAT calls the hub makes, one method per call, so each can be
 * faked with one return shape. Unexpected answers throw `SatusehatRequestError`.
 */
export interface SatusehatClient {
  /** IHS numbers of the patients found by NIK (`Patient?identifier=…/nik|{nik}`). */
  findPatientsByNik(nik: string): Promise<IhsNumber[]>;
  /** IHS numbers of the practitioners found by NIK. */
  findPractitionersByNik(nik: string): Promise<IhsNumber[]>;
  /** Every Encounter under the visit's business identifier. */
  findEncounters(identifier: VisitIdentifier): Promise<RemoteRecord[]>;
  /** Creates the visit's Encounter, status `arrived`; resolves to the record SATUSEHAT stored. */
  createEncounter(encounter: VisitEncounter): Promise<RemoteRecord>;
}

const NIK_SYSTEM = 'https://fhir.kemkes.go.id/id/nik';
const encounterSystem = (org: OrganizationId) => `http://sys-ids.kemkes.go.id/encounter/${org}`;

const CLASS_DISPLAY = { AMB: 'ambulatory', IMP: 'inpatient encounter', EMER: 'emergency' } as const;

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

  async function call(method: 'GET' | 'POST', path: string, expected: number, body?: unknown): Promise<unknown> {
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
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`SATUSEHAT ${method} ${url.pathname} answered ${res.status} with a body that is not JSON`, { cause: err });
    }
  }

  async function search(resourceType: string, identifier: string): Promise<z.infer<typeof storedRecordSchema>[]> {
    const path = `${resourceType}?${new URLSearchParams({ identifier })}`;
    const bundle = searchBundleSchema.parse(await call('GET', path, 200));
    return (bundle.entry ?? []).map((e) => e.resource);
  }

  // The resource id of a Patient or Practitioner is its IHS number.
  const ihsNumbers = (hits: { id: string }[]) => hits.map((h) => h.id as IhsNumber);
  const encounterRecord = (r: z.infer<typeof storedRecordSchema>): RemoteRecord => ({
    type: 'Encounter',
    id: r.id,
    version: r.meta?.versionId ?? null,
  });

  return {
    findPatientsByNik: async (nik) => ihsNumbers(await search('Patient', `${NIK_SYSTEM}|${nik}`)),
    findPractitionersByNik: async (nik) => ihsNumbers(await search('Practitioner', `${NIK_SYSTEM}|${nik}`)),
    findEncounters: async ({ organizationId, visitId }) =>
      (await search('Encounter', `${encounterSystem(organizationId)}|${visitId}`)).map(encounterRecord),
    async createEncounter(encounter) {
      const stored = storedRecordSchema.parse(await call('POST', 'Encounter', 201, visitEncounterResource(encounter)));
      return encounterRecord(stored);
    },
  };
}

/** The FHIR R4 Encounter of a visit that has just started. */
function visitEncounterResource(e: VisitEncounter): Record<string, unknown> {
  const start = platformTime(e.startedAt);
  return {
    resourceType: 'Encounter',
    identifier: [{ system: encounterSystem(e.identifier.organizationId), value: e.identifier.visitId }],
    status: 'arrived',
    class: {
      system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
      code: e.encounterClass,
      display: CLASS_DISPLAY[e.encounterClass],
    },
    subject: { reference: `Patient/${e.patient}` },
    participant: [
      {
        type: [
          {
            coding: [
              { system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'ATND', display: 'attender' },
            ],
          },
        ],
        individual: { reference: `Practitioner/${e.practitioner}` },
      },
    ],
    period: { start },
    location: [{ location: { reference: `Location/${e.location}` } }],
    statusHistory: [{ status: 'arrived', period: { start } }],
    serviceProvider: { reference: `Organization/${e.identifier.organizationId}` },
  };
}
