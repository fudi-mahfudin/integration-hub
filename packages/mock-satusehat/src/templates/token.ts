import { defineTemplate, docs } from './provenance.js';

export interface TokenResponse {
  organization_name: string;
  token_type: string;
  issued_at: string;
  client_id: string;
  access_token: string;
  expires_in: string;
  status: string;
}

export const tokenResponse = defineTemplate({
  name: 'token response',
  provenance: { tag: 'satusehat-docs', note: 'access-token success body; every value fake', link: docs.token },
  fields: {
    issued_at: { tag: 'assumed', note: 'epoch milliseconds as a string; unit not documented, inferred from the sample' },
    expires_in: { tag: 'satusehat-docs', note: 'seconds, sent as a JSON string', link: docs.token },
  },
  build: (a: { accessToken: string; clientId: string; organizationName: string; issuedAtMs: number; expiresInSeconds: number }): TokenResponse => ({
    organization_name: a.organizationName,
    token_type: 'BearerToken',
    issued_at: String(a.issuedAtMs),
    client_id: a.clientId,
    access_token: a.accessToken,
    expires_in: String(a.expiresInSeconds),
    status: 'approved',
  }),
});
