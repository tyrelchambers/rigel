import Foundation

struct PurgeResource: Identifiable, Hashable {
    enum Kind: String { case deployment, statefulSet, service, ingress, secret, configMap, pvc }
    let kind: Kind
    let name: String
    let namespace: String
    /// Selected for deletion by default. PVCs (data) start selected too but are
    /// visually flagged; the typed-name confirm is the real gate.
    var selected: Bool = true
    var id: String { "\(kind.rawValue)/\(namespace)/\(name)" }
}

struct PurgePlan: Identifiable {
    /// Stable identity for `.sheet(item:)` presentation.
    var id: String { "\(appName)/\(namespace)" }
    let appName: String
    let namespace: String
    var resources: [PurgeResource]
    /// Non-nil when the app was installed via Helm — purge runs `helm uninstall`
    /// for the release FIRST, then sweeps anything the chart left behind (PVCs).
    var helmRelease: String? = nil
    /// Surfaced separately, default-OFF: an opt-in logical DB drop.
    var databaseHint: String? = nil
    var dropDatabase: Bool = false
    /// Non-nil when the whole target is off-limits (e.g. a system namespace).
    var blockedReason: String? = nil
}

enum PurgeDiscovery {
    static func discover(
        rootName: String, namespace: String,
        deployments: [Deployment], statefulSets: [StatefulSet],
        services: [Service], ingresses: [Ingress],
        secrets: [Secret], configMaps: [ConfigMap], pvcs: [PersistentVolumeClaim]
    ) -> PurgePlan {
        guard PurgeGuardrails.isPurgeable(namespace: namespace) else {
            return PurgePlan(appName: rootName, namespace: namespace, resources: [],
                             blockedReason: "\(namespace) is a protected system namespace")
        }
        let depNames = deployments.map(\.metadata.name)
        let related = Set(PurgeNameMatcher.relatedNames(root: rootName, among: depNames))
        // Sibling workloads (skip shared infra servers).
        var out: [PurgeResource] = []
        func add(_ kind: PurgeResource.Kind, _ name: String) {
            if PurgeGuardrails.isSharedInfraWorkload(name: name, namespace: namespace) { return }
            out.append(PurgeResource(kind: kind, name: name, namespace: namespace))
        }
        for d in deployments where related.contains(d.metadata.name) { add(.deployment, d.metadata.name) }
        let ssNames = PurgeNameMatcher.relatedNames(root: rootName, among: statefulSets.map(\.metadata.name))
        for s in statefulSets where ssNames.contains(s.metadata.name) { add(.statefulSet, s.metadata.name) }
        // Dependents matched by name relation to the app (same loose matcher).
        for svc in services where !related.isDisjoint(with: [svc.metadata.name]) || isRelated(svc.metadata.name, rootName) { add(.service, svc.metadata.name) }
        for ing in ingresses where isRelated(ing.metadata.name, rootName) { add(.ingress, ing.metadata.name) }
        for cm in configMaps where isRelated(cm.metadata.name, rootName) { add(.configMap, cm.metadata.name) }
        for sec in secrets where isRelated(sec.metadata.name, rootName) { add(.secret, sec.metadata.name) }
        for p in pvcs where isRelated(p.metadata.name, rootName) { add(.pvc, p.metadata.name) }
        return PurgePlan(appName: rootName, namespace: namespace, resources: out,
                         helmRelease: helmRelease(among: secrets, rootName: rootName))
    }

    /// Detect a Helm-managed app: Helm stores release state in a Secret named
    /// `sh.helm.release.v1.<release>.v<N>`. We parse the `<release>` token and keep
    /// it only when it relates to the purge root by the same loose name-core match,
    /// so an unrelated release in the same namespace can't be uninstalled.
    private static func helmRelease(among secrets: [Secret], rootName: String) -> String? {
        let prefix = "sh.helm.release.v1."
        for sec in secrets {
            let name = sec.metadata.name
            guard name.hasPrefix(prefix) else { continue }
            // Strip the prefix and the trailing `.v<N>` revision segment.
            let rest = String(name.dropFirst(prefix.count))
            guard let dot = rest.lastIndex(of: ".") else { continue }
            let release = String(rest[..<dot])
            guard !release.isEmpty else { continue }
            if isRelated(release, rootName) { return release }
        }
        return nil
    }

    private static func isRelated(_ name: String, _ root: String) -> Bool {
        let c = PurgeNameMatcher.core(name), rc = PurgeNameMatcher.core(root)
        guard rc.count >= 4 else { return name == root }
        return c.hasPrefix(rc) || rc.hasPrefix(c)
    }
}
