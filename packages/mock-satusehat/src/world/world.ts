import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The synthetic world: every person, place, organization and KFA product the
 * mock knows. One dataset (issue #12) shared by the mock, the source simulator
 * and the hub's mapping seed. Every value is fake.
 */
export interface World {
  organization: WorldOrganization;
  locations: WorldLocation[];
  patients: WorldPatient[];
  practitioners: WorldPractitioner[];
  kfaProducts: KfaProduct[];
  /** Values that must never appear in hub logs or traces (redaction tests, #15). */
  canaries: { patientNik: string; patientIhs: string; patientName: string; practitionerNik: string };
}

export interface WorldOrganization {
  id: string;
  name: string;
  /** client_credentials accepted by the token endpoint for this organization. */
  clientId: string;
  clientSecret: string;
}

export interface WorldLocation {
  id: string;
  name: string;
  organizationId: string;
}

export type Gender = 'male' | 'female';

export type NearMissKind =
  | 'nik_one_digit'
  | 'same_name_birthdate_other_gender'
  | 'same_name_gender_birthdate_off_by_one_day'
  | 'same_mother_nik';

export interface WorldPatient {
  /** IHS number. */
  ihs: string;
  nik: string;
  motherNik: string | null;
  name: string;
  birthDate: string;
  gender: Gender;
  /** Set on a patient deliberately built to almost match another one. */
  nearMiss?: { kind: NearMissKind; ofNik: string };
}

export interface WorldPractitioner {
  ihs: string;
  nik: string;
  name: string;
  birthDate: string;
  gender: Gender;
  role: 'physician' | 'pharmacist';
}

export interface KfaProduct {
  code: string;
  level: 91 | 92 | 93;
  display: string;
  /** For a 93: its 92. */
  parentCode?: string;
  /** The set of 91 codes (active ingredients). Empty for a 91 itself. */
  ingredientCodes: string[];
  /**
   * For a 92 or 93: its dose form, the unit of a prescribed quantity (#6).
   * Synthetic: `code` is a v3-orderableDrugForm code (TAB, CAP), where real
   * KFA uses its own dose-form codes.
   */
  doseForm?: { code: string; name: string };
}

/** Partial world accepted by `POST /__mock/seed`; entries live until the next reset. */
export interface WorldSeed {
  locations?: WorldLocation[];
  patients?: WorldPatient[];
  practitioners?: WorldPractitioner[];
  kfaProducts?: KfaProduct[];
}

export const defaultWorldPath = fileURLToPath(new URL('../../world/world.json', import.meta.url));

export function loadWorld(path: string = defaultWorldPath): World {
  return JSON.parse(readFileSync(path, 'utf8')) as World;
}
