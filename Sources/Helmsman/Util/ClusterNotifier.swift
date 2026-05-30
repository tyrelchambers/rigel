import Foundation
import UserNotifications

/// Posts macOS desktop notifications for unhealthy cluster state.
/// Deduplicates by resource uid + state so the same pod doesn't notify twice
/// for the same condition.
final class ClusterNotifier: @unchecked Sendable {
    static let shared = ClusterNotifier()
    private init() {}

    private let lock = NSLock()
    private var hasPermission = false
    private var didRequestPermission = false

    /// `UNUserNotificationCenter` requires a bundled app with Info.plist (CFBundleIdentifier).
    /// When run as a raw SPM executable, calling `.current()` asserts. Detect that up front
    /// and silently skip — the rest of the app still works.
    private static let isUsable: Bool = (Bundle.main.bundleIdentifier != nil)

    /// uid → last-notified state. We only re-notify when the state transitions.
    private var lastPodState: [String: String] = [:]
    /// event uids we've already notified about
    private var notifiedEvents: Set<String> = []

    private static let coolDown: TimeInterval = 60 * 5

    func requestAuthorizationIfNeeded() {
        guard Self.isUsable else { return }
        lock.lock()
        if didRequestPermission { lock.unlock(); return }
        didRequestPermission = true
        lock.unlock()

        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { [weak self] granted, _ in
            guard let self else { return }
            self.lock.lock()
            self.hasPermission = granted
            self.lock.unlock()
        }
    }

    func notifyIfUnhealthy(pod: Pod) {
        let uid = pod.metadata.uid
        let badState = Self.unhealthyState(pod: pod)

        lock.lock()
        guard let badState else {
            lastPodState.removeValue(forKey: uid)
            lock.unlock()
            return
        }
        if lastPodState[uid] == badState {
            lock.unlock()
            return
        }
        lastPodState[uid] = badState
        lock.unlock()

        let ns = pod.metadata.namespace ?? "default"
        post(
            title: "Pod \(pod.metadata.name) — \(badState)",
            body: "namespace: \(ns)",
            identifier: "pod-\(uid)-\(badState)"
        )
    }

    func notify(warning event: K8sEvent) {
        let uid = event.metadata.uid

        lock.lock()
        if notifiedEvents.contains(uid) {
            lock.unlock()
            return
        }
        notifiedEvents.insert(uid)
        lock.unlock()

        // Forget after the cooldown so the set doesn't grow forever.
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.coolDown * 1_000_000_000))
            self?.lock.lock()
            self?.notifiedEvents.remove(uid)
            self?.lock.unlock()
        }

        let target = [event.involvedObject?.kind, event.involvedObject?.name]
            .compactMap { $0 }.joined(separator: "/")
        post(
            title: "[\(event.reason ?? "Warning")] \(target)",
            body: event.message ?? "",
            identifier: "evt-\(uid)"
        )
    }

    func forgetPod(uid: String) {
        lock.lock(); defer { lock.unlock() }
        lastPodState.removeValue(forKey: uid)
    }

    /// Post an arbitrary desktop notification (used by the Assistant for
    /// action / approval-needed alerts).
    func notify(title: String, body: String, id: String) {
        post(title: title, body: body, identifier: id)
    }

    // MARK: - Internals

    private static func unhealthyState(pod: Pod) -> String? {
        pod.errorReason
    }

    private func post(title: String, body: String, identifier: String) {
        guard Self.isUsable else { return }
        lock.lock()
        let permitted = hasPermission
        lock.unlock()
        guard permitted else { return }

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let req = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req, withCompletionHandler: nil)
    }
}
