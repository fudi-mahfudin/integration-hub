/**
 * The SATUSEHAT identifier and code systems the hub sends (#6, #9): one
 * place for the step builders and the Validation module's payload rules.
 */

/** The `sys-ids` kinds the hub uses (#9); the `/{subsystem}` and `medicationdispense/{org}` variants are not. */
export type SysIdKind = 'encounter' | 'prescription' | 'prescription-item' | 'medication';

/** `http://sys-ids.kemkes.go.id/{kind}/{org}`: an organization's identifier system of that kind. */
export const sysIdSystem = (kind: SysIdKind, organizationId: string): string => `http://sys-ids.kemkes.go.id/${kind}/${organizationId}`;

/** KFA codes on a Medication's `code.coding`. */
export const KFA_SYSTEM = 'http://sys-ids.kemkes.go.id/kfa';

/** The Medication extension that marks it compound or not (the hub always sends `NC`). */
export const MEDICATION_TYPE_URL = 'https://fhir.kemkes.go.id/r4/StructureDefinition/MedicationType';
export const MEDICATION_TYPE_SYSTEM = 'http://terminology.kemkes.go.id/CodeSystem/medication-type';

/** Quantity units are dose forms (#6); the mock world's dose-form codes are v3-orderableDrugForm codes. */
export const DOSE_FORM_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v3-orderableDrugForm';
