# Connectivity Map (Topology rework) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the low-insight cluster topology treemap with a Connectivity map: ingress → service → pods request-flow rows (external + internal sections) that flag where traffic can't land (missing service, no backing pods, 0 ready endpoints).

**Architecture:** A pure, tested `Connectivity.flows(ingresses:services:pods:)` resolves the flows + health; a thin `ConnectivityPanel` renders them. The `.topology` PanelKind/tab is renamed to `.connectivity`. The entire treemap implementation (layout, view, `Viz.treemapModel`, tests) is deleted as dead code.

**Tech Stack:** Swift 5.10, SwiftUI, XCTest. Build: `swift build`. Test: `swift test --filter <name>`.

---

## Task R1: Pure `Connectivity` flow model

**Files:**
- Create: `Sources/Helmsman/Cluster/Connectivity.swift`
- Test: `Tests/HelmsmanTests/ConnectivityTests.swift`

This task only ADDS new files — it does not touch the treemap yet, so the build stays green throughout.

- [ ] **Step 1: Write the failing tests**

Create `Tests/HelmsmanTests/ConnectivityTests.swift`:

```swift
import XCTest
@testable import Helmsman

final class ConnectivityTests: XCTestCase {

    // MARK: Fixtures

    private func pod(_ name: String, ns: String = "default", labels: [String: String], phase: String = "Running", ready: Bool = true) -> Pod {
        Pod(
            metadata: ObjectMeta(name: name, namespace: ns, uid: "uid-\(name)", creationTimestamp: nil, labels: labels, annotations: nil),
            spec: PodSpec(nodeName: "n1", containers: []),
            status: PodStatus(phase: phase, podIP: nil,
                              containerStatuses: [ContainerStatus(name: "c", ready: ready, restartCount: 0, state: nil)])
        )
    }

    private func service(_ name: String, ns: String = "default", selector: [String: String]?, type: String = "ClusterIP") -> Service {
        Service(
            metadata: ObjectMeta(name: name, namespace: ns, uid: "uid-svc-\(name)", creationTimestamp: nil, labels: nil, annotations: nil),
            spec: Service.Spec(type: type, clusterIP: "10.0.0.1", selector: selector, ports: nil, externalName: nil, externalIPs: nil),
            status: nil
        )
    }

    /// Ingress with a single host → service rule.
    private func ingress(_ name: String, ns: String = "default", host: String, service: String) -> Ingress {
        let backend = Ingress.Backend(service: Ingress.ServiceBackend(name: service, port: Ingress.ServicePort(number: 80, name: nil)))
        let path = Ingress.Path(path: "/", pathType: "Prefix", backend: backend)
        let rule = Ingress.Rule(host: host, http: Ingress.HTTP(paths: [path]))
        return Ingress(
            metadata: ObjectMeta(name: name, namespace: ns, uid: "uid-ing-\(name)", creationTimestamp: nil, labels: nil, annotations: nil),
            spec: Ingress.Spec(ingressClassName: "nginx", tls: nil, rules: [rule], defaultBackend: nil),
            status: nil
        )
    }

    // MARK: Tests

    func test_externalFlow_ingressToServiceToReadyPods_isOk() {
        let pods = [pod("web-1", labels: ["app": "web"]), pod("web-2", labels: ["app": "web"])]
        let svc = service("web", selector: ["app": "web"])
        let ing = ingress("web-ing", host: "myapp.com", service: "web")
        let flows = Connectivity.flows(ingresses: [ing], services: [svc], pods: pods)
        XCTAssertEqual(flows.count, 1)
        let f = flows[0]
        XCTAssertTrue(f.isExternal)
        XCTAssertEqual(f.hosts, ["myapp.com"])
        XCTAssertEqual(f.ingressNames, ["web-ing"])
        XCTAssertEqual(f.readyPods, 2)
        XCTAssertEqual(f.totalPods, 2)
        XCTAssertTrue(f.serviceExists)
        XCTAssertTrue(f.issues.isEmpty)
        XCTAssertEqual(f.health, .ok)
    }

    func test_danglingIngress_missingService_isBroken() {
        let ing = ingress("api-ing", host: "old.me", service: "ghost")
        let flows = Connectivity.flows(ingresses: [ing], services: [], pods: [])
        XCTAssertEqual(flows.count, 1)
        let f = flows[0]
        XCTAssertFalse(f.serviceExists)
        XCTAssertEqual(f.serviceName, "ghost")
        XCTAssertTrue(f.isExternal)
        XCTAssertEqual(f.health, .broken)
        XCTAssertFalse(f.issues.isEmpty)
    }

    func test_internalService_withReadyPods_isOkAndInternal() {
        let pods = [pod("db-0", labels: ["app": "db"])]
        let svc = service("postgres", selector: ["app": "db"])
        let flows = Connectivity.flows(ingresses: [], services: [svc], pods: pods)
        XCTAssertEqual(flows.count, 1)
        XCTAssertFalse(flows[0].isExternal)
        XCTAssertEqual(flows[0].health, .ok)
        XCTAssertEqual(flows[0].readyPods, 1)
    }

    func test_externalService_zeroReadyEndpoints_isBroken() {
        let pods = [pod("web-1", labels: ["app": "web"], ready: false)]
        let svc = service("web", selector: ["app": "web"])
        let ing = ingress("web-ing", host: "myapp.com", service: "web")
        let flows = Connectivity.flows(ingresses: [ing], services: [svc], pods: pods)
        XCTAssertEqual(flows[0].readyPods, 0)
        XCTAssertEqual(flows[0].totalPods, 1)
        XCTAssertEqual(flows[0].health, .broken)
    }

    func test_internalService_noBackingPods_isWarn() {
        let svc = service("orphan", selector: ["app": "nope"])
        let flows = Connectivity.flows(ingresses: [], services: [svc], pods: [])
        XCTAssertEqual(flows[0].health, .warn)
        XCTAssertTrue(flows[0].issues.contains { $0.localizedCaseInsensitiveContains("no pods") })
    }

    func test_noSelectorService_isOkWithNoPodIssue() {
        let svc = service("externalname", selector: nil, type: "ExternalName")
        let flows = Connectivity.flows(ingresses: [], services: [svc], pods: [])
        XCTAssertTrue(flows[0].issues.isEmpty)
        XCTAssertEqual(flows[0].health, .ok)
    }

    func test_sortsBrokenFirst() {
        let okSvc = service("web", selector: ["app": "web"])
        let okPods = [pod("web-1", labels: ["app": "web"])]
        let brokenIng = ingress("api-ing", host: "old.me", service: "ghost")
        let flows = Connectivity.flows(ingresses: [brokenIng], services: [okSvc], pods: okPods)
        XCTAssertEqual(flows.first?.health, .broken)
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `swift test --filter ConnectivityTests`
Expected: FAIL — `Connectivity` is not defined.

- [ ] **Step 3: Implement the model**

Create `Sources/Helmsman/Cluster/Connectivity.swift`:

```swift
import Foundation

/// Resolves the cluster's request paths — ingress → service → pods — into flat
/// rows for the Connectivity panel, flagging where traffic can't actually land.
/// Pure: selector→pod matching and health classification live here so they can
/// be unit-tested without the live cache.
enum Connectivity {
    enum Health: Equatable { case ok, warn, broken }

    struct Flow: Identifiable, Equatable {
        let id: String
        let hosts: [String]            // ingress hosts routing here; empty = internal
        let ingressNames: [String]
        let serviceName: String
        let namespace: String
        let serviceType: String        // "ClusterIP" etc; "—" when the service is missing
        let serviceExists: Bool
        let readyPods: Int
        let totalPods: Int
        let podNames: [String]
        let isExternal: Bool
        let issues: [String]

        /// External reachability problems are hard failures; internal ones warn.
        var health: Health {
            guard issues.isEmpty else { return isExternal ? .broken : .warn }
            return .ok
        }
    }

    static func flows(ingresses: [Ingress], services: [Service], pods: [Pod]) -> [Flow] {
        // 1. Map each "namespace/service-name" target to the hosts + ingress names fronting it.
        struct Front { var hosts: Set<String> = []; var ingresses: Set<String> = [] }
        var fronts: [String: Front] = [:]
        for ing in ingresses {
            let ns = ing.metadata.namespace ?? "default"
            for route in ing.routes where route.service != "—" {
                let key = "\(ns)/\(route.service)"
                var f = fronts[key] ?? Front()
                if route.host != "*" { f.hosts.insert(route.host) }
                f.ingresses.insert(ing.metadata.name)
                fronts[key] = f
            }
        }

        let serviceKeys = Set(services.map { "\($0.metadata.namespace ?? "default")/\($0.metadata.name)" })
        var flows: [Flow] = []

        // 2. One flow per service.
        for svc in services {
            let ns = svc.metadata.namespace ?? "default"
            let key = "\(ns)/\(svc.metadata.name)"
            let front = fronts[key]
            let isExternal = !(front?.ingresses.isEmpty ?? true)

            let selector = svc.spec?.selector ?? [:]
            let matched = selector.isEmpty ? [] : pods.filter { pod in
                (pod.metadata.namespace ?? "default") == ns &&
                selector.allSatisfy { (pod.metadata.labels ?? [:])[$0.key] == $0.value }
            }
            let ready = matched.filter(isPodReady).count

            var issues: [String] = []
            if !selector.isEmpty {
                if matched.isEmpty {
                    issues.append("Selector matches no pods")
                } else if ready == 0 {
                    issues.append("\(matched.count) pod\(matched.count == 1 ? "" : "s"), 0 ready")
                }
            }

            flows.append(Flow(
                id: key,
                hosts: front?.hosts.sorted() ?? [],
                ingressNames: front?.ingresses.sorted() ?? [],
                serviceName: svc.metadata.name,
                namespace: ns,
                serviceType: svc.typeLabel,
                serviceExists: true,
                readyPods: ready,
                totalPods: matched.count,
                podNames: matched.map { $0.metadata.name }.sorted(),
                isExternal: isExternal,
                issues: issues
            ))
        }

        // 3. Dangling ingress routes — point at a service that doesn't exist.
        for (key, front) in fronts where !serviceKeys.contains(key) {
            let parts = key.split(separator: "/", maxSplits: 1).map(String.init)
            let ns = parts.first ?? "default"
            let name = parts.count > 1 ? parts[1] : key
            flows.append(Flow(
                id: key,
                hosts: front.hosts.sorted(),
                ingressNames: front.ingresses.sorted(),
                serviceName: name,
                namespace: ns,
                serviceType: "—",
                serviceExists: false,
                readyPods: 0,
                totalPods: 0,
                podNames: [],
                isExternal: true,
                issues: ["Ingress points to a service that doesn't exist"]
            ))
        }

        // 4. Sort: broken → warn → ok, then namespace/name.
        func rank(_ h: Health) -> Int { h == .broken ? 0 : (h == .warn ? 1 : 2) }
        return flows.sorted {
            if rank($0.health) != rank($1.health) { return rank($0.health) < rank($1.health) }
            if $0.namespace != $1.namespace { return $0.namespace < $1.namespace }
            return $0.serviceName < $1.serviceName
        }
    }

    /// A pod is a ready endpoint when it's Running with all containers ready.
    static func isPodReady(_ pod: Pod) -> Bool {
        guard pod.status?.phase == "Running" else { return false }
        let cs = pod.status?.containerStatuses ?? []
        return !cs.isEmpty && cs.allSatisfy { $0.ready }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `swift test --filter ConnectivityTests`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add Sources/Helmsman/Cluster/Connectivity.swift Tests/HelmsmanTests/ConnectivityTests.swift
git commit -m "feat(connectivity): pure ingress→service→pods flow model"
```

---

## Task R2: ConnectivityPanel + tab swap + delete treemap

**Files:**
- Create: `Sources/Helmsman/Panels/Connectivity/ConnectivityPanel.swift`
- Modify: `Sources/Helmsman/Charts/ChartTheme.swift`, `Sources/Helmsman/Charts/Aggregations.swift`, `Sources/Helmsman/Panels/PanelKind.swift`, `Sources/Helmsman/Shell/MainWindow.swift`, `Tests/HelmsmanTests/VizAggregationsTests.swift`
- Delete: `Sources/Helmsman/Charts/TreemapLayout.swift`, `Sources/Helmsman/Charts/ClusterTreemap.swift`, `Sources/Helmsman/Panels/Topology/TopologyPanel.swift`, `Tests/HelmsmanTests/TreemapLayoutTests.swift`

- [ ] **Step 1: Create ConnectivityPanel**

Create `Sources/Helmsman/Panels/Connectivity/ConnectivityPanel.swift`:

```swift
import SwiftUI

struct ConnectivityPanel: View {
    @Bindable var cache: ClusterCache
    let onSelectService: (_ name: String, _ namespace: String) -> Void
    let onSelectPods: (Connectivity.Flow) -> Void

    private var flows: [Connectivity.Flow] {
        Connectivity.flows(ingresses: cache.ingresses, services: cache.services, pods: cache.pods)
    }
    private var external: [Connectivity.Flow] { flows.filter { $0.isExternal } }
    private var internalFlows: [Connectivity.Flow] { flows.filter { !$0.isExternal } }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if flows.isEmpty {
                emptyState
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        if !external.isEmpty { section("External", "globe", external) }
                        if !internalFlows.isEmpty { section("Internal", "lock.fill", internalFlows) }
                    }
                    .padding(16)
                }
            }
        }
        .background(Theme.Surface.primary)
    }

    private var header: some View {
        HStack(spacing: 12) {
            PanelTitle(.connectivity)
            Spacer()
            legend
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.Border.subtle).frame(height: 1) }
    }

    private var legend: some View {
        HStack(spacing: 10) {
            swatch(.ok, "Reachable")
            swatch(.warn, "Degraded")
            swatch(.broken, "Broken")
        }
    }

    private func swatch(_ h: Connectivity.Health, _ label: String) -> some View {
        HStack(spacing: 4) {
            Circle().fill(ChartTheme.color(for: h)).frame(width: 8, height: 8)
            Text(label).font(Theme.Font.mono(9)).foregroundStyle(Theme.Foreground.tertiary)
        }
    }

    private func section(_ title: String, _ icon: String, _ rows: [Connectivity.Flow]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: icon).font(.system(size: 11)).foregroundStyle(Theme.Accent.primary)
                Text(title).font(Theme.Font.body(11, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.secondary).textCase(.uppercase).tracking(0.5)
                Text("\(rows.count)").font(Theme.Font.mono(10)).foregroundStyle(Theme.Foreground.tertiary)
            }
            VStack(spacing: 6) {
                ForEach(rows) { flow in
                    FlowRow(flow: flow, onSelectService: onSelectService, onSelectPods: onSelectPods)
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "arrow.triangle.branch").font(.system(size: 28)).foregroundStyle(Theme.Foreground.tertiary)
            Text("No services to map yet.").font(Theme.Font.body(13)).foregroundStyle(Theme.Foreground.secondary)
            Text("Connectivity traces ingress → service → pods so you can spot unreachable apps.")
                .font(Theme.Font.body(11)).foregroundStyle(Theme.Foreground.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct FlowRow: View {
    let flow: Connectivity.Flow
    let onSelectService: (_ name: String, _ namespace: String) -> Void
    let onSelectPods: (Connectivity.Flow) -> Void

    private var tint: Color { ChartTheme.color(for: flow.health) }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Rectangle().fill(tint).frame(width: 3, height: 16)
                if flow.isExternal {
                    chip(flow.hosts.isEmpty ? "(no host)" : flow.hosts.joined(separator: ", "), system: "globe", color: Theme.Foreground.secondary)
                    arrow
                    chip(flow.ingressNames.joined(separator: ", "), system: "signpost.right.fill", color: Theme.Foreground.secondary)
                    arrow
                } else {
                    chip("cluster", system: "lock.fill", color: Theme.Foreground.tertiary)
                    arrow
                }
                Button { onSelectService(flow.serviceName, flow.namespace) } label: {
                    chip("svc/\(flow.serviceName)", system: "network",
                         color: flow.serviceExists ? Theme.Foreground.primary : Theme.Status.failed)
                }.buttonStyle(.plain)
                arrow
                Button { onSelectPods(flow) } label: { podsChip }.buttonStyle(.plain)
                    .disabled(flow.totalPods == 0)
                Spacer()
                Text(flow.namespace).font(Theme.Font.mono(9)).foregroundStyle(Theme.Foreground.tertiary)
            }
            if !flow.issues.isEmpty {
                HStack(spacing: 5) {
                    Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 9)).foregroundStyle(tint)
                    Text(flow.issues.joined(separator: " · ")).font(Theme.Font.mono(10)).foregroundStyle(tint)
                }
                .padding(.leading, 9)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(Theme.Surface.elevated)
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm).strokeBorder(Theme.Border.subtle, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }

    private var arrow: some View {
        Image(systemName: "arrow.right").font(.system(size: 9)).foregroundStyle(Theme.Foreground.tertiary)
    }

    private var podsChip: some View {
        chip(flow.serviceExists ? "\(flow.readyPods)/\(flow.totalPods) pods" : "no service",
             system: "shippingbox.fill", color: tint)
    }

    private func chip(_ text: String, system: String, color: Color) -> some View {
        HStack(spacing: 4) {
            Image(systemName: system).font(.system(size: 9))
            Text(text).font(Theme.Font.mono(10)).lineLimit(1).truncationMode(.middle)
        }
        .foregroundStyle(color)
        .padding(.horizontal, 6).padding(.vertical, 3)
        .background(Theme.Surface.sunken)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }
}
```

- [ ] **Step 2: Repoint `ChartTheme.color(for:)` to `Connectivity.Health`**

In `Sources/Helmsman/Charts/ChartTheme.swift`, replace the `color(for health: Viz.PodHealth)` method with:

```swift
    static func color(for health: Connectivity.Health) -> Color {
        switch health {
        case .ok:     return Theme.Status.running
        case .warn:   return Theme.Status.pending
        case .broken: return Theme.Status.failed
        }
    }
```

Leave `loadColor(_:)` unchanged.

- [ ] **Step 3: Delete the treemap implementation**

```bash
git rm Sources/Helmsman/Charts/TreemapLayout.swift \
       Sources/Helmsman/Charts/ClusterTreemap.swift \
       Sources/Helmsman/Panels/Topology/TopologyPanel.swift \
       Tests/HelmsmanTests/TreemapLayoutTests.swift
```

Then in `Sources/Helmsman/Charts/Aggregations.swift`, delete the entire `// MARK: - Treemap model (Topology tab)` section — the `TreemapMetric` enum, `PodHealth` enum, `TreemapPod` struct, `TreemapNode` struct, and the `treemapModel(...)` function. Leave the other three sections (cluster totals, waste summary, event buckets) intact.

In `Tests/HelmsmanTests/VizAggregationsTests.swift`, delete the three treemap tests (`test_treemapModel_groupsByNodeWithValuesAndHealth`, `test_treemapModel_unscheduledPodsGrouped`, `test_treemapModel_memoryMetricUsesMemBytes`) and the now-unused private `pod(_:node:phase:restarts:)` fixture helper. Leave `node`, `nodeMetric`, `event`, `rsResult`, and `workload` helpers (still used by the remaining tests).

- [ ] **Step 4: Rename the PanelKind `.topology` → `.connectivity`**

In `Sources/Helmsman/Panels/PanelKind.swift`, replace every `.topology` occurrence:
- `case topology` → `case connectivity`
- Cluster nav group: `[.namespaces, .nodes, .connectivity, .rbac]`
- `icon`: `case .connectivity: return "arrow.triangle.branch"`
- `title`: `case .connectivity: return "Connectivity"`
- `subtitle`: `case .connectivity: return "Traffic & reachability"`
- `isNamespaceScoped` false branch: replace `.topology` with `.connectivity`

- [ ] **Step 5: Rewire MainWindow**

In `Sources/Helmsman/Shell/MainWindow.swift`, replace the entire `case .topology:` block in `panelView` with:

```swift
        case .connectivity:
            ConnectivityPanel(
                cache: cache,
                onSelectService: { name, _ in
                    servicesVM.search = name
                    selectedPanel = .services
                },
                onSelectPods: { flow in
                    podsVM.search = flow.podNames.first ?? flow.serviceName
                    selectedPanel = .pods
                }
            )
```

- [ ] **Step 6: Build + tests**

Run: `swift build`
Expected: Build complete, no errors (no lingering references to treemap symbols).

Run: `swift test`
Expected: All tests pass — `ConnectivityTests` (7), the trimmed `VizAggregationsTests` (treemap tests gone), `PanelKind` coverage test (every case incl. `.connectivity` appears once), and the full existing suite. No references to `TreemapLayoutTests`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(connectivity): replace topology treemap with ingress→service→pods map"
```

(Here `git add -A` is appropriate — the working tree should contain only this task's creates/edits/deletes.)

---

## Self-Review Notes (author)

- **Coverage:** external section (ingress→svc→pods), internal section (svc→pods), dangling-ingress broken rows, 0-ready/no-pods warnings, tap-to-jump (service→Services, pods→Pods) — all present. Empty state + legend included.
- **Dead code:** treemap layout/view/model/tests fully removed; `ChartTheme.color(for:)` repointed; `Viz.PodHealth` removed (only the treemap used it). `ChartTheme.loadColor` (RingGauge) and the cluster-totals/waste/event-bucket aggregations are untouched.
- **No new fetching:** reads `cache.ingresses`/`services`/`pods` only.
- **Types verified against source:** `Ingress.routes` (`IngressRoute{host,path,service,port}`), `Ingress.Spec/Rule/HTTP/Path/Backend/ServiceBackend/ServicePort`, `Service.Spec(type:clusterIP:selector:ports:externalName:externalIPs:)`, `Service.typeLabel`, `Pod`/`PodStatus`/`ContainerStatus`, `servicesVM.search`/`podsVM.search`.
```
