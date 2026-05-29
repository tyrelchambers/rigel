import Foundation
import Observation

/// Drives the "set up a metrics backend" sheet: pick backend + storage, preview
/// the manifest, apply it, and on success persist it as the context's source.
@Observable
@MainActor
final class MetricsInstallModel: Identifiable {
    enum Step: Equatable {
        case configuring
        case applying
        case done
        case failed(String)
    }

    let id = UUID()
    let context: String?

    var backend: MetricsInstallManifests.Backend = .victoriaMetrics
    var namespace: String = "helmsman-metrics"
    var persistent: Bool
    var sizeGiB: Int = 5
    private(set) var step: Step = .configuring
    /// Set once the install succeeds, so the caller can switch the source.
    private(set) var installedBackend: MetricsBackendConfig?

    /// True if the cluster has a default StorageClass (so a PVC will bind).
    let hasDefaultStorageClass: Bool

    init(context: String?, cache: ClusterCache) {
        self.context = context
        let hasDefault = cache.storageClasses.contains { $0.isDefault }
        self.hasDefaultStorageClass = hasDefault
        self.persistent = hasDefault   // prefill: persistent only when a PVC can bind
    }

    var manifest: String {
        MetricsInstallManifests.manifest(backend: backend, namespace: namespace, persistent: persistent, sizeGiB: sizeGiB)
    }

    var namespaceValid: Bool {
        let n = namespace.trimmingCharacters(in: .whitespaces)
        return n.range(of: "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$", options: .regularExpression) != nil
    }

    func install() async {
        step = .applying
        let action = WorkloadAction.applyManifest(yaml: manifest, label: "\(backend.title) metrics backend")
        let result = await WorkloadCommander(context: context).run(action)
        if result.ok {
            let cfg = MetricsInstallManifests.resultingBackend(backend, namespace: namespace.trimmingCharacters(in: .whitespaces))
            installedBackend = cfg
            if let ctx = context { SessionStore.shared.setMetricsBackend(cfg, for: ctx) }
            step = .done
        } else {
            step = .failed(result.stderr.isEmpty ? "kubectl exited \(result.exitCode)" : result.stderr)
        }
    }
}
