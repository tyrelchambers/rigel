import XCTest
@testable import Helmsman

final class LogNoiseFilterTests: XCTestCase {
    func test_dropsKubeProbeUserAgent() {
        let line = LogLine(sourcePod: "x", timestamp: nil, text: #"10.42.0.1 - - "GET / HTTP/1.1" 200 612 "-" "kube-probe/1.30""#, colorIndex: 0)
        XCTAssertTrue(LogNoiseFilter.isProbe(line))
    }

    func test_dropsCommonHealthPaths() {
        for path in ["/healthz", "/health", "/ready", "/readyz", "/live", "/livez"] {
            let line = LogLine(sourcePod: "x", timestamp: nil, text: #"172.16.0.1 - - "GET \#(path) HTTP/1.1" 200"#, colorIndex: 0)
            XCTAssertTrue(LogNoiseFilter.isProbe(line), "expected probe detection for \(path)")
        }
    }

    func test_keepsRegularRequests() {
        let line = LogLine(sourcePod: "x", timestamp: nil, text: #"203.0.113.5 - - "GET /api/v1/notes HTTP/1.1" 200 1532 "-" "Mozilla/5.0""#, colorIndex: 0)
        XCTAssertFalse(LogNoiseFilter.isProbe(line))
    }

    func test_keepsErrorLines() {
        let line = LogLine(sourcePod: "x", timestamp: nil, text: "ERROR: connection refused", colorIndex: 0)
        XCTAssertFalse(LogNoiseFilter.isProbe(line))
    }
}
