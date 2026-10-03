// Module boundaries (0.2.10), as docs/reference/architecture.md draws them:
// presentation → application → domain inside a module; adapters live in a
// module's infrastructure/ and only a composition root (a *.module.ts) wires
// them; modules meet through their application services. Checked by
// `just boundaries` (scripts/check-boundaries.mjs) in `just check` and CI,
// independently of the linter. Violations in code a later step rebuilds are
// recorded in .dependency-cruiser-known-violations.json, which only shrinks.

// Packages the domain never sees: the framework, the database client, HTTP,
// queues and provider SDKs — matched resolved (node_modules/…) or by name.
const SDKS =
  '(@nestjs|@prisma|\\.prisma|express|axios|pg|bullmq|ioredis|@aws-sdk|nodemailer|socket\\.io)';
const FRAMEWORK = `(^|/)node_modules/${SDKS}/|^${SDKS}(/|$)`;

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'domain-is-framework-free',
      comment:
        "A module's domain/ holds pure states, decisions and money and date rules: it imports no Nest, Prisma, HTTP, queue or provider SDK.",
      severity: 'error',
      from: { path: '^src/modules/[^/]+/domain/' },
      to: { path: FRAMEWORK },
    },
    {
      name: 'domain-is-innermost',
      comment:
        'The domain depends on nothing outside it: no use case, controller, adapter or shared infrastructure.',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/domain/' },
      to: {
        path: '^src/(infrastructure/|modules/[^/]+/(application|presentation|infrastructure)/)',
      },
    },
    {
      name: 'adapters-are-wired-by-composition-roots',
      comment:
        "Use cases depend on ports; only a composition root (the module's *.module.ts) wires an adapter to them.",
      severity: 'error',
      from: { path: '^src/modules/[^/]+/application/' },
      to: { path: '^src/modules/[^/]+/infrastructure/' },
    },
    {
      name: 'presentation-skips-infrastructure',
      comment:
        'A controller calls a use case: it never reaches a repository, an adapter or the database client.',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/presentation/' },
      to: { path: '^src/(infrastructure/|modules/[^/]+/infrastructure/)' },
    },
    {
      name: 'modules-meet-through-their-application',
      comment:
        "Another module is reached through its exported application services and typed identifiers — never its repositories, adapters or controllers.",
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/[^/]+/(infrastructure|presentation)/',
        pathNot: '^src/modules/$1/',
      },
    },
    {
      name: 'shared-code-reaches-modules-through-their-application',
      comment:
        "Code outside the modules (guards, filters, infrastructure) reaches a module through its application services — never its repositories, adapters or controllers.",
      severity: 'error',
      from: { path: '^src/(?!modules/)' },
      to: { path: '^src/modules/[^/]+/(infrastructure|presentation)/' },
    },
  ],
  options: {
    // Production code only: a test composes what it needs, like a root does.
    exclude: { path: '\\.spec\\.ts$' },
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true, // a type-only import crosses a boundary too
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
  },
};
