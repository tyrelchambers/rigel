import Foundation

// MARK: - PersistentVolumeClaim

struct PersistentVolumeClaim: Codable, Identifiable, Hashable {
    let metadata: ObjectMeta
    let spec: Spec?
    let status: Status?
    var id: String { metadata.uid }

    struct Spec: Codable, Hashable {
        let accessModes: [String]?
        let resources: ResourceRequirements?   // requests["storage"]
        let storageClassName: String?
        let volumeName: String?                // bound PV
        let volumeMode: String?
    }

    struct Status: Codable, Hashable {
        let phase: String?                     // Bound | Pending | Lost
        let capacity: [String: String]?        // actual provisioned
        let accessModes: [String]?
    }

    /// Actual provisioned size if bound, else the requested size.
    var capacity: String {
        status?.capacity?["storage"]
            ?? spec?.resources?.requests?["storage"]
            ?? "—"
    }

    var phase: String { status?.phase ?? "Unknown" }

    var accessModeLabels: [String] {
        StorageDisplay.abbreviateAccessModes(status?.accessModes ?? spec?.accessModes ?? [])
    }
}

// MARK: - PersistentVolume

struct PersistentVolume: Codable, Identifiable, Hashable {
    let metadata: ObjectMeta
    let spec: Spec?
    let status: Status?
    var id: String { metadata.uid }

    struct Spec: Codable, Hashable {
        let capacity: [String: String]?
        let accessModes: [String]?
        let persistentVolumeReclaimPolicy: String?   // Retain | Delete | Recycle
        let storageClassName: String?
        let claimRef: ClaimRef?
        let volumeMode: String?
    }

    struct ClaimRef: Codable, Hashable {
        let namespace: String?
        let name: String?
    }

    struct Status: Codable, Hashable {
        let phase: String?                           // Available | Bound | Released | Failed
    }

    var capacity: String { spec?.capacity?["storage"] ?? "—" }
    var phase: String { status?.phase ?? "Unknown" }
    var reclaimPolicy: String { spec?.persistentVolumeReclaimPolicy ?? "—" }

    var accessModeLabels: [String] {
        StorageDisplay.abbreviateAccessModes(spec?.accessModes ?? [])
    }

    /// "namespace/name" of the bound claim, if any.
    var claim: String? {
        guard let ref = spec?.claimRef, let name = ref.name else { return nil }
        return "\(ref.namespace ?? "default")/\(name)"
    }
}

// MARK: - StorageClass

struct StorageClass: Codable, Identifiable, Hashable {
    let metadata: ObjectMeta
    // Top-level fields (not under `spec`) per the storage.k8s.io/v1 API.
    let provisioner: String?
    let reclaimPolicy: String?
    let volumeBindingMode: String?
    let allowVolumeExpansion: Bool?
    var id: String { metadata.uid }

    /// Marked as the cluster default via the well-known annotation.
    var isDefault: Bool {
        metadata.annotations?["storageclass.kubernetes.io/is-default-class"] == "true"
    }
}

// MARK: - Shared display helpers

enum StorageDisplay {
    /// k8s access modes → the conventional short forms (RWO/ROX/RWX/RWOP).
    static func abbreviateAccessModes(_ modes: [String]) -> [String] {
        modes.map { mode in
            switch mode {
            case "ReadWriteOnce":    return "RWO"
            case "ReadOnlyMany":     return "ROX"
            case "ReadWriteMany":    return "RWX"
            case "ReadWriteOncePod": return "RWOP"
            default:                 return mode
            }
        }
    }
}
