import Foundation

/// Resolves update status for images the registry path couldn't handle
/// (`:latest`-pinned, unknown registry, odd tag schemes, or a fetch failure) by
/// asking a headless `claude -p` in one batched run. Claude may use web tools
/// to find the newest release; when it can't decide, the item stays `.unknown`.
struct ClaudeUpdateFallback {
    /// Injected for tests: runs `claude` and returns raw stdout. Defaults to a
    /// real subprocess.
    var runClaude: ([String]) async throws -> Data = { args in
        guard let bin = resolveBinary("claude") else { throw ClaudeFallbackError.claudeNotFound }
        return try await runProcess(bin, args: args)
    }

    enum ClaudeFallbackError: Error { case claudeNotFound }

    /// Resolve the given items. Always returns a status for every appID — items
    /// Claude can't speak to come back `.unknown`. Never throws; a failed run
    /// degrades to all-unknown.
    func resolve(_ items: [InstalledImage]) async -> [String: UpdateStatus] {
        guard !items.isEmpty else { return [:] }

        let prompt = Self.buildPrompt(items)
        let args = ["-p", prompt, "--output-format", "json", "--allowedTools", "WebSearch WebFetch"]

        let raw: Data
        do {
            raw = try await runClaude(args)
        } catch {
            return Self.allUnknown(items, reason: "update check assistant unavailable")
        }

        guard let verdicts = Self.parse(raw) else {
            return Self.allUnknown(items, reason: "could not read assistant response")
        }

        // Map verdicts (keyed by image) back onto appIDs.
        var out: [String: UpdateStatus] = [:]
        for item in items {
            if let v = verdicts[item.image] {
                if v.hasUpdate, let latest = v.latest, let current = v.current {
                    out[item.appID] = .updateAvailable(current: current, latest: latest)
                } else if let current = v.current {
                    out[item.appID] = .upToDate(current: current)
                } else {
                    out[item.appID] = .unknown(reason: "no version info")
                }
            } else {
                out[item.appID] = .unknown(reason: "not determined")
            }
        }
        return out
    }

    private static func allUnknown(_ items: [InstalledImage], reason: String) -> [String: UpdateStatus] {
        Dictionary(uniqueKeysWithValues: items.map { ($0.appID, .unknown(reason: reason)) })
    }

    // MARK: - Prompt + parsing

    static func buildPrompt(_ items: [InstalledImage]) -> String {
        let list = items.map { "- \($0.image)" }.joined(separator: "\n")
        return """
        You are checking self-hosted container images for newer STABLE releases.

        For each image below, determine the newest stable (non pre-release, non rc/alpha/beta) \
        version tag published for that repository, and whether the running tag is behind it. \
        Use web lookups if helpful. For `:latest`-pinned images, report the concrete newest \
        stable version as `latest` and set `hasUpdate` true only if you are confident a newer \
        release exists; otherwise leave `hasUpdate` false.

        Images:
        \(list)

        Reply with ONLY a JSON array, no prose, no code fence. One object per image, echoing \
        the image string exactly:
        [{"image":"<exact image string>","current":"<running tag or 'latest'>","latest":"<newest stable tag or null>","hasUpdate":true|false}]
        """
    }

    struct Verdict { let current: String?; let latest: String?; let hasUpdate: Bool }

    /// Parse the `claude -p --output-format json` envelope, then the JSON array
    /// the model returned inside its `result` text. Returns verdicts keyed by
    /// the echoed image string, or nil if nothing parseable was found.
    static func parse(_ raw: Data) -> [String: Verdict]? {
        // Outer envelope: { "result": "<assistant text>", ... }. Fall back to
        // treating the whole blob as the array if there's no envelope.
        var resultText: String
        if let env = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
           let result = env["result"] as? String {
            resultText = result
        } else {
            resultText = String(data: raw, encoding: .utf8) ?? ""
        }

        guard let arrayData = extractJSONArray(from: resultText) else { return nil }
        guard let arr = try? JSONSerialization.jsonObject(with: arrayData) as? [[String: Any]] else { return nil }

        var out: [String: Verdict] = [:]
        for obj in arr {
            guard let image = obj["image"] as? String else { continue }
            let current = obj["current"] as? String
            let latest = obj["latest"] as? String
            let hasUpdate = (obj["hasUpdate"] as? Bool) ?? false
            out[image] = Verdict(current: current, latest: latest, hasUpdate: hasUpdate)
        }
        return out.isEmpty ? nil : out
    }

    /// Pull the first balanced `[ ... ]` JSON array out of arbitrary text
    /// (tolerates a stray code fence or surrounding prose).
    private static func extractJSONArray(from text: String) -> Data? {
        guard let start = text.firstIndex(of: "["), let end = text.lastIndex(of: "]"), start < end else {
            return nil
        }
        return String(text[start...end]).data(using: .utf8)
    }
}
