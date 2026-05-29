import XCTest
@testable import Helmsman

final class ChatCommandTests: XCTestCase {

    // MARK: - Parsing (registry-driven)

    func test_parse_nameAndAlias() {
        XCTAssertEqual(SlashCommand.parse("/help"), .help)
        XCTAssertEqual(SlashCommand.parse("/?"), .help)            // alias
        XCTAssertEqual(SlashCommand.parse("/clear"), .clear)
        XCTAssertEqual(SlashCommand.parse("/investigate"), .investigate)
        XCTAssertEqual(SlashCommand.parse("/tail web"), .logs(name: "web"))  // alias + arg
    }

    func test_parse_argsOptional() {
        XCTAssertEqual(SlashCommand.parse("/logs"), .logs(name: nil))
        XCTAssertEqual(SlashCommand.parse("/logs   "), .logs(name: nil))
        XCTAssertEqual(SlashCommand.parse("/restart api"), .restart(name: "api"))
        XCTAssertEqual(SlashCommand.parse("/describe my-pod"), .describe(name: "my-pod"))
    }

    func test_parse_caseInsensitiveAndNonCommands() {
        XCTAssertEqual(SlashCommand.parse("/HELP"), .help)
        XCTAssertNil(SlashCommand.parse("hello"))         // no slash
        XCTAssertNil(SlashCommand.parse("/bogus"))        // unknown command
        XCTAssertNil(SlashCommand.parse("/"))             // bare slash
    }

    // MARK: - Registry ↔ dispatch stay in sync

    func test_everyRegisteredCommandParses() {
        for spec in ChatCommandRegistry.all {
            XCTAssertNotNil(SlashCommand.parse("/\(spec.name)"),
                            "registered command /\(spec.name) must parse")
            for alias in spec.aliases {
                XCTAssertNotNil(SlashCommand.parse("/\(alias)"),
                                "alias /\(alias) must parse")
            }
        }
    }

    // MARK: - Help is generated from the registry

    func test_helpText_coversEveryCommand() {
        let help = SlashCommand.helpText
        for spec in ChatCommandRegistry.all {
            XCTAssertTrue(help.contains("/\(spec.name)"), "help must list /\(spec.name)")
            XCTAssertTrue(help.contains(spec.description), "help must include the description of \(spec.name)")
        }
    }

    // MARK: - Popover filter

    func test_filter_prefixAndAliasAndEmpty() {
        XCTAssertEqual(ChatCommandRegistry.filter("").count, ChatCommandRegistry.all.count)  // empty → all
        XCTAssertEqual(ChatCommandRegistry.filter("lo").first?.name, "logs")                 // prefix
        XCTAssertEqual(ChatCommandRegistry.filter("tail").first?.name, "logs")               // alias match
        XCTAssertTrueContains(ChatCommandRegistry.filter("res"), name: "restart")            // prefix
        XCTAssertTrue(ChatCommandRegistry.filter("zzzz").isEmpty)                            // no match
    }

    private func XCTAssertTrueContains(_ specs: [ChatCommandSpec], name: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(specs.contains { $0.name == name }, "expected \(name) in results", file: file, line: line)
    }

    func test_spec_displayAndInsertion() {
        let logs = ChatCommandRegistry.spec(forHead: "logs")!
        XCTAssertEqual(logs.display, "/logs <deployment>")
        XCTAssertEqual(logs.insertion, "/logs ")
        let help = ChatCommandRegistry.spec(forHead: "help")!
        XCTAssertEqual(help.display, "/help")          // no arg hint
    }
}
