import Foundation
import Observation

enum WizardStep: Hashable {
    case configure
    case generating
    case secrets
    case review
    case applying
    case verifying
    case done
    case failed(String)

    /// Position in the linear install pipeline, used to track how far the user
    /// has progressed and gate back/forward navigation. `.failed` collapses onto
    /// the apply step it most often follows but never advances the reachable range.
    var pipelineIndex: Int {
        switch self {
        case .configure:  return 0
        case .generating: return 1
        case .secrets:    return 2
        case .review:     return 3
        case .applying:   return 4
        case .failed:     return 4
        case .verifying:  return 5
        case .done:       return 6
        }
    }
}

struct WizardChatTurn: Identifiable, Hashable {
    enum Role { case user, assistant }
    let id = UUID()
    let role: Role
    var text: String
}

/// One declared manifest resource annotated with its live rollout state, shown
/// in the verify step's "what's being made" checklist.
struct VerifyResource: Identifiable {
    enum State: Equatable {
        case applied                       // created by kubectl apply; no readiness to track
        case creating                      // workload declared, no pods observed yet
        case starting(ready: Int, total: Int)
        case ready
        case failed(String)
    }
    let id = UUID()
    let kind: String
    let name: String
    let state: State

    var isWorkload: Bool {
        ["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob", "Pod"].contains(kind)
    }
}

/// Mutable state for one install wizard session. Lives only as long as the
/// wizard sheet is open; teardown happens in `MainWindow` when the user
/// closes the sheet.
@MainActor
@Observable
final class CatalogInstallWizardModel: Identifiable {
    let id = UUID()
    let app: CatalogApp
    let cache: ClusterCache
    let context: String?

    var step: WizardStep = .configure {
        didSet {
            // `.failed` is a side-state — don't let it inflate the reachable range.
            if case .failed = step { return }
            if step.pipelineIndex > farthestStepIndex { farthestStepIndex = step.pipelineIndex }
        }
    }

    /// Highest pipeline index reached, so the step indicator can let the user
    /// click back/forward to any step they've already visited — but no further.
    private(set) var farthestStepIndex = 0

    // Configure-step fields
    var instance: String
    var namespace: String = "default"
    var hostname: String
    var nodePin: String? = nil
    var storageGiB: Int
    var notes: String = ""

    /// cert-manager ClusterIssuer for this install's ingress. Seeded from the
    /// context's saved default; the Configure step lets the user pick a
    /// different one (from `discoveredIssuers`) or clear it (empty = no TLS).
    var clusterIssuer: String
    /// ClusterIssuers found on the cluster, populated by `loadClusterIssuers()`.
    /// Empty until the read-only probe returns (or if cert-manager isn't found).
    var discoveredIssuers: [String] = []
    @ObservationIgnored private var issuersLoaded = false

    // Manifest produced by Claude (or pasted by the user during the stub phase).
    var manifestYAML: String = ""

    /// Install mode owned authoritatively by the catalog (`app.install`), not
    /// inferred from the model's output. Absent ⇒ manifest.
    var mode: InstallDescriptor.Mode { app.install?.mode ?? .manifest }

    /// The catalog descriptor with the instance-specific `releaseName` injected
    /// (the Configure step's instance). nil when the app has no install
    /// descriptor (manifest apps). Used by both the Helm render preview and the
    /// Apply helm branch so the release name is consistent.
    var effectiveInstallDescriptor: InstallDescriptor? {
        guard let base = app.install else { return nil }
        return InstallDescriptor(
            mode: base.mode,
            repoName: base.repoName,
            repoURL: base.repoURL,
            chart: base.chart,
            version: base.version,
            releaseName: instance,
            manifest: base.manifest,
            values: base.values,
            secrets: base.secrets
        )
    }

    /// The account selected for this install, if any.
    var selectedRegistryAccount: RegistryAccount? {
        guard let id = selectedRegistryAccountID else { return nil }
        return registryAccountOptions.first { $0.id == id }
    }

    /// State of the local `helm template` preview render for Helm-mode apps.
    enum HelmRender: Equatable { case idle, rendering, rendered(String), failed(String) }
    var helmRender: HelmRender = .idle
    @ObservationIgnored private var renderTask: Task<Void, Never>?

    /// Unified resource summary the Generate/Review views read, independent of
    /// install mode: a parsed manifest for manifest apps, or the parsed
    /// `helm template` output once a Helm render has completed.
    var resourceSummary: ManifestSummary? {
        switch mode {
        case .manifest:
            return currentManifestYAML.flatMap(ManifestSummary.parse)
        case .helm:
            if case .rendered(let yaml) = helmRender { return ManifestSummary.parse(yaml) }
            return nil
        }
    }

    /// Render the Helm chart locally (`helm template`) into a multi-doc manifest
    /// for the resource preview. No-op outside Helm mode or without an effective
    /// descriptor + values. Preview degradation only — Apply runs the real helm.
    func renderHelmPreview() async {
        guard mode == .helm,
              let descriptor = effectiveInstallDescriptor,
              let values = currentManifestYAML,
              !values.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        helmRender = .rendering
        let result = await HelmCommander(context: context).template(
            descriptor: descriptor, valuesYAML: values, namespace: namespace
        )
        if Task.isCancelled { return }
        if result.ok {
            helmRender = .rendered(result.stdout)
        } else {
            helmRender = .failed(result.stderr.isEmpty ? "helm exited \(result.exitCode)" : result.stderr)
        }
    }

    /// Cancel any in-flight render and (re)start one. Phase 2 wires the call
    /// sites + debounce; Phase 1 exposes the trigger.
    func triggerHelmRender() {
        renderTask?.cancel()
        renderTask = Task { [weak self] in
            await self?.renderHelmPreview()
        }
    }

    /// Values the generated manifest leaves for the operator to fill — detected
    /// from `<FILL_ME_IN>` markers and empty Secret values (see PlaceholderScanner).
    var placeholders: [ManifestPlaceholder] = []
    /// Authoritative typed secret schema when present: the catalog entry's baked
    /// `install.secrets`, or a Claude-emitted ```secrets block. Drives the field
    /// list, labels, random-vs-user behaviour, and `required` gating — replacing
    /// the brittle YAML scrape. Empty ⇒ fall back to `PlaceholderScanner`.
    var secretSpecs: [SecretFieldSpec] = []
    /// Collected values keyed by placeholder key; each is pre-seeded with a
    /// generated strong value so the common "just confirm" path is one click.
    var secretValues: [String: String] = [:]

    /// Registry accounts available in this context (for the "Pull credentials"
    /// control), read live from the store so it never goes stale. Empty when none.
    var registryAccountOptions: [RegistryAccount] {
        SessionStore.shared.registryAccounts(for: context ?? "")
    }
    /// The account whose pull secret will be ensured in the target namespace before
    /// apply. nil = none (no authenticated pulls). Defaults to the context default.
    var selectedRegistryAccountID: UUID? = nil

    /// The declared spec for a secret key, when a typed schema is in force.
    func secretSpec(_ key: String) -> SecretFieldSpec? {
        secretSpecs.first { $0.key == key }
    }

    // Live kubectl stdout from the Applying step.
    var applyLog: String = ""

    // Snapshot of pods matched during the Verifying step. Refreshed every
    // poll tick from `cache.pods`.
    var verifyingPods: [Pod] = []
    var verifyTimedOut: Bool = false
    private var verifyTask: Task<Void, Never>?

    // Generating/Failed/Verifying transcript with Claude. The wizard owns one
    // long-lived ClaudeSession across step re-entries (Generating ↔ Failed ↔
    // Verifying), so follow-up turns share context with the original prompt.
    var transcript: [WizardChatTurn] = []
    var isStreaming: Bool = false
    var generateError: String? = nil

    private var session: ClaudeSession?
    private var pumpTask: Task<Void, Never>?

    /// Fit snapshot taken at wizard launch. Used to pre-select the recommended
    /// node and populate the node-pin dropdown.
    let fit: FitResult

    init(app: CatalogApp, fit: FitResult, cache: ClusterCache, context: String?, initialNodePin: String? = nil) {
        self.app = app
        self.fit = fit
        self.cache = cache
        self.context = context
        self.instance = app.id
        let defaults = SessionStore.shared.selfHostDefaults(for: context ?? "")
        self.hostname = (app.exposesIngress && !defaults.ingressDomain.isEmpty) ? "\(app.id).\(defaults.ingressDomain)" : ""
        self.clusterIssuer = defaults.clusterIssuer
        self.storageGiB = app.requirements.storageGiB ?? 0
        // Seed the node pin from the detail sheet's selection (nil = "Any").
        self.nodePin = initialNodePin
        self.selectedRegistryAccountID = registryAccountOptions.first { $0.isDefault }?.id
    }

    var recommendedNodeName: String? {
        fit.recommended?.node.metadata.name
    }

    /// Placeholder for the ingress-hostname field: `<instance>.<domain>` using
    /// the context's configured ingress domain, or a neutral example when none
    /// is set up yet.
    var hostnamePlaceholder: String {
        let domain = SessionStore.shared.selfHostDefaults(for: context ?? "").ingressDomain
        return "\(app.id).\(domain.isEmpty ? "example.com" : domain)"
    }

    /// Issuer names to show in the Configure-step dropdown: the discovered
    /// ClusterIssuers, plus the seeded default if it isn't among them (e.g. the
    /// probe hasn't returned yet, or cert-manager is reachable only at apply
    /// time) so the current selection is always representable.
    var issuerOptions: [String] {
        var opts = discoveredIssuers
        let current = clusterIssuer.trimmingCharacters(in: .whitespaces)
        if !current.isEmpty && !opts.contains(current) { opts.insert(current, at: 0) }
        return opts
    }

    /// Probe the cluster for ClusterIssuers (read-only) to populate the dropdown.
    /// Best-effort: a missing CRD / kubectl just leaves `discoveredIssuers`
    /// empty, and the Configure step falls back to a free-text field.
    func loadClusterIssuers() async {
        guard !issuersLoaded else { return }
        issuersLoaded = true
        guard let names = try? await ClusterIssuerLoader.load(context: context) else { return }
        discoveredIssuers = names
        // If we're still sitting on the built-in placeholder and it isn't a real
        // issuer on this cluster, prefer the cluster's first actual issuer rather
        // than seeding a name that doesn't exist. A deliberately-saved issuer is
        // left alone.
        let current = clusterIssuer.trimmingCharacters(in: .whitespaces)
        if !names.isEmpty, !names.contains(current),
           current == SelfHostDefaults.default.clusterIssuer {
            clusterIssuer = names.first!
        }
    }

    /// Namespace names for the Configure-step dropdown — the cluster's
    /// namespaces, plus the current selection if the watch hasn't surfaced it
    /// yet, so the picker can always represent the chosen value. Sorted.
    var namespaceOptions: [String] {
        var opts = cache.namespaces.map(\.metadata.name)
            .sorted { $0.localizedStandardCompare($1) == .orderedAscending }
        let current = namespace.trimmingCharacters(in: .whitespaces)
        if !current.isEmpty && !opts.contains(current) { opts.insert(current, at: 0) }
        return opts
    }

    /// Names of nodes the app can actually land on. Same set the node-pin
    /// dropdown surfaces; "Any" is always available alongside.
    var fittingNodeNames: [String] {
        fit.perNode
            .filter { $0.eligible }
            .map { $0.node.metadata.name }
    }

    /// Required fields satisfied before we let Configure advance.
    var canAdvanceFromConfigure: Bool {
        if instance.trimmingCharacters(in: .whitespaces).isEmpty { return false }
        if namespace.trimmingCharacters(in: .whitespaces).isEmpty { return false }
        if app.exposesIngress && hostname.trimmingCharacters(in: .whitespaces).isEmpty { return false }
        if app.persistence && storageGiB <= 0 { return false }
        return true
    }

    func advanceFromConfigure() {
        guard canAdvanceFromConfigure else { return }
        rememberChosenIssuer()
        if app.isBaked {
            startBakedInstall()
        } else {
            step = .generating
            startGeneratingIfNeeded()
        }
    }

    /// Deterministic path for baked catalog entries: render the parameterized
    /// artifact with the configure-step values, adopt the declared secret schema,
    /// and jump straight to Secrets (or Review when there are none). No Claude
    /// session is started — the artifact was researched + verified at add-time.
    private func startBakedInstall() {
        manifestYAML = app.renderInstallArtifact(vars: templateVars) ?? ""
        applySecretSchema(app.install?.secrets ?? [])
        step = placeholders.isEmpty ? .review : .secrets
    }

    /// Persist the issuer picked for this install as the context's default, so
    /// the next install pre-selects it. Only touches the clusterIssuer field of
    /// the saved defaults.
    private func rememberChosenIssuer() {
        guard app.exposesIngress else { return }
        let chosen = clusterIssuer.trimmingCharacters(in: .whitespaces)
        var defaults = SessionStore.shared.selfHostDefaults(for: context ?? "")
        guard defaults.clusterIssuer != chosen else { return }
        defaults.clusterIssuer = chosen
        SessionStore.shared.setSelfHostDefaults(defaults, for: context ?? "")
    }

    /// Lazily spawn the wizard's `ClaudeSession` and send the initial install
    /// prompt. Subsequent re-entries (e.g. Failed → Generating retry) reuse
    /// the same session so multi-turn context is preserved.
    private func startGeneratingIfNeeded() {
        guard session == nil else { return }
        do {
            let s = try ClaudeSession(clusterContext: context, config: SessionStore.shared.modelConfig)
            self.session = s
            startPump(session: s)
            sendInitialPrompt()
        } catch {
            generateError = "Couldn't start Claude session: \(error)"
            step = .failed(generateError ?? "Couldn't start Claude session")
        }
    }

    private func startPump(session: ClaudeSession) {
        pumpTask = Task { [weak self] in
            let stream = await session.start()
            for await event in stream {
                guard let self else { break }
                self.handle(event)
            }
        }
    }

    private func handle(_ event: ClaudeEvent) {
        switch event {
        case .textDelta(let chunk):
            guard !chunk.isEmpty else { break }
            if let last = transcript.indices.last, transcript[last].role == .assistant {
                transcript[last].text += chunk
            } else {
                transcript.append(WizardChatTurn(role: .assistant, text: chunk))
            }
        case .result:
            isStreaming = false
            // Best-effort extract the latest YAML block and secrets schema from
            // the most recent assistant turn, so "Use this manifest" is enabled
            // exactly when we have one. Install mode is owned by the catalog
            // (`app.install`), not derived from the model's output.
            if let last = transcript.last, last.role == .assistant {
                let parsed = WizardArtifacts.parse(last.text)
                if let yaml = parsed.yaml { manifestYAML = yaml }
                // Prefer the typed ```secrets schema when Claude emitted one — it's
                // authoritative. Only fall back to scraping the YAML (which can
                // mistake a comment or a literal `value:` line for a field) when no
                // schema is present.
                if !parsed.secrets.isEmpty {
                    applySecretSchema(parsed.secrets)
                } else {
                    detectPlaceholders()
                }
            }
        case .usageLimit:
            // Usage limit ends this turn; the interactive chat surfaces the badge.
            isStreaming = false
        case .toolUse, .systemInit, .thinkingDelta, .unknown:
            break
        }
    }

    /// Scan the generated manifest for values the operator must supply, seeding
    /// each with a generated strong default so the common "confirm the random
    /// passwords" path is one click — the user can still overwrite any of them.
    private func detectPlaceholders() {
        secretSpecs = []
        placeholders = PlaceholderScanner.scan(manifestYAML)
        for p in placeholders where secretValues[p.key] == nil {
            secretValues[p.key] = RandomSecret.generate(length: 32)
        }
    }

    /// Adopt a typed secret schema as the authoritative field list. `random`
    /// fields are pre-seeded with a strong value (the common "just confirm"
    /// path); `user` fields start blank so they gate Continue. The manifest's
    /// Secret keeps a `<FILL_ME_IN>` marker per key, which `runApply` substitutes
    /// by key — so the field list never depends on scraping the YAML.
    private func applySecretSchema(_ specs: [SecretFieldSpec]) {
        secretSpecs = specs
        placeholders = specs.map { ManifestPlaceholder(key: $0.key) }
        for s in specs {
            switch s.kind {
            case .random:
                if (secretValues[s.key] ?? "").isEmpty {
                    secretValues[s.key] = RandomSecret.generate(length: s.length ?? 32, format: s.format)
                }
            case .user:
                if secretValues[s.key] == nil { secretValues[s.key] = "" }
            }
        }
    }

    private func sendInitialPrompt() {
        let prompt = buildInstallPrompt()
        transcript.append(WizardChatTurn(role: .user, text: "(install prompt sent to Claude)"))
        isStreaming = true
        Task { [session] in
            do {
                try await session?.send(prompt)
            } catch {
                await MainActor.run {
                    self.isStreaming = false
                    self.generateError = "Couldn't send prompt: \(error)"
                }
            }
        }
    }

    /// Compose the full prompt sent to Claude: cluster context preamble +
    /// rendered `installPromptTemplate` + node fit snapshot. Kept here so the
    /// wizard owns the assembly; the catalog JSON only owns the per-app body.
    private func buildInstallPrompt() -> String {
        let defaults = SessionStore.shared.selfHostDefaults(for: context ?? "")
        var lines: [String] = []
        lines.append("- Ingress class: traefik (already installed in kube-system).")

        let issuer = clusterIssuer.trimmingCharacters(in: .whitespaces)
        if issuer.isEmpty {
            lines.append("- TLS: cert-manager is available, but no ClusterIssuer is configured — OMIT the `cert-manager.io/cluster-issuer` annotation and ignore any cluster-issuer reference in the per-app instructions below.")
        } else {
            lines.append("- TLS: cert-manager with ClusterIssuer `\(issuer)`, HTTP-01 only — port 80 must work for issuance.")
        }

        if defaults.redirectMiddleware.isEmpty {
            lines.append("- HTTPS redirect: no redirect Middleware configured — do NOT set the `traefik.ingress.kubernetes.io/router.middlewares` annotation, and ignore any middleware reference in the per-app instructions below.")
        } else {
            lines.append("- HTTPS redirect: reference Middleware `\(defaults.redirectMiddleware)` in the `traefik.ingress.kubernetes.io/router.middlewares` annotation.")
        }

        if defaults.imagePullSecret.isEmpty {
            lines.append("- Image pull secret: none configured — do NOT add `imagePullSecrets` to pod specs, and ignore any imagePullSecrets reference in the per-app instructions below.")
        } else {
            lines.append("- Image pull secret: `\(defaults.imagePullSecret)` in `default` namespace. Reference as `imagePullSecrets: [{name: \(defaults.imagePullSecret)}]` on every pod spec.")
        }

        if !defaults.edgeIP.isEmpty {
            let dnsNote = defaults.ingressDomain.isEmpty
                ? ""
                : " App ingresses point at this via DNS A records under `*.\(defaults.ingressDomain)`."
            lines.append("- Edge IP: `\(defaults.edgeIP)`.\(dnsNote)")
        }

        lines.append("- Active context: \(context ?? "(none)") — pass `--context \(context ?? "")` to any kubectl probes you run.")

        // Secrets are left as `<FILL_ME_IN>` placeholders by the per-app
        // templates; the wizard's Secrets step collects and substitutes them
        // before apply (see PlaceholderScanner). We deliberately do NOT add a
        // competing "emit a secrets schema / don't inline secrets" instruction
        // here — that conflicted with the templates' single-yaml output and made
        // the model emit blank-valued secrets.
        let preamble = """
        # Cluster context
        \(lines.joined(separator: "\n"))

        # Node snapshot
        \(nodeSnapshot())

        """
        return preamble + "\n" + app.renderPrompt(vars: templateVars)
    }

    private func nodeSnapshot() -> String {
        let lines = fit.perNode.map { nf -> String in
            let cpu = ResourceQuantity.formatCores(nf.freeCPU)
            let mem = ResourceQuantity.formatBytes(nf.freeMemoryBytes)
            let disk = nf.allocatableDiskBytes > 0 ? " / \(ResourceQuantity.formatBytes(nf.freeDiskBytes)) disk free" : ""
            var flags: [String] = []
            if nf.tainted   { flags.append("tainted") }
            if nf.cordoned  { flags.append("cordoned") }
            if !nf.node.isReady { flags.append("not-ready") }
            let suffix = flags.isEmpty ? "" : " — " + flags.joined(separator: ", ")
            return "- \(nf.node.metadata.name): \(cpu) CPU free / \(mem) memory free\(disk)\(suffix)"
        }
        return lines.joined(separator: "\n")
    }

    /// Pull the first fenced ```yaml block out of an assistant message. Falls
    /// back to the largest unfenced span if no fence is present.
    static func extractYAMLBlock(from text: String) -> String? {
        if let range = text.range(of: "```yaml") {
            let after = text[range.upperBound...]
            if let endRange = after.range(of: "```") {
                let body = after[after.index(after.startIndex, offsetBy: 0)..<endRange.lowerBound]
                let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? nil : trimmed
            }
        }
        // No yaml-tagged fence: try a generic ``` fence.
        if let openRange = text.range(of: "```") {
            let after = text[openRange.upperBound...]
            // Skip any language tag on the same line.
            let body: Substring
            if let newline = after.firstIndex(of: "\n") {
                body = after[after.index(after: newline)...]
            } else {
                body = after
            }
            if let endRange = body.range(of: "```") {
                let inner = body[body.startIndex..<endRange.lowerBound]
                let trimmed = inner.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? nil : trimmed
            }
        }
        return nil
    }

    /// True when there's a manifest to advance with — drives the "Use this
    /// manifest" button. Mirrors `currentManifestYAML` so the button and the
    /// visual preview agree: once a manifest is captured it stays available,
    /// even if later chit-chat turns carry no YAML fence.
    var hasManifestReady: Bool {
        currentManifestYAML?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    }

    /// Best current manifest to visualize on the generate step: the extracted
    /// `manifestYAML` once a turn has completed, else the latest closed YAML
    /// fence in the running assistant transcript. nil while Claude is still
    /// writing the first block.
    var currentManifestYAML: String? {
        let trimmed = manifestYAML.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return manifestYAML }
        guard let last = transcript.last, last.role == .assistant else { return nil }
        return Self.extractYAMLBlock(from: last.text)
    }

    /// Append a user follow-up turn and forward it to the session. No-op when
    /// the session isn't running (e.g. wizard already torn down).
    func sendFollowup(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let session else { return }
        transcript.append(WizardChatTurn(role: .user, text: trimmed))
        isStreaming = true
        Task { [session] in
            do {
                try await session.send(trimmed)
            } catch {
                await MainActor.run {
                    self.isStreaming = false
                    self.generateError = "Couldn't send: \(error)"
                }
            }
        }
    }

    /// Tear down the wizard's Claude session + any in-flight verify poll.
    /// Call when the user closes the wizard sheet or hits Cancel — leaves no
    /// orphan subprocess.
    func teardownSession() {
        pumpTask?.cancel()
        pumpTask = nil
        verifyTask?.cancel()
        verifyTask = nil
        let s = session
        session = nil
        Task { await s?.terminate() }
    }

    /// Advance from Generating with whatever YAML the latest assistant turn
    /// produced (or the user pasted into manifestYAML during the stub phase).
    func useManifest() {
        if manifestYAML.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           let last = transcript.last, last.role == .assistant,
           let extracted = Self.extractYAMLBlock(from: last.text) {
            manifestYAML = extracted
        }
        guard !manifestYAML.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        // Keep a typed schema if `handle(.result)` already adopted one; only scrape
        // when Claude emitted no ```secrets block.
        if secretSpecs.isEmpty { detectPlaceholders() }
        step = placeholders.isEmpty ? .review : .secrets
    }

    /// Continue is allowed once every *required* field has a value. With a typed
    /// schema, only `required` specs gate (a `random` field is always pre-seeded;
    /// a `user` field gates until typed). Without a schema, every scraped
    /// placeholder must be non-empty (all are pre-seeded, so this only blocks if
    /// the user cleared one).
    var canAdvanceFromSecrets: Bool {
        if !secretSpecs.isEmpty {
            return secretSpecs.allSatisfy { spec in
                !spec.required || !(secretValues[spec.key] ?? "").trimmingCharacters(in: .whitespaces).isEmpty
            }
        }
        return placeholders.allSatisfy { !(secretValues[$0.key] ?? "").trimmingCharacters(in: .whitespaces).isEmpty }
    }

    /// Keys whose value the operator still hasn't supplied: scan the *filled*
    /// manifest, so surviving `<FILL_ME_IN>` markers and empty Secret values both
    /// surface. Drives the "what's left to fill" apply error so it names fields.
    var unfilledPlaceholderKeys: [String] {
        let filled = PlaceholderScanner.substitute(manifestYAML, values: secretValues)
        return PlaceholderScanner.scan(filled).map(\.key)
    }

    /// Mask shown in the Review preview for a secret the operator has filled in.
    static let secretMask = "••••••••"

    /// The manifest as shown in the Review step: placeholders the operator has
    /// filled are masked (so they read as "set" without exposing the secret),
    /// while still-unfilled ones keep their `<FILL_ME_IN>` marker so they stand
    /// out. Display-only — apply substitutes the real `secretValues`.
    var maskedManifestYAML: String {
        let masked = secretValues.compactMapValues {
            $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : Self.secretMask
        }
        return PlaceholderScanner.substitute(manifestYAML, values: masked)
    }

    func advanceFromSecrets() {
        guard canAdvanceFromSecrets else { return }
        step = .review
    }

    /// Regenerate one field's value (Secrets-step "Regenerate" button). Honours
    /// the declared length when a schema is in force.
    func regenerateSecret(_ key: String) {
        guard placeholders.contains(where: { $0.key == key }) else { return }
        let spec = secretSpec(key)
        secretValues[key] = RandomSecret.generate(length: spec?.length ?? 32, format: spec?.format ?? .alphanumeric)
    }

    /// Where the Review step's back button lands: for a baked app, the Secrets
    /// step (or Configure when there are none); otherwise back to the Claude
    /// generate step.
    var backStepFromReview: WizardStep {
        guard app.isBaked else { return .generating }
        return placeholders.isEmpty ? .configure : .secrets
    }

    func advanceFromReview() {
        guard !manifestYAML.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        step = .applying
        Task { await runApply() }
    }

    /// Run `kubectl apply -f -` with the current manifest. Drives transitions
    /// to .verifying (success) or .failed (non-zero exit / process error).
    @MainActor
    private func runApply() async {
        applyLog = ""

        // Ensure registry auth in the target namespace BEFORE applying, so image
        // pulls are authenticated (covers app + bundled Postgres/Redis). No-op when
        // no account is selected. The reconciler never logs the secret payload.
        if let account = selectedRegistryAccount {
            let outcome = await RegistryAccountReconciler(context: context).ensureAccess(account: account, namespace: namespace)
            if case let .failed(msg) = outcome {
                step = .failed("Couldn't set up registry credentials in \(namespace): \(msg)")
                return
            }
        }

        // Substitute the collected values into the manifest's placeholders, then
        // hard-stop if any marker survived — never apply a half-blank Secret.
        let filled = PlaceholderScanner.substitute(manifestYAML, values: secretValues)
        if PlaceholderScanner.hasUnfilledMarkers(filled) {
            let missing = unfilledPlaceholderKeys
            let detail = missing.isEmpty ? "" : ": \(missing.joined(separator: ", "))"
            step = .failed("These required values are still unfilled\(detail). Go back to the Secrets step and complete them.")
            return
        }

        // Install per the CATALOG's authoritative mode (absent => manifest).
        switch app.install?.mode ?? .manifest {
        case .manifest:
            // Belt-and-suspenders: never hand non-manifest YAML to kubectl apply.
            if let reason = ManifestShape.validationError(filled) {
                step = .failed("This doesn't look like a Kubernetes manifest — \(reason). The generated YAML may be Helm values or incomplete. Regenerate, or check the app's install mode.")
                return
            }
            let result = await WorkloadCommander(context: context).run(.applyManifest(yaml: filled, label: app.id))
            finishApply(ok: result.ok, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode)
        case .helm:
            guard let descriptor = effectiveInstallDescriptor else {
                step = .failed("helm install requested but the catalog entry has no install descriptor")
                return
            }
            let result = await HelmCommander(context: context).install(
                descriptor: descriptor, valuesYAML: filled, namespace: namespace
            )
            finishApply(ok: result.ok, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode)
        }
    }

    private func finishApply(ok: Bool, stdout: String, stderr: String, exitCode: Int32) {
        if ok {
            applyLog += (applyLog.isEmpty ? "" : "\n") + stdout
            step = .verifying
            startVerifyPoll()
        } else {
            step = .failed(stderr.isEmpty ? "install exited \(exitCode)" : stderr)
        }
    }

    /// Poll `cache.pods` for pods matching this install's namespace + instance
    /// label. Advance to .done once all matched pods report Ready.
    ///
    /// Timeout is two-stage so a slow first-time image pull (heavyweight apps
    /// pulling multi-hundred-MB images, Postgres + app + a migration Job) isn't
    /// reported as a failure while it's legitimately still coming up: at the
    /// *soft* deadline we set `verifyTimedOut = true` to surface the "taking a
    /// while / open in chat" affordance but KEEP watching, so it still flips to
    /// .done when the pods finally report Ready. Only the *hard* deadline stops
    /// the poll entirely, to avoid watching a truly stuck install forever.
    private func startVerifyPoll() {
        verifyTask?.cancel()
        verifyTimedOut = false
        let softDeadline = Date().addingTimeInterval(Self.verifySoftTimeout)
        let hardDeadline = Date().addingTimeInterval(Self.verifyHardTimeout)
        let instanceLabel = instance
        let ns = namespace
        verifyTask = Task { [weak self] in
            while !Task.isCancelled {
                if Date() >= hardDeadline { return }
                let timedOut = Date() >= softDeadline
                let tick: VerifyTick? = await MainActor.run {
                    guard let self else { return nil }
                    if timedOut { self.verifyTimedOut = true }
                    let matched = self.cache.pods.filter { p in
                        p.metadata.namespace == ns
                            && p.metadata.labels?["app.kubernetes.io/instance"] == instanceLabel
                    }
                    self.verifyingPods = matched
                    if !matched.isEmpty, matched.allSatisfy(Self.podIsReady) {
                        self.step = .done
                        return .done
                    }
                    // Trouble → hand the unfinished install to the main-chat Helmsman, once.
                    // Fire on a clear crashloop (restarts ≥ 3) or once the soft deadline passes
                    // without all pods Ready — early transient restarts don't trip it.
                    let crashing = matched.contains { p in
                        (p.status?.containerStatuses ?? []).contains { $0.restartCount >= 3 }
                    }
                    if !self.didFinishHandoff, self.onFinishHandoff != nil, crashing || timedOut {
                        self.didFinishHandoff = true
                        let h = self.buildFinishHandoff()
                        self.onFinishHandoff?(h.prompt, h.breadcrumb)
                        return .handedOff
                    }
                    return .watching
                }
                if tick == nil || tick == .done || tick == .handedOff { return }
                try? await Task.sleep(nanoseconds: 1_500_000_000)
            }
        }
    }

    private enum VerifyTick { case done, handedOff, watching }

    /// Set by the view: hand the unfinished install to the main chat as
    /// `(prompt, breadcrumb)`. Invoked automatically from the verify poll on trouble.
    var onFinishHandoff: ((String, String) -> Void)? = nil
    private var didFinishHandoff = false

    /// The resources this install owns — used to scope the Helmsman's auto-fixes.
    var installScope: InstallScope { InstallScope(namespace: namespace, instance: instance) }

    /// Snapshot the install's live state into a main-chat handoff (prompt + breadcrumb).
    func buildFinishHandoff() -> (prompt: String, breadcrumb: String) {
        let pods = cache.pods
            .filter { $0.metadata.namespace == namespace
                && $0.metadata.labels?["app.kubernetes.io/instance"] == instance }
            .map { p in
                InstallPodState(
                    name: p.metadata.name,
                    phase: p.status?.phase ?? "Unknown",
                    ready: Self.podIsReady(p),
                    restarts: (p.status?.containerStatuses ?? []).map(\.restartCount).max() ?? 0,
                    reason: p.errorReason
                )
            }
        let events = installEvents.suffix(15).map { e in
            "[\(e.type ?? "Normal")] \(e.reason ?? ""): \(e.message ?? "")"
        }
        return InstallFinishPrompt.build(
            appName: app.name, scope: installScope, hostname: hostname,
            exposesIngress: app.exposesIngress, manifestYAML: manifestYAML,
            pods: pods, events: Array(events), failingLogs: [], notes: notes
        )
    }

    /// After this long the verify step surfaces a "taking a while" affordance
    /// but keeps watching (slow image pulls are normal for big apps).
    static let verifySoftTimeout: TimeInterval = 300
    /// After this long we stop polling entirely — a genuinely stuck install.
    private static let verifyHardTimeout: TimeInterval = 900

    private static func podIsReady(_ pod: Pod) -> Bool {
        let statuses = pod.status?.containerStatuses ?? []
        guard !statuses.isEmpty else { return false }
        return statuses.allSatisfy { $0.ready }
    }

    /// Declared resources from the applied manifest, annotated with live state.
    /// Workloads reflect pod readiness; everything else reads as `applied`,
    /// since `kubectl apply` already created it before we entered verify.
    var verifyResources: [VerifyResource] {
        guard let summary = ManifestSummary.parse(manifestYAML) else { return [] }
        var rows: [VerifyResource] = []
        for w in summary.workloads {
            rows.append(VerifyResource(kind: w.kind, name: w.name, state: workloadState(name: w.name)))
        }
        for s in summary.services  { rows.append(VerifyResource(kind: "Service", name: s.name, state: .applied)) }
        for i in summary.ingresses { rows.append(VerifyResource(kind: "Ingress", name: i.name, state: .applied)) }
        for v in summary.volumes   { rows.append(VerifyResource(kind: "PVC", name: v.name, state: .applied)) }
        for c in summary.configs   { rows.append(VerifyResource(kind: c.kind, name: c.name, state: .applied)) }
        for o in summary.others    { rows.append(VerifyResource(kind: o.kind, name: o.name, state: .applied)) }
        return rows
    }

    /// Pods for one workload, matched by the deployment/statefulset name prefix
    /// against the instance-labelled pods we're already polling.
    func pods(forWorkload name: String) -> [Pod] {
        verifyingPods.filter { $0.metadata.name.hasPrefix(name) }
    }

    private func workloadState(name: String) -> VerifyResource.State {
        let pods = pods(forWorkload: name)
        guard !pods.isEmpty else { return .creating }
        if let errored = pods.first(where: { $0.errorReason != nil }) {
            return .failed(errored.errorReason ?? "error")
        }
        let total = pods.count
        let ready = pods.filter(Self.podIsReady).count
        return ready == total ? .ready : .starting(ready: ready, total: total)
    }

    /// Cluster events scoped to this install — by namespace and object-name
    /// prefix — ordered oldest→newest so they read as a process timeline.
    var installEvents: [K8sEvent] {
        cache.events
            .filter { $0.involvedObject?.namespace == namespace }
            .filter { ($0.involvedObject?.name ?? "").hasPrefix(instance) }
            .sorted { ($0.when ?? .distantPast) < ($1.when ?? .distantPast) }
    }

    /// Auto-followup for the "Retry generate" button on Failed. Tells Claude
    /// what kubectl said so the next manifest avoids the same mistake.
    func retryGenerate(withError stderr: String) {
        step = .generating
        let prompt = """
        The previous manifest failed to apply. kubectl said:

        ```
        \(stderr.prefix(2000))
        ```

        Please diagnose what went wrong and reply with a corrected ```yaml block. Keep the same cluster conventions.
        """
        sendFollowup(prompt)
    }

    /// Compose a hand-off prompt that lets the main chat pick up where the
    /// wizard left off. Used by Failed step's "Hand off to main chat".
    func handoffPromptForMainChat(reason: String) -> String {
        let last = transcript.last?.text ?? "(no Claude transcript yet)"
        return """
        I was trying to install **\(app.name)** (\(app.id)) onto the cluster via the catalog wizard. It failed:

        ```
        \(reason.prefix(800))
        ```

        Configuration:
        - instance: \(instance)
        - namespace: \(namespace)
        - hostname: \(hostname)
        - node pin: \(nodePin ?? "any")
        - notes: \(notes.isEmpty ? "(none)" : notes)

        Last manifest produced by the wizard:

        ```yaml
        \(manifestYAML)
        ```

        Last Claude turn from the wizard transcript:

        \(last)

        Help me get this app installed.
        """
    }

    /// Vars rendered into `CatalogApp.installPromptTemplate`. Used by the
    /// Generating step in Task 7.
    var templateVars: [String: String] {
        let defaults = SessionStore.shared.selfHostDefaults(for: context ?? "")
        return [
            "instance":       instance,
            "namespace":      namespace,
            "hostname":       hostname,
            "nodeName":       nodePin ?? "",
            "storage":        "\(storageGiB)",
            "notes":          notes.isEmpty ? "(none)" : notes,
            // Per-cluster conventions (see SelfHostDefaults). The preamble in
            // buildInstallPrompt() is authoritative and handles the empty cases.
            // clusterIssuer is the per-install selection, not the raw default.
            "clusterIssuer":  clusterIssuer.trimmingCharacters(in: .whitespaces),
            "imagePullSecret": defaults.imagePullSecret,
            "redirectMiddleware": defaults.redirectMiddleware,
        ]
    }
}
