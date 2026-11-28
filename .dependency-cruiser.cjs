// Import-boundary rules, checked in CI by `pnpm boundaries`.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'mock-satusehat-is-independent-of-the-hub',
      comment:
        'ADR 0006: the mock SATUSEHAT validates with its own code. It must not import any hub module, ' +
        'or a wrong rule would be wrong on both sides and every test would still pass.',
      severity: 'error',
      from: { path: '^packages/mock-satusehat/' },
      to: { path: ['^apps/hub/', 'node_modules/@integration-hub/hub/'] },
    },
    {
      name: 'simulator-is-independent-of-the-hub',
      comment:
        'The source simulator stands in for an external source system (ADR 0001): it talks to the hub only over HTTP, ' +
        'so it must not import any hub module.',
      severity: 'error',
      from: { path: '^packages/simulator/' },
      to: { path: ['^apps/hub/', 'node_modules/@integration-hub/hub/'] },
    },
    {
      name: 'bigrun-is-independent-of-the-hub',
      comment:
        'The big-run harness judges the hub from outside (#45): it reads the hub only through its public API, ' +
        'so it must not import any hub module.',
      severity: 'error',
      from: { path: '^packages/bigrun/' },
      to: { path: ['^apps/hub/', 'node_modules/@integration-hub/hub/'] },
    },
    {
      name: 'contract-check-is-independent-of-the-hub',
      comment:
        'The contract check compares the mock SATUSEHAT with the sandbox (#48); the hub is no party to it, ' +
        'so it must not import any hub module.',
      severity: 'error',
      from: { path: '^packages/contract-check/' },
      to: { path: ['^apps/hub/', 'node_modules/@integration-hub/hub/'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    combinedDependencies: true,
    preserveSymlinks: false,
  },
};
