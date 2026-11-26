import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const nik = z.string().regex(/^\d{16}$/, 'a 16-digit NIK');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a YYYY-MM-DD date');

const kfaIngredientSchema = z.object({
  /** KFA 91 code: one active ingredient. */
  code: z.string().regex(/^91\d{6}$/),
  display: z.string().min(1),
});

/** A KFA dose form (`dosage_form`): the unit a product is counted in. */
const doseFormSchema = z.object({ code: z.string().min(1), display: z.string().min(1) });

const kfaProductSchema = z.discriminatedUnion('level', [
  z.object({
    level: z.literal(92),
    code: z.string().regex(/^92\d{6}$/),
    display: z.string().min(1),
    doseForm: doseFormSchema,
    /** The KFA 91 codes of its active ingredients. */
    ingredients: z.array(z.string()).min(1),
  }),
  z.object({
    level: z.literal(93),
    code: z.string().regex(/^93\d{6}$/),
    display: z.string().min(1),
    doseForm: doseFormSchema,
    ingredients: z.array(z.string()).min(1),
    /** The virtual product (KFA 92) this actual product derives from. */
    parent: z.string().regex(/^92\d{6}$/),
  }),
]);

const patientSchema = z.object({
  ihsNumber: z.string().regex(/^P\d{11}$/),
  nik,
  /** The mother's NIK, the documented fallback for newborns without their own. */
  motherNik: nik,
  name: z.string().min(1),
  birthDate: date,
  gender: z.enum(['male', 'female']),
});

const practitionerSchema = z.object({
  ihsNumber: z.string().regex(/^\d{11}$/),
  nik,
  name: z.string().min(1),
  birthDate: date,
  gender: z.enum(['male', 'female']),
  role: z.enum(['physician', 'pharmacist']),
});

const locationSchema = z.object({
  /** SATUSEHAT Location id. */
  id: z.uuid(),
  /** The source system's local location code that a mapping points at this location. */
  code: z.string().min(1),
  name: z.string().min(1),
});

const organizationSchema = z.object({
  /** SATUSEHAT Organization id: the `{org}` in identifier systems. */
  id: z.string().regex(/^\d+$/),
  name: z.string().min(1),
  /** client_credentials pair the mock token endpoint accepts. Public dev values, for local and CI runs only. */
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

/** Seedable world entries: the parts of the world `POST /__mock/seed` can add to. */
export const worldEntriesSchema = z.object({
  kfaIngredients: z.array(kfaIngredientSchema).default([]),
  kfaProducts: z.array(kfaProductSchema).default([]),
  patients: z.array(patientSchema).default([]),
  practitioners: z.array(practitionerSchema).default([]),
  locations: z.array(locationSchema).default([]),
});

export const worldSchema = z.object({
  organization: organizationSchema,
  kfaIngredients: z.array(kfaIngredientSchema),
  kfaProducts: z.array(kfaProductSchema),
  patients: z.array(patientSchema),
  practitioners: z.array(practitionerSchema),
  locations: z.array(locationSchema),
  /** Patients with a test purpose, by NIK. */
  patientMarkers: z.object({
    /** Canary values: patients whose identifiers a redaction test must never find in logs or traces. */
    canaryNiks: z.array(nik).min(1),
    /** Deliberate near-misses for the person lookup fallbacks, each a group of NIKs that look alike. */
    nearMisses: z.array(z.object({ description: z.string().min(1), niks: z.array(nik).min(2) })).min(1),
  }),
});

/** The world dataset (see GLOSSARY.md): the fake national records the mock answers from. */
export type World = z.infer<typeof worldSchema>;
/** Entries `POST /__mock/seed` adds to the world until the next reset. */
export type WorldEntries = z.infer<typeof worldEntriesSchema>;
/** A fake patient in the world. */
export type WorldPatient = World['patients'][number];
/** A fake practitioner in the world. */
export type WorldPractitioner = World['practitioners'][number];
/** A fake KFA ingredient (91) in the world. */
export type WorldKfaIngredient = World['kfaIngredients'][number];
/** A fake KFA product (92 or 93) in the world. */
export type WorldKfaProduct = World['kfaProducts'][number];
/** A fake location in the world. */
export type WorldLocation = World['locations'][number];
/** The organization the world's client credentials belong to. */
export type WorldOrganization = World['organization'];

/** The world dataset shipped with this package. */
export const DEFAULT_WORLD_PATH = new URL('../../world/world.json', import.meta.url);

/**
 * Reads and validates a world dataset file. Throws naming the file and the
 * first problems if it does not match the schema.
 */
export async function loadWorld(path: URL | string): Promise<World> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`world dataset at "${String(path)}" must be a readable JSON file`, { cause: err });
  }
  const parsed = worldSchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`world dataset at "${String(path)}" is invalid; ${problems.join('; ')}`);
  }
  return parsed.data;
}
