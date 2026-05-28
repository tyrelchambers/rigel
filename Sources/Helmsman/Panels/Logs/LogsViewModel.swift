import Foundation
import Observation

@MainActor
@Observable
final class LogsViewModel {
    let cache: ClusterCache
    init(cache: ClusterCache) { self.cache = cache }

    var selectedDeploymentKey: String? = nil      // "namespace/name"
    var lines: [LogLine] = []
    var maxLines: Int = 5000
    var filter: String = ""
    var hideProbes = true
    var isPaused = false
    var error: String? = nil

    private var currentStream: Task<Void, Never>?

    var availableDeployments: [Deployment] {
        cache.deployments.sorted { a, b in
            let aNs = a.metadata.namespace ?? ""
            let bNs = b.metadata.namespace ?? ""
            if aNs != bNs { return aNs < bNs }
            return a.metadata.name < b.metadata.name
        }
    }

    var selectedDeployment: Deployment? {
        guard let key = selectedDeploymentKey else { return nil }
        return availableDeployments.first {
            "\($0.metadata.namespace ?? "default")/\($0.metadata.name)" == key
        }
    }

    var filteredLines: [LogLine] {
        var out = lines
        if hideProbes {
            out = out.filter { !LogNoiseFilter.isProbe($0) }
        }
        if !filter.isEmpty {
            let needle = filter
            out = out.filter { $0.text.localizedCaseInsensitiveContains(needle) }
        }
        return out
    }

    func select(_ deployment: Deployment, context: String?) {
        let key = "\(deployment.metadata.namespace ?? "default")/\(deployment.metadata.name)"
        if selectedDeploymentKey == key { return }   // already on this one
        currentStream?.cancel()
        currentStream = nil
        lines.removeAll()
        error = nil
        selectedDeploymentKey = key
        startStream(deployment: deployment, context: context)
    }

    func clearSelection() {
        currentStream?.cancel()
        currentStream = nil
        selectedDeploymentKey = nil
        lines.removeAll()
    }

    private func startStream(deployment: Deployment, context: String?) {
        let selector = deployment.labelSelector
        guard !selector.isEmpty else {
            self.error = "deployment has no spec.selector.matchLabels"
            return
        }
        let ns = deployment.metadata.namespace ?? "default"
        let key = "\(ns)/\(deployment.metadata.name)"

        currentStream = Task { [weak self] in
            do {
                let s = try LogStream(namespace: ns, labelSelector: selector, streamKey: key, context: context)
                let stream = s.stream()
                for await line in stream {
                    if Task.isCancelled { break }
                    await MainActor.run { self?.appendLine(line) }
                }
            } catch {
                if Task.isCancelled { return }
                await MainActor.run { self?.error = "\(error)" }
            }
        }
    }

    private func appendLine(_ line: LogLine) {
        guard !isPaused else { return }
        lines.append(line)
        if lines.count > maxLines {
            lines.removeFirst(lines.count - maxLines)
        }
    }

    func stop() {
        currentStream?.cancel()
        currentStream = nil
    }

    func clear() {
        lines.removeAll()
    }
}
