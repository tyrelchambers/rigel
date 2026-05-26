import Foundation
import Observation

@MainActor
@Observable
final class LogsViewModel {
    var availablePods: [Pod] = []
    var selectedPodKeys: Set<String> = []         // "namespace/name"
    var lines: [LogLine] = []                      // newest at end
    var maxLines: Int = 5000
    var filter: String = ""
    var isPaused = false
    var error: String? = nil

    private var listClient: KubectlClient?
    private var listTask: Task<Void, Never>?
    private var streams: [String: Task<Void, Never>] = [:]   // key → stream task

    var filteredLines: [LogLine] {
        if filter.isEmpty { return lines }
        let needle = filter
        return lines.filter { $0.text.localizedCaseInsensitiveContains(needle) }
    }

    func start(context: String?) {
        stopAll()
        do {
            let c = try KubectlClient(context: context)
            self.listClient = c
            listTask = Task { [weak self] in
                do {
                    let list = try await c.getList("pods", type: Pod.self)
                    await MainActor.run {
                        self?.availablePods = list.items.sorted { a, b in
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

    func toggleSelection(_ pod: Pod, context: String?) {
        let key = "\(pod.metadata.namespace ?? "default")/\(pod.metadata.name)"
        if selectedPodKeys.contains(key) {
            selectedPodKeys.remove(key)
            streams[key]?.cancel()
            streams.removeValue(forKey: key)
            lines.removeAll { $0.sourcePod == key }
        } else {
            selectedPodKeys.insert(key)
            startStream(pod: pod, key: key, context: context)
        }
    }

    private func startStream(pod: Pod, key: String, context: String?) {
        let colorIndex = PodColorAssigner.colorIndex(for: key)
        let ns = pod.metadata.namespace ?? "default"
        let name = pod.metadata.name

        let task = Task { [weak self] in
            do {
                let s = try PodLogStream(namespace: ns, podName: name, context: context, colorIndex: colorIndex)
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
