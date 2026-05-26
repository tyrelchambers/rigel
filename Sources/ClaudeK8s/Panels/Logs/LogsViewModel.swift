import Foundation
import Observation

@MainActor
@Observable
final class LogsViewModel {
    var availableDeployments: [Deployment] = []
    var selectedDeploymentKeys: Set<String> = []         // "namespace/name"
    var lines: [LogLine] = []
    var maxLines: Int = 5000
    var filter: String = ""
    var hideProbes = true                                  // ON by default
    var isPaused = false
    var error: String? = nil

    private var listClient: KubectlClient?
    private var listTask: Task<Void, Never>?
    private var streams: [String: Task<Void, Never>] = [:]

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

    func start(context: String?) {
        stopAll()
        do {
            let c = try KubectlClient(context: context)
            self.listClient = c
            listTask = Task { [weak self] in
                do {
                    let list = try await c.getList("deployments", type: Deployment.self)
                    await MainActor.run {
                        self?.availableDeployments = list.items.sorted { a, b in
                            let aNs = a.metadata.namespace ?? ""
                            let bNs = b.metadata.namespace ?? ""
                            if aNs != bNs { return aNs < bNs }
                            return a.metadata.name < b.metadata.name
                        }
                    }
                } catch {
                    await MainActor.run { self?.error = "\(error)" }
                }
            }
        } catch {
            self.error = "\(error)"
        }
    }

    func toggleSelection(_ deployment: Deployment, context: String?) {
        let key = "\(deployment.metadata.namespace ?? "default")/\(deployment.metadata.name)"
        if selectedDeploymentKeys.contains(key) {
            selectedDeploymentKeys.remove(key)
            streams[key]?.cancel()
            streams.removeValue(forKey: key)
        } else {
            selectedDeploymentKeys.insert(key)
            startStream(deployment: deployment, key: key, context: context)
        }
    }

    private func startStream(deployment: Deployment, key: String, context: String?) {
        let selector = deployment.labelSelector
        guard !selector.isEmpty else {
            self.error = "deployment \(key) has no spec.selector.matchLabels"
            return
        }
        let ns = deployment.metadata.namespace ?? "default"

        let task = Task { [weak self] in
            do {
                let s = try LogStream(namespace: ns, labelSelector: selector, streamKey: key, context: context)
                let stream = s.stream()
                for await line in stream {
                    if Task.isCancelled { break }
                    await MainActor.run { self?.appendLine(line) }
                }
            } catch {
                await MainActor.run { self?.error = "\(error)" }
            }
        }
        streams[key] = task
    }

    private func appendLine(_ line: LogLine) {
        guard !isPaused else { return }
        lines.append(line)
        if lines.count > maxLines {
            lines.removeFirst(lines.count - maxLines)
        }
    }

    func stopAll() {
        listTask?.cancel()
        listTask = nil
        for (_, t) in streams { t.cancel() }
        streams.removeAll()
    }

    func clear() {
        lines.removeAll()
    }
}
