import { defineTemplate, DOCS } from './provenance.js';

/** Body of a successful client_credentials token response. */
export interface TokenResponseBody {
  access_token: string;
  token_type: 'BearerToken';
  /** Seconds, sent as a string like the real platform does. */
  expires_in: string;
  /** Epoch milliseconds, as a string. */
  issued_at: string;
  client_id: string;
  organization_name: string;
  status: 'approved';
}

/** 200 from the token endpoint. Only the fields the hub reads are kept. */
export const tokenIssued = defineTemplate(
  {
    tag: 'satusehat-docs',
    note: 'Akses Token page sample response, reduced to the fields the hub reads, values fake',
    link: DOCS.token,
    fields: {
      issued_at: { tag: 'assumed', note: 'docs give no unit; the sample looks like epoch milliseconds' },
    },
  },
  (args: { accessToken: string; expiresInSeconds: number; issuedAt: Date; clientId: string; organizationName: string }): TokenResponseBody => ({
    access_token: args.accessToken,
    token_type: 'BearerToken',
    expires_in: String(args.expiresInSeconds),
    issued_at: String(args.issuedAt.getTime()),
    client_id: args.clientId,
    organization_name: args.organizationName,
    status: 'approved',
  }),
);

/** 401 from the token endpoint for wrong or missing client credentials. */
export const tokenRejected = defineTemplate(
  {
    tag: 'satusehat-docs',
    note: 'Akses Token page: 4xx bodies are an OperationOutcome with issue.details.text',
    link: DOCS.token,
    fields: { 'issue.details.text': { tag: 'assumed', note: 'wording for wrong credentials is ours' } },
  },
  (reason: string): fhir4.OperationOutcome => ({
    resourceType: 'OperationOutcome',
    issue: [{ severity: 'error', code: 'security', details: { text: reason } }],
  }),
);

/** 429 from the token endpoint during the throttle window after a failed token request. */
export const tokenThrottled = defineTemplate(
  {
    tag: 'satusehat-docs',
    note: 'Akses Token page documents the rate-limit message after a failed attempt',
    link: DOCS.token,
    fields: { status: { tag: 'assumed', note: 'the docs give no status code; 429 is our choice' } },
  },
  (): fhir4.OperationOutcome => ({
    resourceType: 'OperationOutcome',
    issue: [
      {
        severity: 'error',
        code: 'throttled',
        details: {
          text: 'Authentication temporarily cannot be performed due to the rate limit policy. Rate limit: 1 request per minute after a failed attempt.',
        },
      },
    ],
  }),
);
