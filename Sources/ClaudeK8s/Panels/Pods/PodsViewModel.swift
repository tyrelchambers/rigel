import Foundation
import Observation

@Observable
final class PodsViewModel {
    var pods: [Pod] = []
    var error: String? = nil
    var isLoading = false

    private var watchTask: Task<Void, Never>?
    private var client: KubectlClient?

    func start(context: String?) {
        watchTask?.cancel()
        do {
            let c = try KubectlClient(context: context)
            self.client = c
            self.isLoading = true
            self.error = nil

            watchTask = Task { [weak self] in
                // Initial list seed
                do {
                    let list = try await c.getList("pods", type: Pod.self)
                    await MainActor.run { self?.pods = list.items; self?.isLoading = false }
                } catch {
                    await MainActor.run { self?.error = "\(error)"; self?.isLoading = false }
                }

                // Watch for changes
                let stream = c.watch("pods", type: Pod.self)
                do {
                    for try await event in stream {
                        if Task.isCancelled { break }
                        await MainActor.run { self?.apply(event) }
                    }
                } catch {
                    await MainActor.run { self?.error = "\(error)" }
                }
            }
        } catch {
            self.error = "\(error)"
        }
    }

    func stop() {
        watchTask?.cancel()
        watchTask = nil
    }

    private func apply(_ event: WatchEvent<Pod>) {
        switch event.type {
        case .added, .modified:
            if let idx = pods.firstIndex(where: { $0.metadata.uid == event.object.metadata.uid }) {
                pods[idx] = event.object
            } else {
                pods.append(event.object)
            }
        case .deleted:
            pods.removeAll { $0.metadata.uid == event.object.metadata.uid }
        case .error, .bookmark:
            break
        }
    }
}
