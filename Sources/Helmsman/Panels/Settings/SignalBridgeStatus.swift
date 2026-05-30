import Foundation

/// Lifecycle of the Signal bridge as shown on the Settings page. Derived purely
/// from cache data so it can be unit-tested without a live cluster.
enum SignalBridgeStatus: Equatable {
    case notDeployed   // no signal-cli-rest Deployment in the target namespace
    case deploying     // kubectl apply in flight
    case starting      // Deployment exists but no ready replica yet
    case ready         // bridge up, no phone linked (no saved sender number)
    case linked        // bridge up and a sender number is saved

    static func derive(deployments: [Deployment], namespace: String,
                       hasSavedNumber: Bool, applying: Bool) -> SignalBridgeStatus {
        if applying { return .deploying }
        let dep = deployments.first {
            $0.metadata.name == SignalBridgeManifests.serviceName
                && ($0.metadata.namespace ?? "default") == namespace
        }
        guard let dep else { return .notDeployed }
        let ready = dep.status?.readyReplicas ?? 0
        guard ready >= 1 else { return .starting }
        return hasSavedNumber ? .linked : .ready
    }
}
