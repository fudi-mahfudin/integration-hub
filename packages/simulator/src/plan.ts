import type { World, WorldKfaProduct, WorldPatient, WorldPractitioner } from '@integration-hub/mock-satusehat/world';
import { LOCAL_DRUG_CODES, VISIT_LOCATIONS, type LocalDrugCode, type VisitLocation } from './local-codes.js';
import { SeededRandom } from './random.js';

/** What a batch is made of. Every share is of visits, and is applied as an exact count. */
export interface BatchOptions {
  /** Fixes every draw: the same seed and options plan the same batch. */
  seed: number;
  /** Prefixes visit ids and idempotency keys, so batches sent to one hub never collide. */
  runId: string;
  /** How many visits; each has the four source events. */
  visits: number;
  /** Open-loop arrival rate of the original sends; it does not slow down when the hub does. */
  eventsPerSecond: number;
  /** Visits sending one event before its predecessor, which is held back at least `delayMs`. */
  outOfOrder: { share: number; delayMs: number };
  /** Visits whose dispense is a substitution (same active ingredients, another product); the rest are dispensed as prescribed. */
  substitutionShare: number;
  /** Visits whose patient is identified by mother's NIK + birthDate, or name + birthDate + gender, instead of NIK. */
  fallbackLookupShare: number;
  /**
   * Duplicate ingests: `perEvent` is the share of the original events (0-1) sent once more with the
   * same key and byte-identical body; `concurrent`, `delayed` and `late` split them (summing to 1):
   * sent with the original, `delayedWindowMs` after the original's 202, or after the case completed.
   */
  duplicates: {
    perEvent: number;
    concurrent: number;
    delayed: number;
    late: number;
    delayedWindowMs: { min: number; max: number };
  };
}

/** The source event types, in the order a visit's steps need them. */
export const EVENT_TYPES = ['visit.started', 'prescription.written', 'drug.dispensed', 'visit.finished'] as const;
/** One of the four source event types. */
export type EventType = (typeof EVENT_TYPES)[number];

/** How the hub is expected to find a visit's patient (its lookup method). */
export type PatientLookup = 'nik' | 'mother_nik_birth_date' | 'name_birth_date_gender';

/** One planned visit and what its delivery is expected to show. */
export interface PlannedVisit {
  visitId: string;
  /** `substitution`: the dispensed product is another one with the same active ingredients. */
  scenario: 'as_prescribed' | 'substitution';
  lookup: PatientLookup;
  /** Whether one of its events is sent before its predecessor. */
  outOfOrder: boolean;
  patientIhsNumber: string;
  prescribedKfaCode: string;
  dispensedKfaCode: string;
}

/** When a duplicate ingest of an event is sent. */
export type DuplicateTiming = { kind: 'concurrent' } | { kind: 'delayed'; afterAcceptMs: number } | { kind: 'late' };

/** One original send of a source event. */
export interface PlannedSend {
  visitId: string;
  eventType: EventType;
  idempotencyKey: string;
  /** The exact bytes sent; a duplicate sends them again. */
  body: string;
  /** When to send it, in ms from the batch's start. */
  atMs: number;
  /** Its duplicate ingest, if it gets one. */
  duplicate: DuplicateTiming | null;
}

/** A planned batch: its visits, and its original sends in send order. */
export interface Plan {
  options: BatchOptions;
  visits: PlannedVisit[];
  sends: PlannedSend[];
}

/** Visits start on this day and later, in WIB (+07:00), one every few minutes. */
const FIRST_VISIT_START = Date.parse('2026-03-02T08:00:00+07:00');
const MINUTE = 60_000;
/** How many visits are open (have events left to send) at once while events are interleaved. */
const OPEN_VISITS = 8;

/**
 * Plans a batch of fictional visits drawn from the world dataset: their four
 * source events, scenarios, duplicates and send times. Pure: the same world,
 * seed and options always give the same plan.
 */
export function planBatch(world: World, options: BatchOptions): Plan {
  const random = new SeededRandom(options.seed);
  const catalogue = new Catalogue(world);
  const physicians = world.practitioners.filter((p) => p.role === 'physician');
  const pharmacists = world.practitioners.filter((p) => p.role === 'pharmacist');
  if (physicians.length === 0 || pharmacists.length === 0) throw new Error('the world dataset needs a physician and a pharmacist');

  const substitutions = chosenVisits(random, options.visits, options.substitutionShare);
  const fallbacks = chosenVisits(random, options.visits, options.fallbackLookupShare);
  const outOfOrder = chosenVisits(random, options.visits, options.outOfOrder.share);
  const patients = new PatientDraw(world.patients);
  const visits: PlannedVisit[] = [];
  const bodies = new Map<string, Record<EventType, string>>();
  for (let index = 0; index < options.visits; index++) {
    const visitId = `V-${options.runId}-${String(index + 1).padStart(5, '0')}`;
    const { patient, lookup } = fallbacks.has(index) ? patients.byFallback(random) : patients.byNik(random);
    const physician = random.pick(physicians);
    const pharmacist = random.pick(pharmacists);
    const location = random.pick(VISIT_LOCATIONS);
    const substitution = substitutions.has(index);
    const { prescribed, dispensed } = substitution ? catalogue.substitution(random) : catalogue.asPrescribed(random);
    const startedAt = FIRST_VISIT_START + index * 3 * MINUTE + random.int(0, 2) * MINUTE;
    visits.push({
      visitId,
      scenario: substitution ? 'substitution' : 'as_prescribed',
      lookup,
      outOfOrder: outOfOrder.has(index),
      patientIhsNumber: patient.ihsNumber,
      prescribedKfaCode: prescribed.kfaCode,
      dispensedKfaCode: dispensed.kfaCode,
    });
    bodies.set(
      visitId,
      visitEvents(random, { visitId, substitution, patient, lookup, physician, pharmacist, location, prescribed, dispensed, startedAt, catalogue }),
    );
  }

  const sends: PlannedSend[] = [];
  const scheduled = visits.map((v) => ({ visitId: v.visitId, swapAt: v.outOfOrder ? random.int(0, EVENT_TYPES.length - 2) : null }));
  for (const { visitId, eventType, atMs } of schedule(random, scheduled, options)) {
    const body = bodies.get(visitId)?.[eventType];
    if (body === undefined) throw new Error(`no planned body for ${visitId} ${eventType}`);
    sends.push({
      visitId,
      eventType,
      idempotencyKey: `${options.runId}-${random.uuid()}`,
      body,
      atMs,
      duplicate: null,
    });
  }
  const duplicated = random.shuffle(sends).slice(0, Math.round(options.duplicates.perEvent * sends.length));
  duplicatedTimings(random, duplicated.length, options.duplicates).forEach((timing, i) => {
    const send = duplicated[i];
    if (send) send.duplicate = timing;
  });
  return { options, visits, sends };
}

/** `count` duplicate timings, split by the shares as exact counts (late takes the rounding), in random order. */
function duplicatedTimings(random: SeededRandom, count: number, shares: BatchOptions['duplicates']): DuplicateTiming[] {
  const concurrent = Math.round(count * shares.concurrent);
  const delayed = Math.min(count - concurrent, Math.round(count * shares.delayed));
  const timings: DuplicateTiming[] = [];
  for (let i = 0; i < count; i++) {
    if (i < concurrent) timings.push({ kind: 'concurrent' });
    else if (i < concurrent + delayed) timings.push({ kind: 'delayed', afterAcceptMs: random.int(shares.delayedWindowMs.min, shares.delayedWindowMs.max) });
    else timings.push({ kind: 'late' });
  }
  return random.shuffle(timings);
}

/** Draws visits' patients uniformly from the world, and how the source identifies each. */
class PatientDraw {
  private readonly byMotherNikBirthDate = new Map<string, number>();
  private readonly byNameBirthDateGender = new Map<string, number>();

  constructor(private readonly patients: readonly WorldPatient[]) {
    for (const p of patients) {
      increment(this.byMotherNikBirthDate, motherKey(p));
      increment(this.byNameBirthDateGender, nameKey(p));
    }
  }

  /** A patient identified by NIK. */
  byNik(random: SeededRandom): { patient: WorldPatient; lookup: PatientLookup } {
    return { patient: random.pick(this.patients), lookup: 'nik' };
  }

  /**
   * A patient identified by a fallback that finds only them: mother's NIK + birthDate, or
   * name + birthDate + gender. A patient no fallback tells apart (the world's deliberate
   * near-misses) is drawn again, since an ambiguous lookup dead-letters the case.
   */
  byFallback(random: SeededRandom): { patient: WorldPatient; lookup: PatientLookup } {
    for (;;) {
      const patient = random.pick(this.patients);
      const usable: PatientLookup[] = [];
      if (this.byMotherNikBirthDate.get(motherKey(patient)) === 1) usable.push('mother_nik_birth_date');
      if (this.byNameBirthDateGender.get(nameKey(patient)) === 1) usable.push('name_birth_date_gender');
      if (usable.length > 0) return { patient, lookup: random.pick(usable) };
    }
  }
}

const motherKey = (p: WorldPatient) => `${p.motherNik}|${p.birthDate}`;
const nameKey = (p: WorldPatient) => `${p.name}|${p.birthDate}|${p.gender}`;
const increment = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);

/** The patient fields the source sends for a lookup method: only what that method searches by. */
function patientIdentity(patient: WorldPatient, lookup: PatientLookup): Record<string, string> {
  if (lookup === 'nik') return { nik: patient.nik };
  if (lookup === 'mother_nik_birth_date') return { motherNik: patient.motherNik, birthDate: patient.birthDate };
  return { name: patient.name, birthDate: patient.birthDate, gender: patient.gender };
}

/** Exactly `round(share × count)` of the indexes 0..count-1, drawn at random. */
function chosenVisits(random: SeededRandom, count: number, share: number): Set<number> {
  const indexes = Array.from({ length: count }, (_, i) => i);
  return new Set(random.shuffle(indexes).slice(0, Math.round(share * count)));
}

/** A visit as the schedule sees it: which event, if any, it sends before its predecessor. */
interface ScheduledVisit {
  visitId: string;
  /** Event `swapAt + 1` is sent before event `swapAt`; null for a visit sent in order. */
  swapAt: number | null;
}

/**
 * Times the original sends: a few visits open at a time, interleaved at
 * random, one send per `1000 / eventsPerSecond` ms. An out-of-order visit
 * sends its event `swapAt + 1` first and holds event `swapAt` back for at least
 * `delayMs`; its later events wait for the held one. When every open visit is
 * waiting on a held event, time skips to the first release, so the rate is
 * never exceeded.
 */
function schedule(random: SeededRandom, visits: readonly ScheduledVisit[], options: BatchOptions): { visitId: string; eventType: EventType; atMs: number }[] {
  const interval = 1000 / options.eventsPerSecond;
  const waiting = [...visits];
  const open: { visit: ScheduledVisit; next: number; held: { event: number; releaseAt: number } | null }[] = [];
  const timed: { visitId: string; eventType: EventType; atMs: number }[] = [];
  const send = (visitId: string, event: number, at: number) => {
    const eventType = EVENT_TYPES[event];
    if (eventType === undefined) throw new Error(`visit ${visitId} has no event ${event}`);
    timed.push({ visitId, eventType, atMs: Math.round(at) });
  };
  let now = 0;
  while (waiting.length > 0 || open.length > 0) {
    while (open.length < OPEN_VISITS && waiting.length > 0) {
      const visit = waiting.shift();
      if (visit) open.push({ visit, next: 0, held: null });
    }
    const released = open.filter((v) => v.held !== null && v.held.releaseAt <= now);
    const ready = open.filter((v) => v.held === null);
    if (released.length > 0) {
      const v = released.reduce((a, b) => ((a.held?.releaseAt ?? 0) <= (b.held?.releaseAt ?? 0) ? a : b));
      send(v.visit.visitId, v.held?.event ?? -1, now);
      v.held = null;
    } else if (ready.length > 0) {
      const v = random.pick(ready);
      if (v.next === v.visit.swapAt) {
        send(v.visit.visitId, v.next + 1, now);
        v.held = { event: v.next, releaseAt: now + options.outOfOrder.delayMs };
        v.next += 2;
      } else {
        send(v.visit.visitId, v.next, now);
        v.next++;
      }
    } else {
      now = Math.min(...open.map((v) => v.held?.releaseAt ?? Infinity));
      continue;
    }
    for (const v of open.filter((o) => o.next >= EVENT_TYPES.length && o.held === null)) open.splice(open.indexOf(v), 1);
    now += interval;
  }
  return timed;
}

/** A local drug code with the world's KFA product it names. */
interface Drug extends LocalDrugCode {
  product: WorldKfaProduct;
}

/** The simulated pharmacy's drugs, resolved against the world's KFA catalogue. */
class Catalogue {
  readonly drugs: Drug[];

  constructor(world: World) {
    this.drugs = LOCAL_DRUG_CODES.map((code) => {
      const product = world.kfaProducts.find((p) => p.code === code.kfaCode);
      if (!product) throw new Error(`local drug code ${code.drugCode} names KFA ${code.kfaCode}, which the world dataset does not hold`);
      return { ...code, product };
    });
  }

  /** A drug to prescribe and one dispensed as prescribed: the prescribed 93 itself, or a 93 derived from the prescribed 92. */
  asPrescribed(random: SeededRandom): { prescribed: Drug; dispensed: Drug } {
    const prescribed = random.pick(this.drugs);
    const dispensed = random.pick(this.drugs.filter((d) => isAsPrescribed(prescribed, d)));
    return { prescribed, dispensed };
  }

  /**
   * A drug to prescribe and a substitution for it: an actual product (93) that is neither the
   * prescribed one nor derived from it, with exactly the same active ingredients.
   */
  substitution(random: SeededRandom): { prescribed: Drug; dispensed: Drug } {
    const pairs = this.drugs.flatMap((prescribed) =>
      this.drugs
        .filter((d) => d.product.level === 93 && !isAsPrescribed(prescribed, d) && sameIngredients(prescribed, d))
        .map((dispensed) => ({ prescribed, dispensed })),
    );
    return random.pick(pairs);
  }

  /** The unit a drug is counted in, as the dosage text names it. */
  unitOf(drug: Drug): string {
    return drug.product.doseForm.display.toLowerCase();
  }
}

function isAsPrescribed(prescribed: Drug, dispensed: Drug): boolean {
  if (dispensed.product.level !== 93) return false;
  return dispensed.kfaCode === prescribed.kfaCode || dispensed.product.parent === prescribed.kfaCode;
}

function sameIngredients(a: Drug, b: Drug): boolean {
  const ingredientsOf = (drug: Drug) => drug.product.ingredients.toSorted().join(',');
  return ingredientsOf(a) === ingredientsOf(b);
}

/** Why the simulated pharmacy substitutes: out of stock, formulary policy, or the patient's choice. */
const SUBSTITUTION_REASONS = ['OS', 'FP', 'PATIENT_CHOICE'] as const;

interface VisitFacts {
  visitId: string;
  substitution: boolean;
  patient: WorldPatient;
  lookup: PatientLookup;
  physician: WorldPractitioner;
  pharmacist: WorldPractitioner;
  location: VisitLocation;
  prescribed: Drug;
  dispensed: Drug;
  startedAt: number;
  catalogue: Catalogue;
}

/** The four source events of a visit, each as the exact JSON body to send. */
function visitEvents(random: SeededRandom, visit: VisitFacts): Record<EventType, string> {
  const authoredAt = visit.startedAt + random.int(5, 30) * MINUTE;
  const preparedAt = authoredAt + random.int(5, 20) * MINUTE;
  const handedOverAt = preparedAt + random.int(1, 10) * MINUTE;
  const finishedAt = handedOverAt + random.int(5, 60) * MINUTE;
  const prescriptionId = `RX-${visit.visitId}`;
  const itemId = 'ITEM-1';
  const timesPerDay = random.int(1, 3);
  const quantity = timesPerDay * random.int(3, 10);
  const unit = visit.catalogue.unitOf(visit.prescribed);
  const expiry = new Date(Date.UTC(2027 + random.int(0, 2), random.int(0, 11), random.int(1, 28)));

  const body = (type: EventType, occurredAt: number, data: Record<string, unknown>) =>
    JSON.stringify({ type, visitId: visit.visitId, occurredAt: wib(occurredAt), data });
  return {
    'visit.started': body('visit.started', visit.startedAt, {
      patient: { ...patientIdentity(visit.patient, visit.lookup), mrn: `MRN-${visit.patient.ihsNumber.slice(1)}` },
      practitioner: { nik: visit.physician.nik },
      encounterClass: visit.location.encounterClass,
      locationCode: visit.location.locationCode,
      startedAt: wib(visit.startedAt),
    }),
    'prescription.written': body('prescription.written', authoredAt, {
      prescriptionId,
      authoredAt: wib(authoredAt),
      requester: { nik: visit.physician.nik },
      items: [
        {
          itemId,
          drugCode: visit.prescribed.drugCode,
          quantity,
          dosage: { text: `${timesPerDay} x 1 ${unit} sesudah makan`, timesPerDay, doseAmount: 1, routeCode: 'O' },
        },
      ],
    }),
    'drug.dispensed': body('drug.dispensed', handedOverAt, {
      prescriptionId,
      itemId,
      drugCode: visit.dispensed.drugCode,
      quantity,
      preparedAt: wib(preparedAt),
      handedOverAt: wib(handedOverAt),
      pharmacist: { nik: visit.pharmacist.nik },
      batch: { lot: `LOT-${String(random.int(0, 999_999)).padStart(6, '0')}`, expiry: expiry.toISOString().slice(0, 10) },
      ...(visit.substitution ? { substitution: { reasonCode: random.pick(SUBSTITUTION_REASONS) } } : {}),
    }),
    'visit.finished': body('visit.finished', finishedAt, { finishedAt: wib(finishedAt) }),
  };
}

/** An instant written in WIB with its offset, as the source system writes times: `2026-03-02T08:00:00+07:00`. */
function wib(instant: number): string {
  return `${new Date(instant + 7 * 60 * MINUTE).toISOString().slice(0, 19)}+07:00`;
}
