import XCTest
@testable import Helmsman

final class ClaudeModelConfigTests: XCTestCase {
    func test_default_isOpusHigh() {
        XCTAssertEqual(ClaudeModelConfig.default.model, .opus)
        XCTAssertEqual(ClaudeModelConfig.default.effort, .high)
    }

    func test_cliAliasesMatchExpectedFlags() {
        XCTAssertEqual(ClaudeModel.opus.cliAlias, "opus")
        XCTAssertEqual(ClaudeModel.sonnet.cliAlias, "sonnet")
        XCTAssertEqual(ClaudeModel.haiku.cliAlias, "haiku")
        // --effort levels accepted by the CLI: low, medium, high, xhigh, max
        XCTAssertEqual(ClaudeEffort.allCases.map(\.cliLevel),
                       ["low", "medium", "high", "xhigh", "max"])
    }

    func test_shortLabel() {
        let cfg = ClaudeModelConfig(model: .sonnet, effort: .xhigh)
        XCTAssertEqual(cfg.shortLabel, "Sonnet 4.6 · Extra high")
    }

    func test_codableRoundTrip() throws {
        let cfg = ClaudeModelConfig(model: .haiku, effort: .max)
        let data = try JSONEncoder().encode(cfg)
        let decoded = try JSONDecoder().decode(ClaudeModelConfig.self, from: data)
        XCTAssertEqual(decoded, cfg)
    }
}

final class ClaudeSessionArgsTests: XCTestCase {
    func test_buildArguments_includesModelAndEffort() {
        let args = ClaudeSession.buildArguments(
            systemPrompt: "PROMPT",
            config: .default,
            allowedTools: [],
            mcpConfigPath: nil,
            resumingSessionId: nil
        )
        XCTAssertTrue(adjacent(args, "--model", "opus"))
        XCTAssertTrue(adjacent(args, "--effort", "high"))
        XCTAssertTrue(adjacent(args, "--append-system-prompt", "PROMPT"))
        // AskUserQuestion can't render in our headless session — keep it disallowed.
        XCTAssertTrue(adjacent(args, "--disallowedTools", "AskUserQuestion"))
        XCTAssertFalse(args.contains("--resume"))
        XCTAssertFalse(args.contains("--mcp-config"))
    }

    func test_buildArguments_respectsConfigAndResume() {
        let args = ClaudeSession.buildArguments(
            systemPrompt: "P",
            config: ClaudeModelConfig(model: .sonnet, effort: .max),
            allowedTools: ["Bash(kubectl get *)"],
            mcpConfigPath: "/tmp/mcp.json",
            resumingSessionId: "sess-123"
        )
        XCTAssertTrue(adjacent(args, "--model", "sonnet"))
        XCTAssertTrue(adjacent(args, "--effort", "max"))
        XCTAssertTrue(adjacent(args, "--allowedTools", "Bash(kubectl get *)"))
        XCTAssertTrue(adjacent(args, "--mcp-config", "/tmp/mcp.json"))
        XCTAssertTrue(adjacent(args, "--resume", "sess-123"))
    }

    /// True when `value` immediately follows `flag` in the argument vector.
    private func adjacent(_ args: [String], _ flag: String, _ value: String) -> Bool {
        for (i, a) in args.enumerated() where a == flag {
            if i + 1 < args.count && args[i + 1] == value { return true }
        }
        return false
    }
}
