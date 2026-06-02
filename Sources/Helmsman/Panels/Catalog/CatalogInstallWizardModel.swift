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

    /// Install descriptor parsed from the latest completed assistant turn (helm
    /// vs raw manifest). nil → manifest mode.
    var installDescriptor: InstallDescriptor? = nil
    /// Values the generated manifest leaves for the operator to fill — detected
    /// from `<FILL_ME_IN>` markers and empty Secret values (see PlaceholderScanner).
    var placeholders: [ManifestPlaceholder] = []
    /// Collected values keyed by placeholder key; each is pre-seeded with a
    /// generated strong value so the common "just confirm" path is one click.
    var secretValues: [String: String] = [:]

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
        step = .generating
        startGeneratingIfNeeded()
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
            // Best-effort extract the latest YAML block, secrets schema, and
            // install descriptor from the most recent assistant turn, so "Use
            // this manifest" is enabled exactly when we have one.
            if let last = transcript.last, last.role == .assistant {
                let parsed = WizardArtifacts.parse(last.text)
                if let yaml = parsed.yaml { manifestYAML = yaml }
                if let install = parsed.install { installDescriptor = install }
                detectPlaceholders()
            }
        case .toolUse, .systemInit, .thinkingDelta, .unknown:
            break
        }
    }

    /// Scan the generated manifest for values the operator must supply, seeding
    /// each with a generated strong default so the common "confirm the random
    /// passwords" path is one click — the user can still overwrite any of them.
    private func detectPlaceholders() {
        placeholders = PlaceholderScanner.scan(manifestYAML)
        for p in placeholders where secretValues[p.key] == nil {
            secretValues[p.key] = RandomSecret.generate(length: 32)
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
            var flags: [String] = []
            if nf.tainted   { flags.append("tainted") }
            if nf.cordoned  { flags.append("cordoned") }
            if !nf.node.isReady { flags.append("not-ready") }
            let suffix = flags.isEmpty ? "" : " — " + flags.joined(separator: ", ")
            return "- \(nf.node.metadata.name): \(cpu) CPU free / \(mem) memory free\(suffix)"
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

    /// True when the last assistant turn contains a YAML fence — drives the
    /// "Use this manifest" button's enabled state.
    var hasManifestReady: Bool {
        guard let last = transcript.last, last.role == .assistant else { return false }
        return Self.extractYAMLBlock(from: last.text) != nil
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
        detectPlaceholders()
        step = placeholders.isEmpty ? .review : .secrets
    }

    /// Every detected placeholder has a non-empty value. Each is pre-seeded with
    /// a generated value, so this only blocks if the user cleared one.
    var canAdvanceFromSecrets: Bool {
        placeholders.allSatisfy { !(secretValues[$0.key] ?? "").trimmingCharacters(in: .whitespaces).isEmpty }
    }

    func advanceFromSecrets() {
        guard canAdvanceFromSecrets else { return }
        step = .review
    }

    /// Regenerate one field's value (Secrets-step "Regenerate" button).
    func regenerateSecret(_ key: String) {
        guard placeholders.contains(where: { $0.key == key }) else { return }
        secretValues[key] = RandomSecret.generate(length: 32)
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

        // Substitute the collected values into the manifest's placeholders, then
        // hard-stop if any marker survived — never apply a half-blank Secret.
        let filled = PlaceholderScanner.substitute(manifestYAML, values: secretValues)
        if PlaceholderScanner.hasUnfilledMarkers(filled) {
            step = .failed("Some required values are still unfilled (\(PlaceholderScanner.marker)). Go back to the Secrets step and complete them.")
            return
        }

        // Install per descriptor (missing descriptor => manifest mode).
        switch installDescriptor?.mode ?? .manifest {
        case .manifest:
            let result = await WorkloadCommander(context: context).run(.applyManifest(yaml: filled, label: app.id))
            finishApply(ok: result.ok, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode)
        case .helm:
            guard let descriptor = installDescriptor else {
                step = .failed("helm install requested but no descriptor was produced")
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
    /// label. Advance to .done once all matched pods report Ready, or stop at
    /// the 90s timeout (still .verifying, with `verifyTimedOut = true` so the
    /// UI can offer a "give up / open in chat" affordance).
    private func startVerifyPoll() {
        verifyTask?.cancel()
        verifyTimedOut = false
        let deadline = Date().addingTimeInterval(90)
        let instanceLabel = instance
        let ns = namespace
        verifyTask = Task { [weak self] in
            while !Task.isCancelled {
                if Date() >= deadline {
                    await MainActor.run { self?.verifyTimedOut = true }
                    return
                }
                await MainActor.run {
                    guard let self else { return }
                    let matched = self.cache.pods.filter { p in
                        p.metadata.namespace == ns
                            && p.metadata.labels?["app.kubernetes.io/instance"] == instanceLabel
                    }
                    self.verifyingPods = matched
                    if !matched.isEmpty, matched.allSatisfy(Self.podIsReady) {
                        self.step = .done
                    }
                }
                if case .done = (await MainActor.run { self?.step }) ?? .configure { return }
                try? await Task.sleep(nanoseconds: 1_500_000_000)
            }
        }
    }

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
