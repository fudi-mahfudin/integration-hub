# SATUSEHAT pharmacy module: current status and validation rules

Research for issue #2. Every source was read on **2026-11-15** and is official, first-party SATUSEHAT / Kemenkes material. Page text is in Indonesian. Short quotes are kept verbatim where the wording matters.

## Sources

| Tag | Source | Version / date |
|---|---|---|
| **[FARM]** | Pharmacy guide, "Pelayanan Kefarmasian": https://satusehat.kemkes.go.id/platform/docs/id/interoperability/kefarmasian/ | Change history ends at **v1.3, 28 Nov 2024** (v1.0 10 Apr 2024, v1.1 05 Aug 2024, v1.2 03 Oct 2024) |
| **[RJ]** | Outpatient guide, "Resume Medis - Rawat Jalan". [FARM] points to it for Encounter rules: https://satusehat.kemkes.go.id/platform/docs/id/interoperability/rme-rawat-jalan/ | **v7.0, 10 Jan 2026** |
| **[R-ENC]** | FHIR resource page, Encounter: https://satusehat.kemkes.go.id/platform/docs/id/fhir/resources/encounter/ | No version on the page. Portal is v7.23 |
| **[R-MED]** | FHIR resource page, Medication: https://satusehat.kemkes.go.id/platform/docs/id/fhir/resources/medication/ | No version on the page. Portal is v7.23 |
| **[R-MR]** | FHIR resource page, MedicationRequest: https://satusehat.kemkes.go.id/platform/docs/id/fhir/resources/medication-request/ | No version on the page. Last changelog touch was portal v7.5 (15 Jul 2024) |
| **[R-MD]** | FHIR resource page, MedicationDispense: https://satusehat.kemkes.go.id/platform/docs/id/fhir/resources/medication-dispense/ | No version on the page. Portal is v7.23 |
| **[DT]** | Primitive data types: https://satusehat.kemkes.go.id/platform/docs/id/fhir/data-type/primitive/ | No version. Portal is v7.23 |
| **[KAMUS]** | "Kamus Rule Number Validasi", the validation rule dictionary. Landing page: https://satusehat.kemkes.go.id/platform/docs/id/api-catalogue/validasi/kamus-validasi/. The page links a Google Sheet `1vnYFL2Ho1lICEgWmE2HFwkbEgiRvw1uaYBBW8NvwzjI`, which was read as CSV | Each row has its own version. Rows cited are **v1.0 (14 Mar 2024)** or **v2.0 (10 Dec 2025)** |
| **[KFA]** | KFA REST API: https://satusehat.kemkes.go.id/platform/docs/id/master-data/kfa/rest-api-kfa/ | Portal is v7.23. Last KFA change was v7.20 (27 Sep 2025) |
| **[NEW]** | Portal changelog, "Versi 7": https://satusehat.kemkes.go.id/platform/docs/id/whats-new/7/ | Latest is **v7.23, released 02 Apr 2026** |
| **[PM]** | Official public Postman workspace "SATUSEHAT PUBLIC" (https://www.postman.com/satusehat/workspace/satusehat-public/overview), collection **"04. Pelayanan - Farmasi"** (uid `30206597-02e14acc-ff32-40c6-9c21-8a17a4f15e35`) | Collection `updatedAt` **2025-02-12** |

---

## 1. Module status: still marked under development and sandbox-only

- [FARM] v1.3 (28 Nov 2024) still shows this banner: *"Modul ini sedang dalam tahap pengembangan (hanya tersedia di Environment Sandbox)."* ("This module is under development (only available in the Sandbox environment).")
- The portal itself is at **v7.23 (02 Apr 2026)** [NEW]. The changelog touches the pharmacy module only twice:
  - **v7.13 (04 Nov 2024)** added the sub-chapter.
  - **v7.16 (16 Dec 2024)** carried *"Penyesuaian materi berdasarkan revisi pada ... Pelayanan Kefarmasian"*, which matches the guide's v1.3.
  - No later portal release (v7.17–v7.23) mentions Kefarmasian.
- So the "Nov 2024" page the ticket mentions **is the current version**. The guide's own change history stopped while the portal kept moving. I found no official statement that lifts the sandbox-only status.
- The Postman pharmacy collection was last updated 2025-02-12 [PM]. The outpatient guide [RJ] is much newer (v7.0, Jan 2026) and carries the same Medication / MedicationRequest / MedicationDispense rules (§4–§7 below).
- **Not verifiable from the docs:** whether production actually accepts pharmacy-module traffic. ADR-0006 already says the sandbox is more permissive than production.
- Minor inconsistency: [NEW] files the module under "Modul Penerapan (Use Case)", but the portal navigation lists it under "Modul Pelayanan".

## 2. Timestamps: UTC required, and the docs disagree on how strictly

- Every relevant page has the same banner ([FARM], [RJ], [R-ENC], [R-MED], [R-MR], [R-MD]): *"Standar format Waktu yang digunakan dalam pengiriman data adalah UTC +00."*
  - For WIB, subtract 7 hours. For WITA, subtract 8. For WIT, subtract 9.
  - Worked example on the page: 17:35 WIB on 23 Aug 2023 is sent as `2023-08-23T10:35:00+00:00`.
- [KAMUS] v1.0 rules require the format `YYYY-MM-DDThh:mm:ss+00:00` on these fields:
  - `MedicationRequest.authoredOn` (rule 10337)
  - `MedicationRequest.dispenseRequest.validityPeriod.start` and `.end` (10338, 10339)
  - `MedicationDispense.whenPrepared` (10351)
  - `MedicationDispense.whenHandedOver` (10352)
  - `Encounter.period.end` (10173)
  - `Encounter.location.period.*`, `Encounter.classHistory.period.*`, `Encounter.participant.period.end`
- **Conflicts:**
  - The resource pages ([R-MR], [R-MD], [R-ENC]) also say the allowed formats are `YYYY`, `YYYY-MM`, `YYYY-MM-DD` or `YYYY-MM-DDThh:mm:ss+zz:zz`, which would allow partial dates and any offset.
  - [DT] allows any offset, including `Z`.
  - [R-ENC]'s own examples use `+07:00` (`"2022-06-14T07:00:00+07:00"`), which contradicts the UTC banner on the same page.
  - Whether the server rejects non-`+00:00` offsets or partial dates is **not verifiable from the docs**.
- **Safe local rule:** send full-second timestamps normalised to `+00:00`. Convert WIB/WITA/WIT by subtracting 7/8/9 hours, without relying on any offset logic on the server.

## 3. Date floor 2014-06-03: stated, but no field list

- The same banner on every page above adds: *"Standar format pengiriman Tanggal tidak bisa kurang dari 03 Juni 2014."* ("Submitted dates cannot be earlier than 03 June 2014.")
- **No source names the fields it applies to.** It appears as a resource-wide note on:
  - [R-ENC], [R-MED], [R-MR], [R-MD]
  - [FARM]'s mapping sections for MedicationRequest, DocumentReference, MedicationDispense and ChargeItemDefinition
- [KAMUS] has **no rule** for it. I searched for "2014", "Juni" and "kurang dari" and found nothing, so there is no rule number to cite.
- **Inference, not documented:** the banner sits on each resource as a whole, so the conservative reading is that it covers every date/dateTime in Encounter, Medication, MedicationRequest and MedicationDispense. That includes `Medication.batch.expirationDate`, which in practice will always be later than 2014.

## 4. Mandatory fields for a non-compounded single-dose prescription and its dispense

The sources mark "mandatory" in different ways:

- [FARM] and [RJ] put `*` in front of mandatory elements.
- The resource pages do the same, but say mandatoriness depends on the use-case guide.
- [KAMUS] has "not null" and "wajib" (required) rules.

The sources do not agree. The tables below list every source, and the last column is the **union**, which is the safe local rule.

### Medication (contained, non-compound `NC`)

| Element | [FARM] v1.3 / [RJ] v7.0 | [R-MED] | [KAMUS] | Union |
|---|---|---|---|---|
| `identifier` (system `http://sys-ids.kemkes.go.id/medication/{org}`) | `*` | not starred, "may be empty for compounded" | 10380 not null (v1.0) | **required** |
| `code` (KFA) | Text: "wajib diisi apabila mengirimkan data obat non-racikan" (required when sending non-compounded drugs) | Same text | 10024 system `http://sys-ids.kemkes.go.id/kfa` | **required for NC** |
| `extension:medicationType` (`https://fhir.kemkes.go.id/r4/StructureDefinition/MedicationType`, code `NC`) | `*` | `*` | 10031 code system | **required** |
| `ingredient` | "tidak wajib" (not required) for non-compounded | required only for compounded | — | optional |
| `batch.lotNumber` / `batch.expirationDate` | Listed, no `*`. [RJ] lists both as dispense variables ("Nomor Batch", "Tanggal Kedaluwarsa") | Listed, no `*` | 10309 must be a string, 10310 must be a dateTime (format only, v1.0) | **optional per docs** |

On batch: the dispense examples in [PM] are inconsistent. The Amoxicillin, Captopril and substitution examples include `batch` (for example `"lotNumber": "HG012-31", "expirationDate": "2027-04-24"`). The Paracetamol dispense example and every prescription example leave it out. **No source makes batch mandatory.** If the hub enforces it, that is a hub policy, not a SATUSEHAT rule.

### MedicationRequest

| Element | [FARM] / [RJ] `*` | [R-MR] `*` | [KAMUS] not-null / wajib | Union |
|---|---|---|---|---|
| `identifier` | yes | no | 10388 not null | **required** |
| `status` | yes | yes | (code system 10032) | **required** |
| `intent` | yes | yes | (10033) | **required** |
| `medicationReference` | yes | no | 10135 not null / wajib | **required** |
| `subject` | yes | yes | 10136 not null | **required** |
| `encounter` | no | "WAJIB ... apabila peresepan obat terjadi di rumah sakit" (required when prescribed in a hospital) | 10454 wajib | **required** |
| `authoredOn` | no | no | 10337 not null (**v2.0, 10 Dec 2025**) | **required** |
| `requester` | no | no | 10455 wajib | **required** |
| `dosageInstruction[i].timing.repeat` | yes | — | — | **required** |
| `dosageInstruction[i].route` | yes | — | — | **required** |
| `substitution.allowed[x]` | yes | yes | — | **required** |
| `dispenseRequest.performer` | no | no | 10453 "wajib terisi" (must be filled) | **required (per KAMUS)** |

Conflict: authoredOn, requester, encounter and dispenseRequest.performer are mandatory in [KAMUS] but not starred in the guides. KAMUS reflects the server-side validator, so treat them as required.

The prescription example in [PM] includes all of these fields. It also sets `status: completed`, `intent: order` and `category: community`.

### MedicationDispense

| Element | [FARM] / [RJ] `*` | [R-MD] `*` | [KAMUS] | Union |
|---|---|---|---|---|
| `identifier` | yes | no | 10389 not null | **required** |
| `status` | yes | yes | 10049 not null | **required** |
| `medicationReference` | yes | no | 10138 not null / wajib | **required** |
| `subject` | yes | yes | 10139 not null | **required** |
| `context` (Encounter) | yes | no | 10390 "wajib diisi" (must be filled) | **required** |
| `performer.actor` | no | yes | 10392 format only | **required (per R-MD)** |
| `substitution.wasSubstituted` | no | yes | — | **required (per R-MD)** |
| `authorizingPrescription` | no | no | 10394 must reference an existing MedicationRequest | Recommended. Mandatory status is not stated |

The no-substitution dispense example in [PM] sends `"substitution": {"wasSubstituted": false}`.

### Encounter (pharmacy visit)

- [FARM] adds one pharmacy-specific element: `Encounter.serviceType.coding` = `http://terminology.hl7.org/CodeSystem/service-type` | `64` | `Pharmacy`. Everything else defers to [RJ] and [R-ENC].
- [KAMUS] not-null rules:
  - `identifier` (10117), `subject` (10118)
  - `participant.individual` (10119), `location.location` (10120)
  - `statusHistory` (10122), `period.start` (10123), `serviceProvider` (10124)
  - 10121 (v2.0): if `status = finished`, both `period.start` and `period.end` are required, and end must be later than start
- [R-ENC] also stars:
  - `status`, `class`, `classHistory`
  - `diagnosis.*`, needed when closing the visit
  - `location`

## 5. KFA levels: 92 vs 93, and 92→93 derivation

Code structure ([FARM], [RJ]): all codes are 8 digits, a 2-digit prefix plus 6 digits.

| Prefix | Meaning |
|---|---|
| `91` | Active ingredient (BZA) |
| `92` | Virtual / template product (POV) |
| `93` | Actual product (POA): *"turunan dari produk template"* (a derivative of a template product) |
| `94` | Actual product in packaging (POAK) |

- **Prescription:** *"Medication.code untuk MedicationRequest dapat menggunakan ... 92xxxxxx atau ... 93xxxxxx, tergantung kesiapan sistem"* (may use either, depending on how ready the facility's system is). A 93 "Umum" (generic) or 93 "Merek" (brand) code may stand in for a 92, *"dikarenakan setiap kode 92 memiliki padanan kode 93 (Umum)"* (because every 92 code has a matching 93 generic code). Sources: [FARM] v1.3, [RJ] v7.0.
- **Dispense:** *"Medication.code untuk MedicationDispense wajib menggunakan ... 93xxxxxx"* (must use a 93 code). Without a brand, use 93 (Umum). Same sources.
- **92→93 derivation is a "should", not a "must":** *"Jika peresepan ... kode awalan 92 maka kode 93 untuk penebusan obat sebaiknya merupakan turunan kode 92"* (if the prescription uses a 92 code, the 93 dispensed should derive from it).
  - Exception: if no 93 with the matching strength is in stock, a 93 with the **same active ingredient but a different strength** may be dispensed.
  - Example given: a 92 Paracetamol 500 mg prescription filled with a 93 Paracetamol 250 mg, taken as 2 tablets.
  - Sources: [FARM], [RJ].
- **Finding a 92's 93 children** [KFA]:
  - `GET {kfa-v2}/products/all?page=&size=&product_type=farmasi&template_code=92xxxxxx` lists actual products under a template.
  - `GET {kfa-v2}/products?identifier=kfa&code=93xxxxxx` returns `product_template.kfa_code` (the parent 92) and `active_ingredients[].kfa_code` (the 91s).
  - Hosts: sandbox `https://api-satusehat-stg.dto.kemkes.go.id/kfa-v2`, production `https://api-satusehat.kemkes.go.id/kfa-v2`.
- **Server enforcement is unverified:**
  - [KAMUS] 10024 (v1.0) checks only that `Medication.code` uses the KFA system, and repeats the 92-or-93 wording.
  - I found **no rule number** that enforces 93-on-dispense or the 92→93 parentage.
  - A v2.0 row of 10024 (10 Dec 2025) also allows SNOMED CT for `Medication.code`. That is unexplained and likely meant for other use cases.
- In the [PM] examples, both the prescription and the dispense use 93 codes (for example `93006334` Paracetamol 500 mg Tablet (INDOFARMA)).

## 6. Identifier systems

`{org}` is the parent organisation's SATUSEHAT Organization ID. [R-*] calls it "ID organisasi induk ... master sarana indeks", and [KAMUS] calls it "Organization ID faskes".

| What | System | Sources |
|---|---|---|
| Prescription (one per prescription, may cover several drugs) | `http://sys-ids.kemkes.go.id/prescription/{org}`, `use: official` | [FARM] Table 8, [RJ], [R-MR] example, [PM] |
| Prescription item (one per drug) | `http://sys-ids.kemkes.go.id/prescription-item/{org}`, `use: official` | [FARM] Table 8, [R-MR] example, [KAMUS] 10388 (v2.0), [PM] |
| Both go in `MedicationRequest.identifier[]` as a two-element array | | [FARM], [PM] (example values `A00000111222` / `A00000111222-1`) |
| Dispense | `MedicationDispense.identifier[]` reuses the **prescription** and **prescription-item** systems | [KAMUS] 10389 (v2.0, 10 Dec 2025), [R-MD] examples, [PM] |
| Dispense support data | `http://terminology.kemkes.go.id/CodeSystem/coverage-type` (BPJS-K, Biaya-Sendiri, Biaya-Perusahaan, Asuransi-Swasta) and `http://sys-ids.kemkes.go.id/claim-number/{org}` (BPJS SEP number) | [FARM] Table 14, [KAMUS] 10389 |
| Encounter | `http://sys-ids.kemkes.go.id/encounter/{org}` | [R-ENC], [RJ] v7.0 Table 2, [PM] pharmacy Encounter |
| Medication (local drug code) | `http://sys-ids.kemkes.go.id/medication/{org}` | [R-MED], [PM] |
| National prescription number (read-only) | `http://sys-ids.kemkes.go.id/prescription/national` | [PM] search requests |

**Conflicts:**

- [R-MR] describes the system as `.../prescription/{org}/{subsystem}`, but its own example and every other source leave out `/{subsystem}`. Follow the examples.
- [R-MD] describes the system as `.../medicationdispense/{org}`, but its examples, [KAMUS] 10389 v2.0 and [PM] all use `prescription/` and `prescription-item/`. Follow [KAMUS] and [PM].
- [KAMUS] 10388 lists only the `prescription-item` system for MedicationRequest, with no `prescription` row. The guides require both.
- [FARM] Table 8 has a typo: the second row is labelled `.system` with value `official`. Read it as `use`.
- For Encounter, [KAMUS] 10117 lists only the use-case-specific `asik/{org}` and `sitb/{org}` systems, not `encounter/{org}`. The guides and [PM] use `encounter/{org}`.

## 7. Substitution on MedicationDispense

Sources: [FARM] v1.3 Table 14, [R-MD], and [KAMUS] 10674–10676 (v2.0).

- `substitution.wasSubstituted`: boolean (starred in [R-MD]).
- `substitution.type.coding`: system `http://terminology.hl7.org/CodeSystem/v3-substanceAdminSubstitution` [KAMUS 10675]. Codes:

  | Code | Meaning in [FARM] |
  |---|---|
  | `G` | generic composition: a prescribed generic replaced by another generic |
  | `BC` | brand composition: a prescribed brand replaced by another brand |
  | `TG` | therapeutic generic: a different active ingredient, same indication |
  | `TB` | therapeutic brand |

- `substitution.reason.coding`:
  - `v3-ActReason` `OS` (out of stock)
  - `http://terminology.kemkes.go.id` `TK000017` (dangerous drug interaction)
  - `v3-ActReason` `FP` (formulary policy)
  - `http://terminology.kemkes.go.id` `TK000018` (patient's choice)
  - `http://snomed.info/sct` `661000124108` (error in prescription)
  - Free text can also go in `reason.text`.
- `substitution.responsibleParty[]`: references to Practitioner [KAMUS 10676]. [FARM] says to fill it with *both* the prescribing doctor who approved the substitution *and* the pharmacist who made it.
- On the prescription side, `MedicationRequest.substitution.allowed[x]` is mandatory (§4).
- Split combination products with an "equivalent dose": these are recorded by the platform in `MedicationRequest.contained.QuestionnaireResponse`, which can be read with GET MedicationRequest by ID (link IDs `equivalentBoolean`, `equivalentQuantity`, `dispensedReferences`) [FARM v1.3].

**Conflicts:**

- [PM]'s "Substitusi - Generik" example (Paracetamol INDOFARMA → NOVAPHARIN) sends type `TG`, but [FARM] maps generic-to-generic to `G`.
- [PM] uses `G` nowhere. Across the collection its substitution type codes are `E`, `TE`, `TG`, `BC` and `TB`.
- None of [PM]'s requests include `responsibleParty`.
- [R-MD]'s generic examples use type `E` and reason `CT`, which are not in [FARM]'s list.
- [R-MR]'s example for `substitution.allowedCodeableConcept` uses an HTML page URL (`https://terminology.hl7.org/3.1.0/CodeSystem-v3-substanceAdminSubstitution.html`) as the code system, which is a documentation error.

**Mismatch with GLOSSARY.md:**

- The glossary defines Substitution as a dispense whose product differs **in strength** from the prescription while keeping the same active ingredient.
- SATUSEHAT never calls that case a substitution. The same-ingredient, different-strength case (500 mg → 250 mg) appears only in the `Medication.code` rules as an allowed dispense, and no source says it must set `wasSubstituted: true`.
- Of the four type codes, `G` comes closest, but [FARM]'s `G` examples keep the strength and change the manufacturer.
- The glossary term and the flagging rule need a decision. The docs do not settle it.

## Could not verify

- Whether the pharmacy module works in production (§1).
- Whether the server rejects non-UTC offsets or partial dates (§2).
- Any machine-enforced rule for the 2014-06-03 floor, or which fields it covers (§3).
- Server-side enforcement of 93-on-dispense and 92→93 parentage (§5).
- Whether `Medication.batch` is ever enforced as mandatory (§4).
- The docs do not say which [KAMUS] rows apply to which use case, so a row is not proof that the pharmacy flow is validated.
