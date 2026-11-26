import type { DeadLetterReason } from '../cases/case-model.js';
import type { PatientFacts, PractitionerFacts } from '../ingestion/event-schema.js';
import type { IhsNumber, NameBirthDateGender, SatusehatClient } from '../satusehat/client.js';
import type { AttemptFacts, LookupMethod } from './step-outcome.js';

/** Who a step looks up. */
export type LookedUpPerson = 'patient' | 'practitioner' | 'requester' | 'pharmacist';

/** A person lookup's result: the one IHS number found, or why the step dead-letters. */
export type PersonLookup = { found: IhsNumber } | { deadLettered: DeadLetterReason };

/** One documented search, ready to run, and the lookup method it stands for. */
interface PersonSearch {
  method: LookupMethod;
  run(): Promise<IhsNumber[]>;
}

/**
 * The patient's IHS number, looked up on this attempt (never stored across
 * cases, #10) by the searches the event supplies data for, in the order
 * SATUSEHAT documents them: NIK, then mother's NIK + birthDate, then
 * name + birthDate + gender (#32). The mother's NIK search takes no
 * birthdate, so its hits are narrowed to the event's birthDate here.
 * The hub never creates a Patient. See `lookUp` for how results decide.
 */
export function lookUpPatient(satusehat: SatusehatClient, patient: PatientFacts, attempt: AttemptFacts): Promise<PersonLookup> {
  const { nik, motherNik, birthDate } = patient;
  const searches: PersonSearch[] = [];
  if (nik !== undefined) searches.push({ method: 'nik', run: () => satusehat.findPatientsByNik(nik) });
  if (motherNik !== undefined && birthDate !== undefined) {
    searches.push({
      method: 'mother_nik_birth_date',
      run: async () => (await satusehat.findPatientsByMotherNik(motherNik)).filter((m) => m.birthDate === birthDate).map((m) => m.ihsNumber),
    });
  }
  const nameBirthDateGender = nameBirthDateGenderOf(patient);
  if (nameBirthDateGender) searches.push({ method: 'name_birth_date_gender', run: () => satusehat.findPatientsByNameBirthDateGender(nameBirthDateGender) });
  return lookUp('patient', searches, attempt);
}

/**
 * A practitioner's, requester's or pharmacist's IHS number, looked up on this
 * attempt by NIK, then by name + birthDate + gender, as far as the event
 * supplies them (#32). See `lookUp` for how results decide.
 */
export function lookUpPractitioner(
  satusehat: SatusehatClient,
  person: Exclude<LookedUpPerson, 'patient'>,
  practitioner: PractitionerFacts,
  attempt: AttemptFacts,
): Promise<PersonLookup> {
  const { nik } = practitioner;
  const searches: PersonSearch[] = [];
  if (nik !== undefined) searches.push({ method: 'nik', run: () => satusehat.findPractitionersByNik(nik) });
  const nameBirthDateGender = nameBirthDateGenderOf(practitioner);
  if (nameBirthDateGender) searches.push({ method: 'name_birth_date_gender', run: () => satusehat.findPractitionersByNameBirthDateGender(nameBirthDateGender) });
  return lookUp(person, searches, attempt);
}

/**
 * Runs `searches` in order until one finds someone. Exactly one match is the
 * person, and its method goes in the attempt log. More than one is ambiguous
 * and stops the lookup: a weaker search never breaks a tie. No match from
 * any search is not found. Both dead-letter the step permanently: the same
 * data would find the same records on a retry.
 */
async function lookUp(person: LookedUpPerson, searches: readonly PersonSearch[], attempt: AttemptFacts): Promise<PersonLookup> {
  const reason = person === 'patient' ? ({ notFound: 'PATIENT_NOT_FOUND', ambiguous: 'PATIENT_AMBIGUOUS' } as const)
    : ({ notFound: 'PRACTITIONER_NOT_FOUND', ambiguous: 'PRACTITIONER_AMBIGUOUS' } as const);
  for (const search of searches) {
    const found = await search.run();
    // The client resolves only on the 200 it expects.
    attempt.httpStatus = 200;
    const [match] = found;
    if (found.length > 1) return { deadLettered: reason.ambiguous };
    if (match) {
      attempt.lookupMethods[person] = search.method;
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
