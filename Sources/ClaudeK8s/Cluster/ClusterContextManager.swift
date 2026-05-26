import Foundation
import Observation

@Observable
final class ClusterContextManager {
    var available: [KubeContext] = []
    var active: KubeContext? = nil
    var loadError: String? = nil

    func reload() {
        do {
            let cfg = try KubeconfigParser.loadDefault()
            self.available = cfg.contexts
            self.active = cfg.contexts.first(where: { $0.name == cfg.currentContext }) ?? cfg.contexts.first
            self.loadError = nil
        } catch {
            self.loadError = "\(error)"
        }
    }

    func setActive(_ context: KubeContext) {
        self.active = context
    }
}
