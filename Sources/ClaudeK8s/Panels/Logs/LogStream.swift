import Foundation

actor LogStream {
    nonisolated let kubectl: String
    nonisolated let context: String?
    nonisolated let namespace: String
    nonisolated let labelSelector: String
    nonisolated let streamKey: String
    private var proc: Process?

    init(namespace: String, labelSelector: String, streamKey: String, context: String?) throws {
        guard let path = resolveBinary("kubectl") else { throw KubectlClientError.kubectlNotFound }
        self.kubectl = path
        self.context = context
        self.namespace = namespace
        self.labelSelector = labelSelector
        self.streamKey = streamKey
    }

    /// Starts `kubectl logs -f -l <selector> --prefix --timestamps --all-containers` and
    /// returns a stream of LogLine values. Each line is prefixed by kubectl with
    /// `[pod/<name>/<container>]` — LogLineParser strips that into LogLine.sourcePod.
    nonisolated func stream() -> AsyncStream<LogLine> {
        AsyncStream { continuation in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: kubectl)
            var args: [String] = []
            if let context { args.append(contentsOf: ["--context", context]) }
            args.append(contentsOf: [
                "logs", "-f", "--timestamps", "--prefix=true", "--all-containers=true",
                "-n", namespace, "-l", labelSelector,
                "--max-log-requests=20",
                "--tail=200",
            ])
            p.arguments = args

            let outPipe = Pipe()
            p.standardOutput = outPipe
            p.standardError = Pipe()

            var parser = LogLineStreamParser(sourcePod: streamKey, colorIndex: 0)
            outPipe.fileHandleForReading.readabilityHandler = { handle in
                let chunk = handle.availableData
                if chunk.isEmpty {
                    handle.readabilityHandler = nil
                    return
                }
                parser.feed(chunk) { line in continuation.yield(line) }
            }

            p.terminationHandler = { _ in
                outPipe.fileHandleForReading.readabilityHandler = nil
                continuation.finish()
            }

            continuation.onTermination = { _ in
                if p.isRunning { p.terminate() }
            }

            do {
                try p.run()
                Task { await self.setProc(p) }
            } catch {
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
