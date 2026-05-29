import Foundation

/// Current (parsed) resource settings for one container.
struct ContainerResources: Sendable, Hashable {
    let container: String
    let cpuRequest: Double?   // cores, nil = unset
    let cpuLimit: Double?
    let memRequest: Double?   // bytes, nil = unset
    let memLimit: Double?
}

enum RightSizingVerdict: String, Sendable {
    case ok                 // within sensible bounds
    case overProvisioned    // requesting far more than used → reclaimable waste
    case atRisk             // usage near/over a limit → OOM/throttle danger
    case unset              // missing requests and/or limits
    case insufficientData   // not enough history yet to judge

    var label: String {
        switch self {
        case .ok: return "OK"
        case .overProvisioned: return "Over-provisioned"
        case .atRisk: return "At risk"
        case .unset: return "No requests/limits"
        case .insufficientData: return "Gathering data"
        }
    }
}

struct RightSizingResult: Sendable, Hashable {
    let container: String
    let verdict: RightSizingVerdict
    let hoursCovered: Int

    let cpuPeak: Double
    let cpuTypical: Double
    let memPeak: Double
    let memTypical: Double

    let cpuRequest: Double?
    let cpuLimit: Double?
    let memRequest: Double?
    let memLimit: Double?

    // Suggested targets (nil when data is insufficient).
    let suggestedCpuRequest: Double?
    let suggestedCpuLimit: Double?
    let suggestedMemRequest: Double?
    let suggestedMemLimit: Double?

    let rationale: String

    var hasSuggestion: Bool { suggestedMemRequest != nil }
}

enum RightSizing {
    static let minHours = 24

    // Headroom applied above observed usage when suggesting.
    static let cpuLimitHeadroom = 1.5      // CPU is compressible → generous burst room
    static let memLimitHeadroom = 1.2      // memory is hard → modest OOM cushion

    // Verdict thresholds.
    static let atRiskMemFraction = 0.9     // peak ≥ 90% of mem limit → risk
    static let atRiskCpuFraction = 0.95    // peak ≥ 95% of cpu limit → throttling
    static let overMemRatio = 2.0          // request > 2× typical → wasteful
    static let overCpuRatio = 3.0          // request > 3× typical → wasteful
    static let minMemSlack = 128.0 * 1024 * 1024   // ignore <128Mi of waste
    static let minCpuSlack = 0.1                    // ignore <100m of waste

    /// Analyze one container against its observed window. Pure — no I/O.
    static func analyze(current: ContainerResources, stats: WindowStats, minHours: Int = minHours) -> RightSizingResult {
        let base = { (verdict: RightSizingVerdict,
                      sCpuReq: Double?, sCpuLim: Double?, sMemReq: Double?, sMemLim: Double?,
                      rationale: String) in
            RightSizingResult(
                container: current.container, verdict: verdict, hoursCovered: stats.hoursCovered,
                cpuPeak: stats.cpuPeak, cpuTypical: stats.cpuTypical,
                memPeak: stats.memPeak, memTypical: stats.memTypical,
                cpuRequest: current.cpuRequest, cpuLimit: current.cpuLimit,
                memRequest: current.memRequest, memLimit: current.memLimit,
                suggestedCpuRequest: sCpuReq, suggestedCpuLimit: sCpuLim,
                suggestedMemRequest: sMemReq, suggestedMemLimit: sMemLim,
                rationale: rationale
            )
        }

        guard stats.hoursCovered >= minHours else {
            return base(.insufficientData, nil, nil, nil, nil,
                        "Only \(stats.hoursCovered)h of history (need \(minHours)h).")
        }

        // Suggestions from observed usage.
        let sCpuReq = max(stats.cpuTypical, 0.01)
        let sCpuLim = max(stats.cpuPeak * cpuLimitHeadroom, sCpuReq)
        let sMemReq = max(stats.memTypical, 1)
        let sMemLim = max(stats.memPeak * memLimitHeadroom, sMemReq)

        // Verdict — risk first, then unset, then waste, else ok.
        if let memLim = current.memLimit, stats.memPeak >= memLim * atRiskMemFraction {
            return base(.atRisk, sCpuReq, sCpuLim, sMemReq, sMemLim,
                        "Peak memory is within \(Int((1 - atRiskMemFraction) * 100))% of the limit — OOM risk.")
        }
        if let cpuLim = current.cpuLimit, stats.cpuPeak >= cpuLim * atRiskCpuFraction {
            return base(.atRisk, sCpuReq, sCpuLim, sMemReq, sMemLim,
                        "Peak CPU is at the limit — likely throttling.")
        }
        if current.memRequest == nil || current.cpuRequest == nil || current.memLimit == nil || current.cpuLimit == nil {
            return base(.unset, sCpuReq, sCpuLim, sMemReq, sMemLim,
                        "Missing requests and/or limits — the scheduler can't bin-pack or protect this container.")
        }
        let memWasteful = (current.memRequest! > stats.memTypical * overMemRatio)
            && (current.memRequest! - stats.memTypical > minMemSlack)
        let cpuWasteful = (current.cpuRequest! > stats.cpuTypical * overCpuRatio)
            && (current.cpuRequest! - stats.cpuTypical > minCpuSlack)
        if memWasteful || cpuWasteful {
            return base(.overProvisioned, sCpuReq, sCpuLim, sMemReq, sMemLim,
                        "Requests are well above real usage — capacity is being reserved but not used.")
        }
        return base(.ok, sCpuReq, sCpuLim, sMemReq, sMemLim, "Requests and limits track observed usage.")
    }
}
