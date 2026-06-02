import XCTest
@testable import Helmsman

final class ChatTranscriptTests: XCTestCase {
    private func bashTool() -> ToolInvocation {
        ToolInvocation(toolUseId: "t1", name: "Bash", inputJSON: "{}",
                       bashCommand: "ls", bashDescription: nil)
    }

    func test_emptyConversation_isEmptyString() {
        XCTAssertEqual(ChatViewModel.transcript(of: []), "")
    }

    func test_rolesAreLabelledAndBlankLineSeparated() {
        let msgs = [
            ChatMessage(role: .user, text: "deploy the app"),
            ChatMessage(role: .assistant, text: "Done."),
            ChatMessage(role: .system, text: "context cleared"),
        ]
        let t = ChatViewModel.transcript(of: msgs)
        XCTAssertEqual(t, "You:\ndeploy the app\n\nHelmsman:\nDone.\n\nSystem:\ncontext cleared")
    }

    func test_assistantActionBlocksAreStripped() {
        let msgs = [
            ChatMessage(role: .assistant, text: "Here is the plan.\n```action\n{\"label\":\"x\"}\n```"),
        ]
        let t = ChatViewModel.transcript(of: msgs)
        XCTAssertTrue(t.contains("Helmsman:\nHere is the plan."))
        XCTAssertFalse(t.contains("\"label\""))
        XCTAssertFalse(t.contains("```"))
    }

    func test_toolMessagesAreSkipped() {
        let msgs = [
            ChatMessage(role: .user, text: "what's running?"),
            ChatMessage(role: .assistant, text: "", tool: bashTool()),
            ChatMessage(role: .assistant, text: "Two pods."),
        ]
        let t = ChatViewModel.transcript(of: msgs)
        XCTAssertEqual(t, "You:\nwhat's running?\n\nHelmsman:\nTwo pods.")
        XCTAssertFalse(t.contains("Bash"))
    }

    func test_messagesWithEmptyDisplayAreSkipped() {
        let msgs = [
            ChatMessage(role: .assistant, text: "   "),
            ChatMessage(role: .user, text: "hi"),
        ]
        XCTAssertEqual(ChatViewModel.transcript(of: msgs), "You:\nhi")
    }
}
