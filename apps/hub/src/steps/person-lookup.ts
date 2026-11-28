import type { DeadLetterReason } from '../cases/case-model.js';
import type { Nik, PatientFacts, PractitionerFacts } from '../ingestion/event-schema.js';
import type { ClaimedStep } from '../outbox/outbox.js';
import type { CacheName, IhsNumberCache, LookupSource } from '../ihs-cache/ihs-number-cache.js';
import type { IhsNumber, NameBirthDateGender, SatusehatClient } from '../satusehat/client.js';
import { inSpan } from '../observability/tracing.js';
import type { AttemptFacts, LookupMethod } from './step-outcome.js';

/** Who a step looks up. */
export type LookedUpPerson = 'patient' | 'practitioner' | 'requester' | 'pharmacist';

/** A person lookup's result: the one IHS number found, or why the step dead-letters. */
export type PersonLookup = { found: IhsNumber } | { deadLettered: DeadLetterReason };

/**
 * What a person lookup searches with: SATUSEHAT, the IHS-number cache in
 * front of a practitioner's NIK search (#47), and whether the step was
 * replayed, which bypasses the cache.
 */
export interface PersonLookupDeps {
  satusehat: SatusehatClient;
  ihsCache: IhsNumberCache;
  /** Whether the step has been replayed: its lookups then search past the cache and overwrite it (#47). */
  replayed: boolean;
}

/** The lookup deps of an attempt at `step`. */
export function personLookupDeps(deps: { satusehat: SatusehatClient; ihsCache: IhsNumberCache }, step: ClaimedStep): PersonLookupDeps {
  return { satusehat: deps.satusehat, ihsCache: deps.ihsCache, replayed: step.replayedAt !== null };
}

/** One documented search, ready to run, and the lookup method it stands for. */
interface PersonSearch {
  method: LookupMethod;
  run(): Promise<{ found: IhsNumber[]; source: LookupSource }>;
}

/** A practitioner's exact NIK search, through `cache` (#47): the only search that is cached. */
function byNik(deps: PersonLookupDeps, cache: CacheName, nik: Nik, search: () => Promise<IhsNumber[]>, attempt: AttemptFacts): PersonSearch {
  return {
    method: 'nik',
    run: async () => {
      const { found, source, key } = await deps.ihsCache.findByNik(cache, nik, search, { bypass: deps.replayed });
      if (key !== null) attempt.cacheKeys.push(key);
      return { found, source };
    },
  };
}

/**
 * A search at SATUSEHAT every time: a fallback, never cached since a wrong
 * match would stick (#20), or the patient's NIK search, whose cache missed
 * the Cache run bar and was removed (#47).
 */
const remoteSearch = (method: LookupMethod, search: () => Promise<IhsNumber[]>): PersonSearch => ({
  method,
  run: async () => ({ found: await search(), source: 'remote' }),
});

/**
 * The patient's IHS number, looked up on this attempt (never pinned across
 * cases, #10) by the searches the event supplies data for, in the order
 * SATUSEHAT documents them: NIK, then mother's NIK + birthDate, then
 * name + birthDate + gender (#32). The mother's NIK search takes no
 * birthdate, so its hits are narrowed to the event's birthDate here.
 * The hub never creates a Patient. None of these searches is cached: the
 * patient cache missed the Cache run bar (#47). See `lookUp` for how results decide.
 */
export function lookUpPatient(deps: PersonLookupDeps, patient: PatientFacts, attempt: AttemptFacts): Promise<PersonLookup> {
  const { satusehat } = deps;
  const { nik, motherNik, birthDate } = patient;
  const searches: PersonSearch[] = [];
  if (nik !== undefined) searches.push(remoteSearch('nik', () => satusehat.findPatientsByNik(nik)));
  if (motherNik !== undefined && birthDate !== undefined) {
    searches.push(
      remoteSearch('mother_nik_birth_date', async () =>
        (await satusehat.findPatientsByMotherNik(motherNik)).filter((m) => m.birthDate === birthDate).map((m) => m.ihsNumber),
      ),
    );
  }
  const nameBirthDateGender = nameBirthDateGenderOf(patient);
  if (nameBirthDateGender) searches.push(remoteSearch('name_birth_date_gender', () => satusehat.findPatientsByNameBirthDateGender(nameBirthDateGender)));
  return lookUp('patient', searches, attempt);
}

/**
 * A practitioner's, requester's or pharmacist's IHS number, looked up on this
 * attempt by NIK, then by name + birthDate + gender, as far as the event
 * supplies them (#32). Only the NIK search goes through the
 * `ihs_practitioner` cache (#47). See `lookUp` for how results decide.
 */
export function lookUpPractitioner(
  deps: PersonLookupDeps,
  person: Exclude<LookedUpPerson, 'patient'>,
  practitioner: PractitionerFacts,
  attempt: AttemptFacts,
): Promise<PersonLookup> {
  const { satusehat } = deps;
  const { nik } = practitioner;
  const searches: PersonSearch[] = [];
  if (nik !== undefined) searches.push(byNik(deps, 'ihs_practitioner', nik, () => satusehat.findPractitionersByNik(nik), attempt));
  const nameBirthDateGender = nameBirthDateGenderOf(practitioner);
  if (nameBirthDateGender) searches.push(remoteSearch('name_birth_date_gender', () => satusehat.findPractitionersByNameBirthDateGender(nameBirthDateGender)));
  return lookUp(person, searches, attempt);
}

/**
 * Runs `searches` in order until one finds someone. Exactly one match is the
 * person, and its method goes in the attempt log. More than one is ambiguous
 * and stops the lookup: a weaker search never breaks a tie. No match from
 * any search is not found. Both dead-letter the step permanently: the same
 * data would find the same records on a retry.
 */
function lookUp(person: LookedUpPerson, searches: readonly PersonSearch[], attempt: AttemptFacts): Promise<PersonLookup> {
  // One `ihs.lookup` span per person (#42): the searches it ran are its children.
  return inSpan('ihs.lookup', { person }, async (span) => {
    const found = await runLookUp(person, searches, attempt);
    span.setAttribute('lookup.result', 'found' in found ? 'found' : found.deadLettered);
    const method = attempt.lookupMethods[person];
    if ('found' in found && method !== undefined) span.setAttribute('lookup.method', method);
    return found;
  });
}

async function runLookUp(person: LookedUpPerson, searches: readonly PersonSearch[], attempt: AttemptFacts): Promise<PersonLookup> {
  const reason = person === 'patient' ? ({ notFound: 'PATIENT_NOT_FOUND', ambiguous: 'PATIENT_AMBIGUOUS' } as const)
    : ({ notFound: 'PRACTITIONER_NOT_FOUND', ambiguous: 'PRACTITIONER_AMBIGUOUS' } as const);
  for (const search of searches) {
    const { found, source } = await search.run();
    // The client resolves only on the 200 it expects; a cache hit read nothing from SATUSEHAT.
    if (source === 'remote') attempt.httpStatus = 200;
    const [match] = found;
    if (found.length > 1) return { deadLettered: reason.ambiguous };
    if (match) {
      attempt.lookupMethods[person] = search.method;
      attempt.lookupSources[person] = source;
      return { found: match };
    }
  }
  return { deadLettered: reason.notFound };
}

/** Name + birthDate + gender when the event carries all three. */
function nameBirthDateGenderOf(person: PractitionerFacts): NameBirthDateGender | undefined {
  const { name, birthDate, gender } = person;
  return name !== undefined && birthDate !== undefined && gender !== undefined ? { name, birthDate, gender } : undefined;
}
