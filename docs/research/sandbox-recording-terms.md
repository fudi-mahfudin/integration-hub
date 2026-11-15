# Can recorded SATUSEHAT sandbox responses be committed to a public repo?

Research for issue #4. Sources checked on 2026-11-15. This is not legal advice. It reports what the official sources say.

## Answer

**No, not without written permission, going by the plain text.** The only published terms on satusehat.kemkes.go.id are the "Ketentuan Umum dan Kebijakan Privasi" (General Terms and Privacy Policy, last updated 19 September 2023). They say nothing about a sandbox, staging environment, or test data. They do contain a broad intellectual-property clause that forbids storing, republishing, distributing, or displaying "any content from SATUSEHAT" without written permission from SATUSEHAT. Nothing in the terms excludes the sandbox from that clause. Removing credentials and identifiers does not change this, because the clause is about the content itself, not about personal data.

I found no separate developer agreement, sandbox terms of use, or terms on the sandbox access-code page.

## Sources and exact clauses

### 1. General Terms and Privacy Policy (the only terms document found)

URL: https://satusehat.kemkes.go.id/platform/terms-and-privacy (linked from the footer of https://satusehat.kemkes.go.id/platform). "Terakhir diperbarui tanggal: 19 September 2023."

**Scope.** "SATUSEHAT" is defined broadly and includes portals:

> "SATUSEHAT" adalah platform, sistem, dan/atau aplikasi layanan integrasi dan interoperabilitas data antar Fasilitas Pelayanan Kesehatan yang diselenggarakan oleh Kementerian Kesehatan. Termasuk produk turunannya seperti Portal RME, SATUSEHAT Mobile, SATUSEHAT Portal, Portal SATUSEHAT Dashboard.

Under "Ruang Lingkup Pemberlakuan" (Scope):

> Ketentuan ini berlaku secara mutatis mutandis terhadap Platform SATUSEHAT dan produk turunannya [...] terkecuali ditentukan lain.
>
> Masing-masing produk turunan Platform SATUSEHAT dapat menetapkan tata kelola lebih lanjut yang bersifat teknis dan operasional.

The terms do not mention the sandbox or staging environment, so they neither exclude it nor give it a separate regime. I searched the page text for "sandbox" and "staging" and found no matches.

**Intellectual property: the decisive clause.** Under "Hak Kekayaan Intelektual":

> Segala merek, logo, gambar, ikon, source code, atau desain, serta apapun yang terdapat dalam SATUSEHAT merupakan kepemilikan yang diperoleh secara sah oleh SATUSEHAT dan dilindungi oleh undang-undang.
>
> Pengguna atau pihak manapun dilarang keras untuk menyalin, mengunduh, mereproduksi, menyimpan, mentransmisikan, menerbitkan ulang, memodifikasi, membuat karya turunan, mendistribusikan, mendistribusikan ulang, menampilkan, melisensikan, menyewakan atau mengeksploitasi konten apapun dari SATUSEHAT, seluruh atau sebagian dengan cara apapun tanpa izin tertulis dari SATUSEHAT.

My translation: "Users or any party are strictly prohibited from copying, downloading, reproducing, storing, transmitting, republishing, modifying, creating derivative works of, distributing, redistributing, displaying, licensing, renting, or exploiting any content from SATUSEHAT, in whole or in part, by any means, without written permission from SATUSEHAT."

A recorded sandbox response is content that SATUSEHAT returned. Committing it publicly would be storing, republishing, and distributing it. The clause has no exception for test data or redacted data.

Caveat: read literally, the clause also covers "mengunduh" (downloading) and "menyimpan" (storing), which any API client does. So it is overbroad, and how it is enforced against ordinary integration use is unclear. Even so, public redistribution sits squarely within the listed acts.

**Prohibited conduct: credentials and personal data.** Under "Indikasi Fraud/Hal yang dilarang":

> Menampilkan dan menyebarluaskan data pribadi orang lain.
>
> Mengalihkan, meminjamkan, menjual dan mentransfer lisensi, client ID, Client secret atau API yang diberikan kepada Pengguna lain.
>
> Membongkar, mendekompilasi, membuka kunci, merekayasa balik, atau mendekode SATUSEHAT dengan cara apa pun atau memodifikasi atau membuat karya turunan apapun berdasarkan SATUSEHAT.

Stripping credentials and identifiers deals with the first two clauses. It does not deal with the intellectual-property clause above.

**Changes to the terms.** Under "Perubahan Atas Syarat dan Ketentuan Penggunaan":

> Ketentuan Umum dan Privasi ini dapat diubah atau diperbaharui dari waktu ke waktu dengan atau tanpa pemberitahuan kepada Pengguna. Dengan tetap mengakses SATUSEHAT, maka Pengguna dianggap telah membaca, memahami dan menyetujui Ketentuan Umum dan Privasi ini [...]

So using the sandbox at all counts as accepting these terms.

**Contact for permission.** The "Pemberitahuan" section sends written questions and complaints to `helpdesk@kemkes.go.id`. This is the only official channel I found that could grant "izin tertulis" (written permission).

### 2. Sandbox access-code page

URL: https://satusehat.kemkes.go.id/platform/docs/id/api-code/access-sandbox/

The page has no terms of use and no restrictions on reuse or publication. It links to no terms page. Relevant text:

> Setiap nilai yang dicontohkan atau ditampilkan di dokumentasi ini adalah nilai yang tidak sebenarnya dan tidak dapat dipakai.

(Every value shown as an example in this documentation is not a real value and cannot be used.) This is about the documentation's example values. It does not grant any licence.

### 3. Registration and access-request pages

- https://satusehat.kemkes.go.id/platform/docs/id/registration-guide/registration/
- https://satusehat.kemkes.go.id/platform/docs/id/api-catalogue/authentication/registration/

Neither page has terms, a developer agreement, or reuse rules. The only related text is the footer: "Isi dari dokumentasi ini dikelola oleh tim dari Kementerian Kesehatan Republik Indonesia." The documentation pages show no licence for their content (no Creative Commons or similar notice).

### 4. Not found or not verifiable

- **Separate developer agreement or sandbox terms:** none published on satusehat.kemkes.go.id that I could find, either by searching or by following links from the platform home page, the playbook, and the registration pages.
- **Click-through terms inside the logged-in portal** (account creation or sandbox activation): I could not check these because they need an account. Whoever owns the sandbox account should look at what was accepted at sign-up.
- **FAQ** (https://faq.kemkes.go.id/category/satusehat-platform): returned HTTP 502 when I checked, so it was not reviewed.
- **Supporting policies page** (https://satusehat.kemkes.go.id/platform/supporting-policies): lists statutes (UU 17/2023, PMK 24/2022, and others). It has no developer or reuse terms.

## Safe alternatives

These are ordered from safest to least safe.

1. **Hand-written synthetic fixtures based on the FHIR R4 specification.** Write fixtures yourself from the HL7 FHIR R4 resource definitions. The HL7 spec says: "This document is licensed under Creative Commons "No Rights Reserved" (CC0)" (https://hl7.org/fhir/R4/license.html). Add SATUSEHAT-specific details (identifier system URIs, required elements, profile shape) as facts you write in your own words, not as copied response bodies. Use clearly fake values. This fits ADR 0006 (the mock validates on its own) and keeps every fixture under the repo's licence.
2. **Record locally, never commit.** Recorded sandbox traffic can still drive local contract checks if it stays in a git-ignored directory. Use it to confirm the hand-written fixtures match real platform behaviour. Whether even local storage is allowed is unclear (see the caveat about "menyimpan"), but this avoids public redistribution.
3. **Commit only derived assertions, not responses.** For example, a test can say "the response for a Patient search by NIK is a Bundle with `total` 0 or 1". That records knowledge about behaviour without copying content.
4. **Ask for written permission** at `helpdesk@kemkes.go.id` before publishing any recorded response. Keep the reply in the repo, or cite it in the README.
5. **Do not copy documentation examples verbatim.** The intellectual-property clause applies to "konten apapun dari SATUSEHAT", and the docs live on the SATUSEHAT portal with no open licence. So copying the official documentation's example JSON word for word is not clearly safe either. Using the docs as a reference to write your own fixtures (option 1) is the safer reading.

## Recommendation for the project

Treat committing recorded sandbox responses as not permitted. Build fixtures by option 1 and check them against the sandbox locally by option 2. Say in the README that the fixtures are synthetic and why.
