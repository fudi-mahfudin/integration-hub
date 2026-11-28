import type { World } from '@integration-hub/mock-satusehat/world';

/**
 * The records a contract check refers to on one platform. They differ by
 * value between the sandbox and the mock, which is why the answers are
 * compared by shape only.
 */
export interface Subjects {
  /** Our Location, created once by the wizard on the sandbox; a world location on the mock. */
  locationId: string;
  /** NIK of the patient searched for and recorded on. */
  patientNik: string;
  /** NIK of the prescriber: a practitioner who is not a pharmacist. */
  practitionerNik: string;
  /** NIK of the dispensing pharmacist. */
  pharmacistNik: string;
  /** A KFA 93 (actual product) code with a dose form, prescribed and dispensed. */
  kfaProductCode: string;
}

/** One SATUSEHAT a contract check sends its requests to: the sandbox or the mock. */
export interface Target {
  /** OAuth base, ending in `/`, e.g. `https://…/oauth2/v1/`. */
  authUrl: URL;
  /** FHIR base, ending in `/`. */
  fhirUrl: URL;
  /** KFA v2 base, ending in `/`; configured apart from FHIR (#14). */
  kfaUrl: URL;
  clientId: string;
  clientSecret: string;
  /** The Organization the credentials are bound to: the `{org}` of our identifier systems. */
  organizationId: string;
  subjects: Subjects;
}

/** A mock SATUSEHAT at `baseUrl` serving `world`, as a target: its world organization and first fitting records. */
export function mockTarget(baseUrl: URL, world: World): Target {
  const pick = <T>(what: string, found: T | undefined): T => {
    if (found === undefined) throw new Error(`the mock's world dataset must hold ${what}, found none`);
    return found;
  };
  return {
    authUrl: new URL('oauth2/v1/', baseUrl),
    fhirUrl: new URL('fhir-r4/v1/', baseUrl),
    kfaUrl: new URL('kfa-v2/', baseUrl),
    clientId: world.organization.clientId,
    clientSecret: world.organization.clientSecret,
    organizationId: world.organization.id,
    subjects: {
      locationId: pick('a location', world.locations[0]).id,
      patientNik: pick('a patient', world.patients[0]).nik,
      practitionerNik: pick('a physician', world.practitioners.find((p) => p.role === 'physician')).nik,
      pharmacistNik: pick('a pharmacist', world.practitioners.find((p) => p.role === 'pharmacist')).nik,
      kfaProductCode: pick('a KFA 93 product', world.kfaProducts.find((p) => p.level === 93)).code,
    },
  };
}
