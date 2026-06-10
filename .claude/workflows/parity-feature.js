export const meta = {
  name: 'parity-feature',
  description: 'Keep the Swift and web Helmsman apps in parity for one change',
  whenToUse: 'Porting a Swift panel to web (mode=porter) or adding a feature to both apps (mode=feature)',
  phases: [
    { title: 'Spec' },
    { title: 'Implement' },
    { title: 'Verify' },
  ],
}

// args: { mode: 'porter' | 'feature', feature: string, request: string }
// Coerce: the runtime may hand `args` through as a JSON-encoded string.
let a = args
if (typeof a === 'string') {
  try { a = JSON.parse(a) } catch { /* leave as the raw string */ }
}
const mode = (a && a.mode) || 'porter'
const feature = (a && a.feature) || 'unnamed-feature'
const request = (a && a.request) || ''

// Fail fast (before spawning any agents) if args did not arrive — this turns a
// misconfigured invocation into a cheap, diagnosable no-op instead of a full run.
if (feature === 'unnamed-feature' || !request) {
  log(`parity-feature: ABORT missing args (typeof args=${typeof args})`)
  return {
    error: 'missing-args',
    argsType: typeof args,
    argsPreview: typeof args === 'string' ? args.slice(0, 300) : JSON.stringify(args ?? null).slice(0, 300),
  }
}

const CONTRACTS = 'docs/parity/contracts.md'
const SWIFT_CTX = 'Sources/Helmsman/CLAUDE.md'
const WEB_CTX = 'apps/CLAUDE.md'
const SPEC_PATH = `docs/parity/${feature}.md`

const SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'behavior', 'acceptance'],
  properties: {
    title: { type: 'string' },
    behavior: { type: 'string', description: 'Columns/fields, user actions, edge cases, EXACT kubectl commands' },
    contracts: { type: 'string', description: 'Shared-contract touchpoints (action-block kinds, MCP tools, catalog keys)' },
    acceptance: { type: 'array', items: { type: 'string' } },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['parity', 'issues'],
  properties: {
    parity: { type: 'boolean' },
    buildPassed: { type: 'boolean' },
    testsPassed: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } },
  },
}

log(`parity-feature: mode=${mode} feature=${feature}`)

// ---- Phase 1: Spec --------------------------------------------------------
phase('Spec')
let spec
if (mode === 'porter') {
  spec = await agent(
    `You are the SWIFT-DOMAIN EXTRACTOR. Read ${SWIFT_CTX} and ${CONTRACTS}. ` +
    `Then read the Swift implementation of "${feature}" under Sources/Helmsman/ (panels live in Sources/Helmsman/Panels/). ` +
    `Produce a normative behavior spec for porting it to web. Write the FULL spec to ${SPEC_PATH} (use git add -f if committing later), ` +
    `then return the structured summary. Record every column/field and its kubectl source, every user action and the exact ` +
    `kubectl command it runs, edge/empty/error states, and which resource kinds it watches. DO NOT write any application code. ` +
    `Request context: ${request}`,
    { label: `extract:${feature}`, phase: 'Spec', schema: SPEC_SCHEMA, agentType: 'Explore' },
  )
} else {
  spec = await agent(
    `You are the PARITY MANAGER. Read ${CONTRACTS}. Author a normative behavior spec for this NEW feature, to be implemented ` +
    `identically in both apps. Write the FULL spec to ${SPEC_PATH}, then return the structured summary. Define behavior, ` +
    `shared-contract touchpoints, and acceptance criteria. Request: ${request}`,
    { label: `spec:${feature}`, phase: 'Spec', schema: SPEC_SCHEMA },
  )
}

if (!spec) {
  log('Spec phase produced no spec — aborting.')
  return { mode, feature, error: 'no-spec' }
}

// ---- Phase 2: Implement ---------------------------------------------------
phase('Implement')
const specJson = JSON.stringify(spec)
let implementation
if (mode === 'porter') {
  const web = await agent(
    `You are the WEB BUILDER. Read ${WEB_CTX} and ${CONTRACTS}. Implement the feature specified in ${SPEC_PATH} in the web ` +
    `monorepo (apps/web panel under src/panels/, apps/server routes, shared logic in packages/k8s). Match the extracted behavior ` +
    `EXACTLY — same columns, actions, edge cases, and kubectl commands. Follow the web stack conventions. Spec summary: ${specJson}`,
    { label: `build-web:${feature}`, phase: 'Implement' },
  )
  implementation = { web }
} else {
  const [swiftImpl, webImpl] = await parallel([
    () => agent(
      `You are the SWIFT IMPLEMENTER. Read ${SWIFT_CTX} and ${CONTRACTS}. Implement ${SPEC_PATH} in Sources/Helmsman/ following ` +
      `existing panel/view-model patterns. Match the spec exactly. Spec summary: ${specJson}`,
      { label: `build-swift:${feature}`, phase: 'Implement' },
    ),
    () => agent(
      `You are the WEB IMPLEMENTER. Read ${WEB_CTX} and ${CONTRACTS}. Implement ${SPEC_PATH} in apps/ (+ packages/). ` +
      `Match the spec exactly. Spec summary: ${specJson}`,
      { label: `build-web:${feature}`, phase: 'Implement' },
    ),
  ])
  implementation = { swift: swiftImpl, web: webImpl }
}

// ---- Phase 3: Verify ------------------------------------------------------
phase('Verify')
const targets = mode === 'porter' ? ['web'] : ['web', 'swift']
const verdicts = (await parallel(targets.map((t) => () =>
  agent(
    t === 'web'
      ? `You are the WEB VERIFIER. Run, and ALL must pass: pnpm -r typecheck (whole workspace — server runs on Bun with no tsc gate, so server/catalog/k8s typecheck errors only show here), pnpm --filter web build, pnpm --filter web test, and pnpm --filter @helmsman/server test (+ pnpm --filter @helmsman/catalog test if that package changed). Then check the implementation against the acceptance criteria in ${SPEC_PATH}. ` +
        `Return the verdict (parity true ONLY if pnpm -r typecheck is clean AND build+tests pass AND acceptance criteria are met).`
      : `You are the SWIFT VERIFIER. Run: swift build && swift test. Then check against the acceptance criteria in ${SPEC_PATH}. ` +
        `Return the verdict (parity true only if build+tests pass AND acceptance criteria are met).`,
    { label: `verify:${t}`, phase: 'Verify', schema: VERDICT_SCHEMA },
  ).then((v) => (v ? { target: t, ...v } : { target: t, parity: false, issues: ['verifier returned null'] })),
))).filter(Boolean)

const allParity = verdicts.length > 0 && verdicts.every((v) => v.parity)
log(`parity-feature done: parity=${allParity}`)
return { mode, feature, specPath: SPEC_PATH, spec, implementation, verdicts, parity: allParity }
