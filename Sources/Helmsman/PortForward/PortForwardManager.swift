import Foundation
import Observation

/// Tracks the active `kubectl port-forward` sessions for the app. Owned by
/// `ServicesViewModel` (which persists for the app lifetime), so forwards
/// survive navigating away from the Services panel and back. Cleared on
/// cluster-context switch via `stopAll()`.
///
/// `start`/`stop`/`stopAll` are called from SwiftUI (main); status updates
/// driven by the background port-forward stream hop to the main actor before
/// touching the observable `forwards` so SwiftUI sees them.
@Observable
final class PortForwardManager {
    struct ActiveForward: Identifiable {
        enum Status: Equatable {
            case starting
            case running
            case failed(String)
        }
        let id = UUID()
        let targetKind: String   // "svc" | "pod"
        let targetName: String
        let namespace: String
        let localPort: Int
        let remotePort: Int
        var status: Status = .starting
    }

    private(set) var forwards: [ActiveForward] = []

    /// Session + consuming task kept off the @Observable surface so view diffs
    /// only react to `forwards`.
    @ObservationIgnored private var sessions: [UUID: (session: PortForwardSession, task: Task<Void, Never>)] = [:]

    /// True when a local port is already claimed by a live (starting/running)
    /// forward — lets the start sheet reject duplicates before launching kubectl.
    func isLocalPortInUse(_ port: Int) -> Bool {
        forwards.contains { $0.localPort == port && !isFailed($0) }
    }

    private func isFailed(_ f: ActiveForward) -> Bool {
        if case .failed = f.status { return true }
        return false
    }

    func start(targetKind: String, targetName: String, namespace: String, remotePort: Int, localPort: Int, context: String?) {
        let entry = ActiveForward(targetKind: targetKind, targetName: targetName, namespace: namespace, localPort: localPort, remotePort: remotePort)
        let id = entry.id
        forwards.append(entry)

        do {
            let session = try PortForwardSession(
                targetKind: targetKind, targetName: targetName, namespace: namespace,
                localPort: localPort, remotePort: remotePort, context: context
            )
            let task = Task { [weak self] in
                for await event in session.stream() {
                    guard let self else { break }
                    await self.apply(event, to: id)
                }
            }
            sessions[id] = (session, task)
        } catch {
            updateStatus(id, .failed("\(error)"))
        }
    }

    func stop(_ id: UUID) {
        if let entry = sessions.removeValue(forKey: id) {
            entry.task.cancel()
            Task { await entry.session.terminate() }
        }
        forwards.removeAll { $0.id == id }
    }

    func stopAll() {
        for (_, entry) in sessions {
            entry.task.cancel()
            Task { await entry.session.terminate() }
        }
        sessions.removeAll()
        forwards.removeAll()
    }

    // MARK: - Private

    /// Apply a stream event on the main actor so the observable `forwards`
    /// mutation is seen by SwiftUI.
    @MainActor
    private func apply(_ event: PortForwardEvent, to id: UUID) {
        switch event {
        case .ready:
            updateStatus(id, .running)
        case .failed(let msg):
            updateStatus(id, .failed(msg))
        case .ended:
            // Clean stop (we terminated it) — drop the row if still present.
            removeIfPresent(id)
        }
    }

    private func updateStatus(_ id: UUID, _ status: ActiveForward.Status) {
        guard let i = forwards.firstIndex(where: { $0.id == id }) else { return }
        forwards[i].status = status
    }

    private func removeIfPresent(_ id: UUID) {
        sessions.removeValue(forKey: id)
        forwards.removeAll { $0.id == id }
    }
}
