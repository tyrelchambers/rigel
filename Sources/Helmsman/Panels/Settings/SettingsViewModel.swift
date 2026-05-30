import Foundation
import Observation

/// Backs the Settings → Signal notifications page. Owns the deploy + phone-link
/// flow; delegates the notification config (API URL / number / recipients) to
/// the app's AssistantViewModel so the assistant-config ConfigMap is written in
/// exactly one place.
@MainActor
@Observable
final class SettingsViewModel {
    let cache: ClusterCache
    private let assistant: AssistantViewModel
    private var context: String?

    /// Fixed local port for the link port-forward. 18099 avoids the common 8080
    /// collision; a live failure ("address already in use") is surfaced to retry.
    private static let linkLocalPort = 18099

    var working = false
    var actionError: String?

    // Link flow state (nil unless a link session is active).
    var qrPNG: Data?
    var linking = false
    @ObservationIgnored private var session: PortForwardSession?
    @ObservationIgnored private var linkTask: Task<Void, Never>?

    init(cache: ClusterCache, assistant: AssistantViewModel) {
        self.cache = cache
        self.assistant = assistant
    }

    func load(context: String?) {
        self.context = context
        assistant.load(context: context)
    }

    // MARK: - Derived state

    /// Where the bridge is (or should be) deployed: the agent's namespace if the
    /// agent is installed, else `default`.
    var targetNamespace: String { assistant.installedNamespace ?? "default" }

    /// Tracks an in-flight deploy so `status` can show `.deploying`.
    @ObservationIgnored private var statusApplying = false

    var status: SignalBridgeStatus {
        SignalBridgeStatus.derive(
            deployments: cache.deployments, namespace: targetNamespace,
            hasSavedNumber: !assistant.signalNumber.isEmpty, applying: statusApplying)
    }

    // Config passthrough (single source of truth = assistant-config).
    var signalApiUrl: String { assistant.signalApiUrl }
    var signalNumber: String { assistant.signalNumber }
    var signalRecipients: String { assistant.signalRecipients }

    // MARK: - Deploy

    func deploy() async {
        working = true; statusApplying = true; actionError = nil
        defer { working = false; statusApplying = false }
        let ns = targetNamespace
        if let err = await assistant.applyManifest(SignalBridgeManifests.manifest(namespace: ns)) {
            actionError = "Deploy failed: \(err)"
            return
        }
        // Point the agent at the freshly-deployed bridge (FQDN resolves anywhere).
        await assistant.setSignal(apiUrl: SignalBridgeManifests.apiURL(namespace: ns),
                                  number: assistant.signalNumber,
                                  recipients: assistant.signalRecipients)
    }

    // MARK: - Link phone

    func startLinking() {
        guard !linking else { return }
        linking = true; qrPNG = nil; actionError = nil
        let ns = targetNamespace
        let ctx = context
        linkTask = Task { [weak self] in
            guard let self else { return }
            do {
                let session = try PortForwardSession(
                    targetKind: "svc", targetName: SignalBridgeManifests.serviceName,
                    namespace: ns, localPort: Self.linkLocalPort,
                    remotePort: SignalBridgeManifests.port, context: ctx)
                self.session = session
                for await event in session.stream() {
                    switch event {
                    case .ready:
                        await self.onPortForwardReady()
                    case .failed(let stderr):
                        self.failLink("Port-forward failed: \(stderr)")
                        return
                    case .ended:
                        return
                    }
                }
            } catch {
                self.failLink("Could not start port-forward: \(error)")
            }
        }
    }

    private func onPortForwardReady() async {
        let client = SignalBridgeClient(localPort: Self.linkLocalPort)
        // Fetch the QR to scan.
        do { qrPNG = try await client.qrCodePNG() }
        catch is CancellationError { return }
        catch { actionError = "Could not load QR code: \(error)" }
        // Poll for a linked account; first number wins.
        while !Task.isCancelled {
            if let number = try? await client.accounts().first, !number.isEmpty {
                await assistant.setSignal(apiUrl: SignalBridgeManifests.apiURL(namespace: targetNamespace),
                                          number: number, recipients: assistant.signalRecipients)
                stopLinking()
                return
            }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
    }

    private func failLink(_ message: String) {
        actionError = message
        stopLinking()
    }

    func stopLinking() {
        linkTask?.cancel(); linkTask = nil
        if let s = session { Task { await s.terminate() } }
        session = nil
        linking = false
        qrPNG = nil
    }

    // MARK: - Config + test

    func saveRecipients(_ recipients: String) async {
        await assistant.setSignal(apiUrl: assistant.signalApiUrl, number: assistant.signalNumber,
                                  recipients: recipients)
    }

    /// Brief port-forward → POST a test message → tear down.
    func sendTest() async {
        guard !linking else { actionError = "Finish linking before sending a test."; return }
        working = true; actionError = nil
        defer { working = false }
        let ns = targetNamespace
        do {
            let session = try PortForwardSession(
                targetKind: "svc", targetName: SignalBridgeManifests.serviceName,
                namespace: ns, localPort: Self.linkLocalPort,
                remotePort: SignalBridgeManifests.port, context: context)
            defer { Task { await session.terminate() } }
            // Wait for the listener before sending.
            var ready = false
            for await event in session.stream() {
                if case .ready = event { ready = true; break }
                if case .failed(let e) = event { actionError = "Port-forward failed: \(e)"; return }
            }
            guard ready else { actionError = "Port-forward did not become ready."; return }
            let recipients = assistant.signalRecipients
                .split(whereSeparator: { $0 == "," || $0 == " " })
                .map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            try await SignalBridgeClient(localPort: Self.linkLocalPort)
                .sendTest(number: assistant.signalNumber, recipients: recipients)
        } catch {
            actionError = "Test send failed: \(error)"
        }
    }
}
