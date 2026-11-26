import type { IhsNumber } from '../satusehat/client.js';
import type { AttemptFacts } from './step-outcome.js';

/** Who a step looks up by NIK. */
export type LookedUpPerson = 'patient' | 'practitioner' | 'requester' | 'pharmacist';

/**
 * A person the hub cannot resolve by NIK alone: the event names them without
 * a NIK, or more than one record has it. The fallback lookups and their
 * ambiguity rules land with #32; until then the attempt fails without an
 * outcome, so the step is not dead-lettered under a wrong reason.
 */
export class PersonLookupUnresolved extends Error {
  constructor(
    readonly person: LookedUpPerson,
    readonly matches: number | null,
  ) {
    super(
      matches === null
        ? `the ${person} has no NIK; lookups other than by NIK are not supported yet (#32)`
        : `${matches} records share the ${person}'s NIK; an ambiguous lookup is not supported yet (#32)`,
    );
    this.name = 'PersonLookupUnresolved';
  }
}

/**
 * The one IHS number found for `nik`, or `undefined` when no one has it;
 * notes the search's status on the attempt.
 * @throws PersonLookupUnresolved when there is no NIK, or more than one match.
 */
export async function lookUpByNik(
  person: LookedUpPerson,
  nik: string | undefined,
  find: (nik: string) => Promise<IhsNumber[]>,
  attempt: AttemptFacts,
): Promise<IhsNumber | undefined> {
  if (nik === undefined) throw new PersonLookupUnresolved(person, null);
  const found = await find(nik);
  // The client resolves only on the 200 it expects.
  attempt.httpStatus = 200;
  if (found.length > 1) throw new PersonLookupUnresolved(person, found.length);
  return found[0];
}
