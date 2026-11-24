# SATUSEHAT sandbox: test identities and data limits

Research for the manual live-sandbox mode. Every source was read on
**2026-11-24**. All of them are first-party SATUSEHAT / Kemenkes material. The
portal banner reads "Portal Dokumentasi SATUSEHAT Versi 7.23" (v7.23 was
released 02 Apr 2026 [NEW]). Individual doc pages carry no version or date of
their own, so "v7.23" below means "as published on the v7.23 portal". Page
text is in Indonesian. Quotes are verbatim unless marked as a translation.

No SATUSEHAT API was called. Only public pages and one public Google Sheet
linked from the docs were read.

## Sources

| Tag | Source | Version / date |
|---|---|---|
| **[PAT]** | Katalog ReST API > Prerequisites > Patient: https://satusehat.kemkes.go.id/platform/docs/id/api-catalogue/onboardings/apis/patient/ | Portal v7.23. Dummy table last updated in v7.14 (18 Nov 2024) per [NEW] |
| **[PRAC]** | Katalog ReST API > Prerequisites > Practitioner: https://satusehat.kemkes.go.id/platform/docs/id/api-catalogue/onboardings/apis/practitioner/ | Portal v7.23. Dummy table last updated in v7.14 (18 Nov 2024) per [NEW] |
| **[MPI]** | Master Data > MPI > ReST API, section "4. Data Dummy": https://satusehat.kemkes.go.id/platform/docs/id/master-data/master-patient-index/rest-api-mpi/ | Portal v7.23 |
| **[ORG]** | Katalog ReST API > Prerequisites > Organization: https://satusehat.kemkes.go.id/platform/docs/id/api-catalogue/onboardings/apis/organization/ | Portal v7.23 |
| **[LOC]** | Katalog ReST API > Prerequisites > Location: https://satusehat.kemkes.go.id/platform/docs/id/api-catalogue/onboardings/apis/location/ | Portal v7.23 |
| **[PRE]** | Katalog ReST API > Prerequisites (overview): https://satusehat.kemkes.go.id/platform/docs/id/api-catalogue/onboardings/ | Portal v7.23 |
| **[R-ORG]** / **[R-LOC]** | FHIR resource pages: https://satusehat.kemkes.go.id/platform/docs/id/fhir/resources/organization/ and .../location/ | Portal v7.23 |
| **[SBX]** | Kode Akses API (Sandbox): https://satusehat.kemkes.go.id/platform/docs/id/api-code/access-sandbox/ | Portal v7.23. Last revised v7.13 (04 Nov 2024) per [NEW] |
| **[HAK]** | "Hak Akses Resource sesuai Tipe Kode Akses API", the Google Sheet linked from [SBX]: `1bs8uU_nIuNqHohnRfTvFHx0o2qOgAYabAz0ptUC3w9s`, read as CSV. Tabs: Fasyankes (gid 0), Farmasi (373079769), Laboratorium, Asuransi, Pemerintahan, Institut Pendidikan | **Undated.** No version is shown |
| **[KFA]** | Master Data > KFA > ReST API: https://satusehat.kemkes.go.id/platform/docs/id/master-data/kfa/rest-api-kfa/ | Portal v7.23. Last KFA change v7.20 (27 Sep 2025) |
| **[EP]** | Postman > Endpoint Information: https://satusehat.kemkes.go.id/platform/docs/id/postman-workshop/endpoint-information/ | Portal v7.23 |
| **[NEW]** | Changelog "Versi 7": https://satusehat.kemkes.go.id/platform/docs/id/whats-new/7/ | Latest v7.23, 02 Apr 2026 |
| **[PM-FARM]** | Public Postman collection "04. Pelayanan - Farmasi" (uid `30206597-02e14acc-ff32-40c6-9c21-8a17a4f15e35`) in workspace "SATUSEHAT PUBLIC". Only its collection metadata and variables were read | `updatedAt` 2025-02-12. Change log in the description: 02 Dec 2024 and 09 Dec 2024 |
| **[TERMS]** | Ketentuan Umum dan Kebijakan Privasi: https://satusehat.kemkes.go.id/platform/terms-and-privacy (see `research/sandbox-recording-terms`) | Last updated 19 Sep 2023 |

## 1. Test identities

### Patients: 10 official dummies

[PAT] has a section "Daftar Data Pasien untuk Proses Uji Coba/Sandbox(Staging)":

> Silakan gunakan data pasien (Patient) dummy yang disediakan oleh SATUSEHAT di
> bawah ini saat proses uji coba pengiriman data (Sandbox).
>
> Data dummy ini hanya dapat digunakan pada environment Sandbox.

Translation: "Please use the dummy patient data provided by SATUSEHAT below
when trialling data submission (Sandbox). This dummy data can only be used in
the Sandbox environment."

The same table, with the same wording, appears in [MPI] §4 "Data Dummy". The
two copies match exactly.

| # | NIK | Name | Gender | birthDate | IHS number (Patient id) |
|---|---|---|---|---|---|
| 1 | 9271060312000001 | Ardianto Putra | male | 1992-01-09 | P02478375538 |
| 2 | 9204014804000002 | Claudia Sintia | female | 1989-11-03 | P03647103112 |
| 3 | 9104224509000003 | Elizabeth Dior | female | 1976-07-07 | P00805884304 |
| 4 | 9104223107000004 | Dr. Alan Bagus Prasetya | male | 1977-09-03 | P00912894463 |
| 5 | 9104224606000005 | Ghina Assyifa | female | 2004-08-21 | P01654557057 |
| 6 | 9104025209000006 | Salsabilla Anjani Rizki | female | 2001-04-16 | P02280547535 |
| 7 | 9201076001000007 | Theodore Elisjah | female | 1985-09-18 | P01836748436 |
| 8 | 9201394901000008 | Sonia Herdianti | female | 1996-06-08 | P00883356749 |
| 9 | 9201076407000009 | Nancy Wang | female | 1955-10-10 | P01058967035 |
| 10 | 9210060207000010 | Syarif Muhammad | male | 1988-11-02 | P02428473601 |

Notes:

- The NIKs end in a running sequence `...000001` to `...000010`, which is a
  sign they are synthetic.
- Row 7 ("Theodore Elisjah") is listed as `female`. That is how the source has
  it.
- The NIK-search response example in [PAT] returns `P02478375538` for NIK
  `9271060312000001` (row 1). So the table and the example agree.
- Gender and birthDate matter because [PAT] also supports search by
  name + birthdate + gender (and name + birthdate + NIK). It warns: "Terdapat
  validasi pada penulisan nama, maka pastikan nama yang di input benar sesuai
  dengan data yang terdapat di SATUSEHAT." ("Names are validated, so make sure
  the name matches the data held in SATUSEHAT.")
- No dummy is published for the newborn search by mother's NIK
  (`nik-ibu`). The response example uses `367400001111222`, a 15-digit value
  that is not in the table and is not labelled as a dummy.
- [PM-FARM] uses row 5 as its patient: `Patient_id = P01654557057`,
  `Patient_Name = Ghina Assyifa`.

### Practitioners: 10 official dummies

[PRAC] has "Daftar Data Tenaga Kesehatan untuk Proses Uji Coba/Sandbox(Staging)"
with the same two sentences (it says "data nakes (Practitioner) dummy"):

| # | NIK | Name | Gender | birthDate | IHS number (Practitioner id) |
|---|---|---|---|---|---|
| 1 | 7209061211900001 | dr. Alexander | male | 1994-01-01 | 10009880728 |
| 2 | 3322071302900002 | dr. Yoga Yandika, Sp.A | male | 1995-02-02 | 10006926841 |
| 3 | 3171071609900003 | dr. Syarifuddin, Sp.Pd. | male | 1988-03-03 | 10001354453 |
| 4 | 3207192310600004 | dr. Nicholas Evan, Sp.B. | male | 1986-04-04 | 10010910332 |
| 5 | 6408130207800005 | dr. Dito Arifin, Sp.M. | male | 1985-05-05 | 10018180913 |
| 6 | 3217040109800006 | dr. Olivia Kirana, Sp.OG | female | 1984-06-06 | 10002074224 |
| 7 | 3519111703800007 | dr. Alicia Chrissy, Sp.N. | female | 1982-07-07 | 10012572188 |
| 8 | 5271002009700008 | dr. Nathalie Tan, Sp.PK. | female | 1981-08-08 | 10018452434 |
| 9 | 3313096403900009 | Sheila Annisa S.Kep | female | 1980-09-09 | 10014058550 |
| 10 | 3578083008700010 | apt. Aditya Pradhana, S.Farm. | female | 1980-10-10 | 10001915884 |

Notes:

- Row 10 is the only pharmacist (`apt.`, S.Farm.). Row 9 is a nurse (S.Kep).
  Rows 1 to 8 are doctors.
- [PM-FARM] uses row 1 as the prescriber (`Practitioner_id = 10009880728`,
  "dr. Alexander"), row 10 as the pharmacist (`PractitionerApoteker_id =
  10001915884`), and row 9 as the assistant pharmacist
  (`PractitionerAstApoteker_id = 10014058550`, named there "Sheila Annisa, S.K").
- The NIKs also end in a running sequence (`...0001` to `...0010`).
- The NIK birth-date digits do not match the listed birthDate (row 1's NIK
  encodes 12-11-90, but birthDate is 1994-01-01). Search by NIK alone should
  work. Do not derive birthDate from the NIK.
- The Practitioner API is read-only (GET only) [PRAC]. [HAK] agrees: no
  institution type has write access to Practitioner. Fasyankes, Farmasi,
  Laboratorium and Asuransi get GET only, and Pemerintahan and Institut
  Pendidikan get no access at all. So the dummies cannot be
  created or changed by a client.
- Response example IDs such as `N10000001` (Practitioner) and `100000000001`
  (Patient placeholder) are illustrations, not dummies.

### Organization: the sandbox Org ID comes from the portal

- Each account's sandbox **Organization ID, Client ID and Client Secret** are
  shown in the SATUSEHAT Platform portal: log in, choose environment
  **Sandbox** (top left), then menu **Kode Akses API** [SBX]. This works for
  accounts that are registered, verified, or not yet verified: "dapat
  digunakan oleh fasyankes, serta partners system yang telah
  bergabung/terdaftar/terverifikasi maupun yang belum terverifikasi" [SBX].
- That Org ID is the parent organisation ("organisasi induk"). In production
  a facility gets its SATUSEHAT number from Kemenkes when it registers, and
  then **POSTs its own sub-organisations** (departments, units) with
  `partOf` pointing at the parent [R-ORG]. The identifier system is
  `http://sys-ids.kemkes.go.id/organization/{organization-ihs-number}` [R-ORG].
- One Client ID/Secret is bound to one Organization ID. Sending a different
  Org ID gets `"resource cannot be accessed due to business rule"`
  ([KFA], [MPI]; also in `research/satusehat-token-api`).
- The Organization API supports GET (search by `name` or `partof`, read by
  id), POST, PUT and PATCH [ORG]. No DELETE.
- No **dummy** Organization is published. The `partof=10000004` example and
  the UUID `38d2fd4d-...` in [ORG] are illustrations, covered by the
  disclaimer "Setiap nilai yang dicontohkan ... adalah nilai yang tidak
  sebenarnya dan tidak dapat dipakai" ("every example value is not real and
  cannot be used") [ORG] [SBX].
- [SBX]: the **"Tipe Kode Akses API"** (institution type) of the sandbox
  credential can be changed with *Ubah Data* > *Simpan*. It "menentukan
  batasan akses resource pengiriman data SATUSEHAT berdasarkan jenis
  institusinya" (limits which resources the credential may send). The
  per-type matrix is [HAK]. A hospital pharmacy should normally use type
  **Fasyankes**. See §3 for the differences that matter.

### Location: created by the client, no dummy

- The client creates its own Locations with POST and can change them with
  PUT/PATCH [LOC]. Each one is tied to the managing organisation via
  `managingOrganization` (the parent Org ID or a sub-organisation id) [R-LOC].
- The identifier system is
  `http://sys-ids.kemkes.go.id/location/{organization-ihs-number}` [R-LOC].
  The [LOC] search example is
  `identifier=http://sys-ids.kemkes.go.id/location/1000001|G-2-R-1A`, an
  illustrative value.
- No dummy Location is published. [PM-FARM] ships collection variables with
  Location ids (`Location_id = c0400df9-...`, `LocationApotek_id =
  1cca7566-...`, "Ruang Apotek"). These are Kemenkes' own workshop records.
  Whether another client can read or reference them is unstated (§2).
- [R-ORG] links a "Template Registrasi Organization & Location" for this
  onboarding step. It was not opened for this note.

## 2. Shared or per-client data; deletion and reset

**Shared vs per-client: not stated anywhere.** No page says whether sandbox
data is one pool for every user or isolated per client. Evidence either way:

- **Shared (documented):** the dummy Patients and Practitioners are the same
  fixed IHS numbers for every user. Everyone who follows the docs references
  `P01654557057`, `10009880728`, and so on. Every client's test Encounters,
  MedicationRequests and MedicationDispenses therefore hang off the same 20
  subjects and performers.
- **Inference, not documented:** because subjects are shared, any search keyed
  on a patient (for example `MedicationRequest?subject=Patient/P01654557057`)
  may return other users' records, *if* the server does not filter by the
  calling organisation. Whether it filters is not stated. A live-sandbox mode
  should search by its own identifiers (`.../prescription/{own-org}|...`,
  `.../encounter/{own-org}|...`) and not assume that "subject + date" is
  unique to it.
- **Partial isolation (documented):** writes are bound to the credential's own
  Organization ID by the business-rule check above.

**Deletion: not possible for a hospital (Fasyankes) credential.**

- No API page documents a DELETE request. The onboarding pages offer only
  GET/POST/PUT/PATCH (Patient: GET/POST/PATCH; Practitioner: GET only) [ORG]
  [LOC] [PAT] [PRAC].
- [HAK], tab **Fasyankes**: `DELETE = FALSE` for every one of its 53
  resources, including Encounter, Medication, MedicationRequest,
  MedicationDispense, Organization and Location.
- [HAK], tab **Farmasi**: `DELETE = TRUE` on 21 resources, including
  Encounter, Location, Medication, MedicationRequest, MedicationDispense and
  Organization. No page documents how DELETE works, so this is a matrix entry
  only, unverified.
- So test records created with a Fasyankes credential stay. The only way to
  "undo" them is a status change (for example `entered-in-error` via
  PUT/PATCH). That is standard FHIR, not documented for SATUSEHAT as a
  clean-up method.

**Reset: not stated.** No page says the sandbox is wiped, refreshed, or
reset on a schedule. The changelog entries "Update Daftar Data ... untuk Proses
Uji Coba/Sandbox(Staging)" (v7.14, 18 Nov 2024) [NEW] show the dummy lists
themselves have changed at least once. So treat the IHS numbers as
"current as of v7.14" and confirm them with a live NIK search.

## 3. Quotas and limits

- **No quota or request limit for the sandbox is published.** I searched the
  pages above for "kuota", "quota", "limit", "terbatas" (limited), "batas"
  and "rate". None of them gives a sandbox request quota, a cap on records
  created, or any statement that sandbox data is limited or must not be
  exhausted.
- The only rate limit documented anywhere is on the **token** endpoint:
  "Rate limit: 1 request per minute after a failed attempt", which also
  triggers when tokens are generated too often. See
  `research/satusehat-token-api`. It applies to sandbox, since the docs
  describe it against the sandbox host.
- **What [SBX] calls a "batasan" (limit) is access scope, not volume:** the
  credential's institution type decides which resources and methods it may
  use [HAK]. Relevant rows for this project:

  | Resource | Fasyankes (GET/PATCH/POST/PUT/DELETE) | Farmasi |
  |---|---|---|
  | Patient | GET, PATCH only (no POST) | GET, PATCH only |
  | Practitioner | GET only | GET only |
  | Organization, Location | GET, PATCH, POST, PUT | all five, incl. DELETE |
  | Encounter, Medication, MedicationRequest, MedicationDispense | GET, PATCH, POST, PUT | all five, incl. DELETE |

- **Number of identities is the practical limit:** 10 patients and 10
  practitioners, of whom only one is a pharmacist (§1). This is a fact about
  the published list, not a stated quota.
- KFA list endpoints take `page` and `size`. Examples use `size=100` and
  `size=10`. No maximum is stated [KFA].

## 4. KFA v2 in the sandbox

- **Same host, different path:** [KFA] lists base URLs per environment:

  | API | Sandbox | Production |
  |---|---|---|
  | Auth | `https://api-satusehat-stg.dto.kemkes.go.id/oauth2/v1` | `https://api-satusehat.kemkes.go.id/oauth2/v1` |
  | KFA v1 | `.../kfa` | `.../kfa` |
  | KFA v2 | `https://api-satusehat-stg.dto.kemkes.go.id/kfa-v2` | `https://api-satusehat.kemkes.go.id/kfa-v2` |
  | KFA ALKES | `.../kfa-v3` | `.../kfa-v3` |

  So the base URL is not the FHIR base (`/fhir-r4/v1`). It is a sibling path
  on the same host.
- **Same OAuth flow and token endpoint:** [KFA] reuses the
  `client_credentials` flow, the same `/oauth2/v1/accesstoken` URL, and a
  sample response with `api_product_list: "[api-sandbox]"`.
- **No separate KFA credential is mentioned.** [KFA] never says KFA needs its
  own client ID. It also never says in so many words that the FHIR sandbox
  credential works for KFA. Using the same credential is the natural
  reading, but it is not verified.
- **Conflict:** [KFA]'s "Cara Mendapatkan Nilai dari client_id dan
  client_secret" says the facility's EMR system must be verified on SSP and
  the facility must have updated its data in DFO/REGFASYANKES/RS ONLINE. The
  field descriptions say the values come from Kemenkes "setelah melakukan
  pengajuan via email" (after applying by email). [SBX], by contrast, gives
  sandbox credentials to unverified accounts. The [KFA] text reads like the
  production rule copied onto a page that "uses the sandbox environment for
  all examples". The same boilerplate appears on [MPI] and the MSI page.
- [HAK] lists FHIR resources only. KFA (and MPI/MSI master data) is not in
  the matrix, so it does not say whether a given institution type may call
  KFA.
- Changelog: KFA v1 product search was removed in v7.20 (27 Sep 2025)
  [NEW]. Use v2.

## Conflicts found

1. **Response examples use a third host.** [PAT]'s sample responses use
   `https://api-satusehat-dev.dto.kemkes.go.id/fhir-r4/v1/...` in
   `fullUrl`/`link.url`. The request URLs on the same page, and [EP], use
   `api-satusehat-stg`. [PRE] says there are "tiga endpoint" (three
   endpoints) but lists only Sandbox and Production. Use `-stg`. Do not
   validate `fullUrl` hosts strictly.
2. **Patient POST.** [PAT] documents POST Patient (newborn registration),
   but [HAK] has `POST = FALSE` on Patient for all six institution types.
3. **KFA credential prerequisites** (verified EMR system, by email) vs
   [SBX] (any account) (see §4).
4. **Farmasi vs Fasyankes DELETE:** [HAK] grants DELETE to Farmasi, but no
   DELETE API is documented anywhere.

## Unstated / unverified

- Whether sandbox data is shared across all clients or filtered per
  organisation on reads/searches.
- Whether, and when, the sandbox is reset or purged.
- Any quota on sandbox requests or records created, or a statement that
  sandbox data is "limited" or must not be exhausted. None found.
- Whether DELETE actually works for a Farmasi-type credential, and how.
- Whether the sandbox FHIR credential is accepted by KFA v2 without extra
  approval. This needs one live check by the account owner.
- Whether real (non-dummy) NIKs resolve in the sandbox MPI. The docs only say
  the dummies are sandbox-only. They do not say that real NIKs fail there.
  Do not test with real NIKs.
- Whether the Location/Encounter ids in [PM-FARM]'s variables are readable or
  referenceable from another organisation's credential.
- The "Template Registrasi Organization & Location" linked from [R-ORG] was
  not opened.
- Postman: only the "04. Pelayanan - Farmasi" collection's metadata and
  variables were read. The workspace list, the Sandbox **environment** file
  (`s.kemkes.go.id/EnvironmentPostmanSATUSEHAT`, JS-only) and the
  "Prerequisites" collection were not read. They may hold more dummy values.
- The SATUSEHAT FAQ (https://faq.kemkes.go.id/category/satusehat-platform)
  returned HTTP 502 again, so it was not reviewed.
- [HAK] is undated, so it could be stale relative to the v7.23 portal.

## Implications for the live-sandbox mode (suggestions, not findings)

- Configure the Org ID, Client ID and Secret from the operator's own portal
  page. Never hard-code the doc examples.
- Ship the 10 + 10 dummy identities as a config list (they are
  platform-published test data), defaulting to patient row 5 and pharmacist
  row 10 like [PM-FARM]. Resolve them with a NIK search at start-up, because
  the list has changed before.
- Make every identifier unique per run (for example, prefix the prescription
  number with a run id). Records cannot be deleted, and other users share the
  same subjects.
- Keep request volume low and reuse tokens. There is no published quota, but
  the token endpoint is rate-limited and the sandbox is a shared resource.
- Recorded sandbox responses still fall under the repo's existing ruling in
  `research/sandbox-recording-terms` (do not commit them).
