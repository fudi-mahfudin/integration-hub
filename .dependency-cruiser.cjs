/**
 * Import boundaries checked in CI (`pnpm lint:boundaries`).
 * ADR 0006: the mock SATUSEHAT validates with its own code, so it must never
 * import hub code, and the hub's production code must never import the mock.
 * (Hub *tests* may use the mock's typed client and server.)
 */
module.exports = {
  forbidden: [
    {
      name: 'mock-must-not-import-hub',
      comment: 'ADR 0006: the mock shares no code with the hub.',
      severity: 'error',
      from: { path: '^packages/mock-satusehat/' },
      to: { path: '^apps/hub/' },
    },
    {
      name: 'hub-src-must-not-import-mock',
      comment: 'ADR 0006: hub production code never uses the mock\'s validators or templates.',
      severity: 'error',
      from: { path: '^apps/hub/src/' },
      to: { path: '^packages/mock-satusehat/' },
    },
    {
      name: 'not-to-unresolvable',
      comment: 'An import the checker cannot resolve could hide a boundary breach.',
      severity: 'error',
      from: { path: '^(apps|packages)/' },
      to: { couldNotResolve: true, dependencyTypesNot: ['type-only'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|dist)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
  },
};
