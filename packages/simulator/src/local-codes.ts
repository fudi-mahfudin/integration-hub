/**
 * The simulated source system's own local codes: what its pharmacy calls each
 * drug, and the clinics where its visits happen. The operator maps them to
 * national codes in the hub's mapping seed (`apps/hub/seed`); a test keeps the
 * two in step with each other and with the world dataset.
 */

/** A local drug code and the KFA code (92 or 93) of the product it names. */
export interface LocalDrugCode {
  /** What the source system calls the drug. */
  drugCode: string;
  /** The KFA code of the product it names. */
  kfaCode: string;
}

/** Every drug the simulated pharmacy prescribes or dispenses. */
export const LOCAL_DRUG_CODES: readonly LocalDrugCode[] = [
  { drugCode: 'PCT500', kfaCode: '92000001' },
  { drugCode: 'PCT500-FFA', kfaCode: '93000001' },
  { drugCode: 'PCT500-FFB', kfaCode: '93000002' },
  { drugCode: 'PCT650', kfaCode: '92000002' },
  { drugCode: 'PCT650-FFA', kfaCode: '93000003' },
  { drugCode: 'AMX500', kfaCode: '92000003' },
  { drugCode: 'AMX500-FFC', kfaCode: '93000004' },
  { drugCode: 'AMX500-FFD', kfaCode: '93000005' },
  { drugCode: 'AMXCLV', kfaCode: '92000004' },
  { drugCode: 'AMXCLV-FFC', kfaCode: '93000006' },
  { drugCode: 'IBU400', kfaCode: '92000005' },
  { drugCode: 'IBU400-FFB', kfaCode: '93000007' },
  { drugCode: 'MET500', kfaCode: '92000006' },
  { drugCode: 'MET500-FFD', kfaCode: '93000008' },
  { drugCode: 'AML5', kfaCode: '92000007' },
  { drugCode: 'AML5-FFA', kfaCode: '93000009' },
  { drugCode: 'AML10', kfaCode: '92000008' },
  { drugCode: 'AML10-FFA', kfaCode: '93000010' },
];

/** A clinic a visit starts at, by local location code, and the encounter class its visits have. */
export interface VisitLocation {
  /** What the source system calls the clinic. */
  locationCode: string;
  /** The `encounterClass` a visit there is sent with. */
  encounterClass: 'AMB' | 'EMER';
}

/**
 * The clinics visits start at. The pharmacy's own location (`FARMASI-RJ`) is
 * left out: the outpatient-pharmacy visit flow is not supported.
 */
export const VISIT_LOCATIONS: readonly VisitLocation[] = [
  { locationCode: 'POLI-UMUM', encounterClass: 'AMB' },
  { locationCode: 'POLI-ANAK', encounterClass: 'AMB' },
  { locationCode: 'POLI-PENYAKIT-DALAM', encounterClass: 'AMB' },
  { locationCode: 'IGD', encounterClass: 'EMER' },
];
