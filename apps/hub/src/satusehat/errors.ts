/** SATUSEHAT answered a request with a status the adapter did not expect. */
export class SatusehatRequestError extends Error {
  constructor(
    readonly method: string,
    readonly url: URL,
    readonly status: number,
    body: string,
  ) {
    // Path only: the query may carry a NIK. The body is cut short; it is an OperationOutcome at most.
    super(`SATUSEHAT ${method} ${url.pathname} answered ${status}: ${body.slice(0, 500)}`);
    this.name = 'SatusehatRequestError';
  }
}

/** SATUSEHAT answered with the expected status, but its body is not what the adapter can read. */
export class SatusehatResponseError extends Error {
  constructor(
    readonly method: string,
    readonly url: URL,
    problem: string,
    options?: { cause: unknown },
  ) {
    super(`SATUSEHAT ${method} ${url.pathname} answered with ${problem}`, options);
    this.name = 'SatusehatResponseError';
  }
}
