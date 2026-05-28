import Foundation

enum KubectlClientError: Error, CustomStringConvertible {
    case kubectlNotFound
    case decoding(underlying: Error, raw: String)

    var description: String {
        switch self {
        case .kubectlNotFound: return "kubectl not found on PATH"
        case .decoding(let err, let raw):
            return "kubectl output decode failed: \(err)\nraw: \(raw.prefix(500))"
        }
    }
}

actor KubectlClient {
    nonisolated let kubectl: String   // immutable, accessed sync from MainWindow handoff
    private(set) var context: String?

    init(context: String? = nil) throws {
        guard let path = resolveBinary("kubectl") else {
            throw KubectlClientError.kubectlNotFound
        }
        self.kubectl = path
        self.context = context
    }

    func setContext(_ ctx: String?) { self.context = ctx }

    private func contextArgs() -> [String] {
        context.map { ["--context", $0] } ?? []
    }

    /// One-shot get.
    func getList<T: Codable>(_ resource: String, namespace: String? = nil, type: T.Type = T.self) async throws -> KubeList<T> {
        var args = contextArgs() + ["get", resource, "-o", "json"]
        if let ns = namespace { args.append(contentsOf: ["-n", ns]) } else { args.append("-A") }

        let data = try await runProcess(kubectl, args: args)
        do {
            return try JSONDecoder.kube.decode(KubeList<T>.self, from: data)
        } catch {
            throw KubectlClientError.decoding(underlying: error, raw: String(data: data, encoding: .utf8) ?? "")
        }
    }

    /// Hit a raw API path (e.g. /apis/metrics.k8s.io/v1beta1/nodes) and decode.
    /// Returns nil if metrics-server is unavailable (404/exit non-zero).
    func getRaw<T: Decodable>(_ path: String, type: T.Type = T.self) async throws -> T? {
        let args = contextArgs() + ["get", "--raw", path]
        do {
            let data = try await runProcess(kubectl, args: args)
            return try JSONDecoder.kube.decode(T.self, from: data)
        } catch ProcessError.nonZeroExit {
            return nil
        }
    }

    /// Long-lived watch. Returns an AsyncThrowingStream of typed WatchEvent values.
    /// On crash, the stream finishes — callers are responsible for restart backoff.
    nonisolated func watch<T: Codable & Sendable>(_ resource: String, namespace: String? = nil, type: T.Type = T.self) -> AsyncThrowingStream<WatchEvent<T>, Error> {
        AsyncThrowingStream { continuation in
            Task {
                let ctxArgs = await contextArgs()
                var args = ctxArgs + ["get", resource, "--watch", "--output-watch-events=true", "-o", "json"]
                if let ns = namespace { args.append(contentsOf: ["-n", ns]) } else { args.append("-A") }

                let proc = Process()
                proc.executableURL = URL(fileURLWithPath: kubectl)
                proc.arguments = args
                let outPipe = Pipe()
                let errPipe = Pipe()
                proc.standardOutput = outPipe
                proc.standardError = errPipe

                continuation.onTermination = { _ in
                    if proc.isRunning { proc.terminate() }
                }

                var parser = KubectlStreamParser()
                outPipe.fileHandleForReading.readabilityHandler = { handle in
                    let chunk = handle.availableData
                    guard !chunk.isEmpty else { return }
                    parser.feed(chunk) { valueData in
                        do {
                            let event = try JSONDecoder.kube.decode(WatchEvent<T>.self, from: valueData)
                            continuation.yield(event)
                        } catch {
                            continuation.finish(throwing: KubectlClientError.decoding(underlying: error, raw: String(data: valueData, encoding: .utf8) ?? ""))
                        }
                    }
                }

                proc.terminationHandler = { _ in
                    outPipe.fileHandleForReading.readabilityHandler = nil
                    continuation.finish()
                }

                do {
                    try proc.run()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }
}
