import Foundation

/// Lifecycle events emitted by a running `kubectl port-forward`.
enum PortForwardEvent: Sendable {
    /// kubectl printed "Forwarding from 127.0.0.1:<local> -> <remote>" — the
    /// local socket is listening and ready to use.
    case ready
    /// The process exited or failed to start. Carries kubectl's stderr (e.g.
    /// "Unable to listen on port 8080: ... address already in use").
    case failed(String)
    /// The process ended cleanly (e.g. terminated by us).
    case ended
}

/// A single long-lived `kubectl port-forward svc/<name> <local>:<remote>`.
/// Modeled on `LogStream`: a nonisolated `stream()` launches the process and
/// yields `PortForwardEvent`s; `terminate()` kills it. The local socket lives
/// for as long as the process runs.
actor PortForwardSession {
    nonisolated let kubectl: String
    nonisolated let context: String?
    nonisolated let targetKind: String   // "svc" | "pod"
    nonisolated let targetName: String
    nonisolated let namespace: String
    nonisolated let localPort: Int
    nonisolated let remotePort: Int
    private var proc: Process?

    init(targetKind: String, targetName: String, namespace: String, localPort: Int, remotePort: Int, context: String?) throws {
        guard let path = resolveBinary("kubectl") else { throw KubectlClientError.kubectlNotFound }
        self.kubectl = path
        self.context = context
        self.targetKind = targetKind
        self.targetName = targetName
        self.namespace = namespace
        self.localPort = localPort
        self.remotePort = remotePort
    }

    nonisolated func stream() -> AsyncStream<PortForwardEvent> {
        AsyncStream { continuation in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: kubectl)
            var args: [String] = []
            if let context { args.append(contentsOf: ["--context", context]) }
            args.append(contentsOf: [
                "port-forward", "\(targetKind)/\(targetName)", "\(localPort):\(remotePort)",
                "-n", namespace,
            ])
            p.arguments = args

            let outPipe = Pipe()
            let errPipe = Pipe()
            p.standardOutput = outPipe
            p.standardError = errPipe

            // kubectl writes "Forwarding from 127.0.0.1:<port> -> <remote>" to
            // stdout once the listener is up. Yield .ready on the first sighting.
            let readyBox = ReadyFlag()
            outPipe.fileHandleForReading.readabilityHandler = { handle in
                let chunk = handle.availableData
                if chunk.isEmpty { handle.readabilityHandler = nil; return }
                if let s = String(data: chunk, encoding: .utf8),
                   s.contains("Forwarding from"),
                   readyBox.markOnce() {
                    continuation.yield(.ready)
                }
            }

            let errBox = OutputBox()
            errPipe.fileHandleForReading.readabilityHandler = { handle in
                let chunk = handle.availableData
                if chunk.isEmpty { handle.readabilityHandler = nil; return }
                errBox.append(chunk)
            }

            p.terminationHandler = { proc in
                outPipe.fileHandleForReading.readabilityHandler = nil
                errPipe.fileHandleForReading.readabilityHandler = nil
                let stderr = String(data: errBox.data, encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if proc.terminationStatus != 0 {
                    continuation.yield(.failed(stderr.isEmpty ? "port-forward exited \(proc.terminationStatus)" : stderr))
                } else {
                    continuation.yield(.ended)
                }
                continuation.finish()
            }

            continuation.onTermination = { _ in
                if p.isRunning { p.terminate() }
            }

            do {
                try p.run()
                Task { await self.setProc(p) }
            } catch {
                continuation.yield(.failed("failed to launch kubectl: \(error)"))
                continuation.finish()
            }
        }
    }

    private func setProc(_ p: Process) { self.proc = p }

    func terminate() {
        if let p = proc, p.isRunning { p.terminate() }
        proc = nil
    }
}

/// One-shot latch so the stdout handler yields `.ready` exactly once, even
/// though kubectl prints a Forwarding line per address family (IPv4 + IPv6).
private final class ReadyFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false
    func markOnce() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if fired { return false }
        fired = true
        return true
    }
}
