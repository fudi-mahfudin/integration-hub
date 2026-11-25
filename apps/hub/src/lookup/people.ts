import type { FhirClient } from '../satusehat/fhir-client.js';

/** SATUSEHAT's NIK identifier system for Patient and Practitioner search. */
export const NIK_SYSTEM = 'https://fhir.kemkes.go.id/id/nik';

/** A person as a source event carries them (#6). */
export interface SourcePerson {
  nik?: string;
  motherNik?: string;
  name?: string;
  birthDate?: string;
  gender?: string;
}

/** How a person's IHS number was found (#10); #32 adds `motherNik` and `nameBirthDateGender`. */
export type LookupMethod = 'nik';

export interface PersonMatch {
  ihsNumber: string;
  method: LookupMethod;
}

/**
 * Resolves a person to their IHS number, looked up on every attempt and never
 * stored across cases (#10). NIK only for now; the documented fallbacks
 * (mother's NIK, name + birthDate + gender) are #32's. Exactly one match
 * counts; none (or an ambiguous answer) is undefined.
 */
export async function findIhsNumber(
  fhir: FhirClient,
  type: 'Patient' | 'Practitioner',
  person: SourcePerson,
): Promise<PersonMatch | undefined> {
  if (person.nik === undefined) return undefined;
  const hits = await fhir.search(type, { identifier: `${NIK_SYSTEM}|${person.nik}` });
  const id = hits.length === 1 ? hits[0]?.id : undefined;
  return id === undefined ? undefined : { ihsNumber: id, method: 'nik' };
}
