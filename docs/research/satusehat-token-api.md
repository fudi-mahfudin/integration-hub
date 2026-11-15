# SATUSEHAT access-token API: flow, expiry, refresh

Research for issue #3. Retrieved 2026-11-15 from the official SATUSEHAT
Platform documentation (portal banner: "Versi 7.23"). The docs are in
Indonesian; quotes below are translated unless marked verbatim.

## Sources

- [S1] Akses Token (token endpoint spec):
  https://satusehat.kemkes.go.id/platform/docs/id/api-catalogue/authentication/apis/token/
- [S2] Autentikasi (overview):
  https://satusehat.kemkes.go.id/platform/docs/id/api-catalogue/authentication/
- [S3] Endpoint Information:
  https://satusehat.kemkes.go.id/platform/docs/id/postman-workshop/endpoint-information/
- [S4] Kode Akses API (overview):
  https://satusehat.kemkes.go.id/platform/docs/id/api-code/
- [S5] Kode Akses API (Sandbox):
  https://satusehat.kemkes.go.id/platform/docs/id/api-code/access-sandbox/
- [S6] Kode Akses API (Production):
  https://satusehat.kemkes.go.id/platform/docs/id/api-code/access-production/
- [S7] Postman Collection page (links to the public workspace):
  https://satusehat.kemkes.go.id/platform/docs/id/postman-workshop/
- [S8] Sample FHIR API pages checked for rate-limit text:
  https://satusehat.kemkes.go.id/platform/docs/id/api-catalogue/integrations/apis/medication-dispense/
  and https://satusehat.kemkes.go.id/platform/docs/id/api-catalogue/onboardings/apis/patient/

## Flow

- OAuth 2 with grant type `client_credentials`, server to server. No user
  login step. The only inputs are `client_id` and `client_secret`, issued once
  Kemenkes has approved the applicant. [S2]
- Get the credentials (Organization ID, Client ID, Client Secret) from the
  SATUSEHAT Platform portal, menu "Kode Akses API". Pick the Sandbox or
  Production environment there. [S5] [S6]
- One Client ID/Secret is bound to exactly **one Organization ID**. Sending
  data for a different Organization ID fails with `"resource cannot be
  accessed due to business rule"` (verbatim). [S2] [S4]
- Send the token on every FHIR call as `Authorization: Bearer <access_token>`. [S1] [S8]

## Endpoints

| Environment | OAuth base URL | FHIR base URL |
|---|---|---|
| Sandbox (Staging) | `https://api-satusehat-stg.dto.kemkes.go.id/oauth2/v1` | `https://api-satusehat-stg.dto.kemkes.go.id/fhir-r4/v1` |
| Production | `https://api-satusehat.kemkes.go.id/oauth2/v1` | `https://api-satusehat.kemkes.go.id/fhir-r4/v1` |

Sources: [S3]; the OAuth base URLs also appear in [S2]. The token path is
`/accesstoken` under the OAuth base. [S1] shows it only for sandbox; the
production token URL `https://api-satusehat.kemkes.go.id/oauth2/v1/accesstoken`
is the same path on the production base. That is an inference from [S2] and
[S3], not a URL printed on a page.

## Request [S1]

- `POST {oauth-base}/accesstoken?grant_type=client_credentials`
- `grant_type=client_credentials` goes in the **query string**, not the body
  (required).
- Header `Content-Type: application/x-www-form-urlencoded` (required).
- Form body: `client_id`, `client_secret` (both required).

```
curl --location \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'client_id=<client-id>' \
  --data-urlencode 'client_secret=<client-secret>' \
  --request POST \
  'https://api-satusehat-stg.dto.kemkes.go.id/oauth2/v1/accesstoken?grant_type=client_credentials'
```

(The official sample also passes `--insecure`. It is left out above. Do not
copy it into production code.)

## Response [S1]

2xx and 4xx responses are `application/json`. Sample 2xx body (verbatim,
placeholder values):

```json
{
  "refresh_token_expires_in": "0",
  "api_product_list": "[api-sandbox]",
  "api_product_list_json": ["api-sandbox"],
  "organization_name": "ihs-prod-1",
  "developer.email": "<email-dev>",
  "token_type": "BearerToken",
  "issued_at": "1671109805593",
  "client_id": "<client-id>",
  "access_token": "<access-token>",
  "application_name": "992291b8-a613-40aa-b27c-41e480c7585f",
  "scope": "",
  "expires_in": "3599",
  "refresh_count": "0",
  "status": "approved"
}
```

Notes:

- `token_type` is `BearerToken`, not the RFC 6749 `Bearer`. The docs still
  say to send `Authorization: Bearer <access_token>`. [S1]
- **Expiry:** the docs describe `expires_in` as how long the `access_token` can
  be used, **in seconds**. The sample value is `"3599"` (about 1 hour). [S1]
- **Type mismatch:** the data-structure block types `expires_in` as `string`,
  its footnote says `number`, and the sample sends a JSON string. Most
  "number" fields in the sample (`refresh_token_expires_in`, `refresh_count`,
  `scope`) are strings too. Parse them leniently: accept a string or a
  number. [S1]
- `issued_at` is documented only as a string holding the token creation time.
  The sample `1671109805593` looks like epoch **milliseconds** (2022-12-15),
  but the docs do not state the unit. [S1]
- The error envelope (4xx) is a FHIR `OperationOutcome` with
  `issue[].severity`, `issue[].code` and `issue[].details.text`. 5xx responses
  are `text/plain` (sample: `Gateway Timeout`). [S1]

## Refresh tokens

- No refresh-token flow is documented. The only grant described is
  `client_credentials` [S2]. The response has no `refresh_token` field, and
  `refresh_token_expires_in` is `"0"` and `refresh_count` is `"0"` in the
  sample [S1].
- In practice a client asks for a new token with the same
  client-credentials call. The docs never say this in so many words; it
  follows from the above.

## Rate limits

- **Token endpoint, documented** [S1], 4xx message (verbatim):
  `"Authentication temporarily cannot be performed due to the rate limit policy. Rate limit: 1 request per minute after a failed attempt."`
  The Indonesian explanation next to it says that for each `client_id`, a
  wrong `client_secret` is allowed only **once per minute**, **or** the error
  appears when new tokens are generated too often within a minute.
  - The docs give no number for "too often" on successful token requests.
  - The docs do not give the HTTP status code for this error (not stated
    whether it is 429 or another 4xx).
- **FHIR API in general:** I found no documented rate limit or quota. I
  checked the token, authentication, endpoint and API-access-code pages and
  two FHIR resource pages [S8]. I did not check every resource page.

Takeaway for the client: cache the token and reuse it until shortly before
`issued_at + expires_in`. Do not request a token per call. After an auth
failure, back off for at least 60 s.

## Sandbox vs production

- Hosts differ: `api-satusehat-stg.dto.kemkes.go.id` vs
  `api-satusehat.kemkes.go.id`. Paths are the same. [S3]
- The request/response spec is documented only once, against sandbox ("all
  examples use the sandbox environment"). [S2] No behavioural differences
  (expiry, rate limits) are documented.
- Credentials are separate per environment:
  - Sandbox credentials are available to any SATUSEHAT Platform account,
    verified or not, and are meant for self-service workshops. [S5]
  - Production credentials require registration. A facility gets its own
    production credentials and may delegate them to a verified EMR vendor.
    A vendor has no production credentials of its own; it sees those of
    partner facilities that picked its system. [S4] [S6]
- In sandbox the credential "type" (institution type) can be changed. It
  limits which FHIR resources the credential may send. [S5]
- The sample response shows `api_product_list: "[api-sandbox]"`. It is
  presumably different in production, but this is not documented.

## Not verified / gaps

- **Postman public workspace**
  (https://www.postman.com/satusehat/workspace/satusehat-public/overview,
  linked from [S7]) could not be read. The page is client-side rendered and
  returns no content to a non-browser fetch. The Kemkes download short-links
  (`s.kemkes.go.id/...`) are also JS-only. Nothing in this note comes from
  the Postman collection; someone should check it manually in a browser.
- Production token URL: inferred from the base URL, not printed in the docs
  (see Endpoints).
- HTTP status code for the rate-limit error, and the threshold for successful
  token requests: not documented.
- Unit of `issued_at`: not documented. Epoch ms is an inference from the
  sample.
- FHIR API rate limits/quotas: none found.
- Whether a token stays valid after a new one is issued for the same client
  (single active token or several): not documented.
