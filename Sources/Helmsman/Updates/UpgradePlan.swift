import Foundation

/// One container that needs its image tag bumped for an upgrade: which workload
/// carries it, the container name, and the exact before/after image strings.
/// `workloadKind` is a kubectl resource string ("deployment" | "statefulset")
/// so it maps straight onto a `setImage` action.
struct ImageUpgradeTarget: Equatable {
    let workloadKind: String
    let workloadName: String
    let namespace: String
    let container: String
    let currentImage: String
    let newImage: String
}

/// The concrete, app-specific facts an upgrade needs: the running tag, the
/// target tag, and every container across the cluster running the app's image
/// (so a multi-replica or multi-workload app upgrades all of them). Pure — built
/// from cluster snapshots, no I/O — so it pairs the static `UpgradePlaybook.md`
/// with a `contextBlock` the assistant can act on precisely.
struct UpgradePlan {
    let appName: String
    let currentTag: String
    let targetTag: String
    let targets: [ImageUpgradeTarget]

    /// Scan the given workloads for containers running `currentImage` (matched
    /// host- and tag-insensitively, like `installedAppIDs`) and build a target
    /// per match with its tag swapped to `targetTag`.
    static func make(
        appName: String,
        currentImage: String,
        targetTag: String,
        deployments: [Deployment],
        statefulSets: [StatefulSet]
    ) -> UpgradePlan {
        let wantedRepo = imageRepoPath(currentImage)
        var targets: [ImageUpgradeTarget] = []

        func scan(kind: String, name: String, namespace: String, containers: [Container]) {
            for c in containers {
                guard let image = c.image, repoPathsMatch(imageRepoPath(image), wantedRepo) else { continue }
                targets.append(ImageUpgradeTarget(
                    workloadKind: kind,
                    workloadName: name,
                    namespace: namespace,
                    container: c.name,
                    currentImage: image,
                    newImage: "\(imageRepoPath(image)):\(targetTag)"
                ))
            }
        }

        for d in deployments {
            scan(kind: "deployment", name: d.metadata.name, namespace: d.metadata.namespace ?? "default",
                 containers: d.spec?.template?.spec?.containers ?? [])
        }
        for s in statefulSets {
            scan(kind: "statefulset", name: s.metadata.name, namespace: s.metadata.namespace ?? "default",
                 containers: s.spec?.template?.spec?.containers ?? [])
        }

        let currentTag = ImageReference(currentImage)?.tag ?? currentImage
        return UpgradePlan(appName: appName, currentTag: currentTag, targetTag: targetTag, targets: targets)
    }

    /// The block prepended to the playbook for this run. Names the app, the
    /// version jump, and each workload/container to set — so the assistant emits
    /// exact `setImage` actions instead of guessing.
    var contextBlock: String {
        let lines = targets.map {
            "- \($0.workloadKind)/\($0.workloadName) (namespace \($0.namespace)), container `\($0.container)`: `\($0.currentImage)` → `\($0.newImage)`"
        }.joined(separator: "\n")
        return """
        UPGRADE REQUEST — apply the playbook above to this specific upgrade.

        App: \(appName)
        Current tag: \(currentTag)
        Target tag: \(targetTag)

        Containers to upgrade:
        \(lines)
        """
    }
}
