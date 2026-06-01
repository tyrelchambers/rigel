import XCTest
@testable import Helmsman

@MainActor
final class ChatViewModelDeltaTests: XCTestCase {
    func test_textDeltas_assembleIntoOneAssistantBubble() {
        let vm = ChatViewModel()
        vm.handle(.textDelta("Hello"))
        vm.handle(.textDelta(", world"))
        XCTAssertEqual(vm.messages.count, 1)
        XCTAssertEqual(vm.messages[0].role, .assistant)
        XCTAssertEqual(vm.messages[0].text, "Hello, world")
    }

    func test_thinkingDeltas_accumulateInLiveThinking_notInMessages() {
        let vm = ChatViewModel()
        vm.handle(.thinkingDelta("Check the "))
        vm.handle(.thinkingDelta("digest"))
        XCTAssertTrue(vm.isThinking)
        XCTAssertEqual(vm.liveThinking, "Check the digest")
        XCTAssertTrue(vm.messages.isEmpty)
    }

    func test_result_stampsThinkingOntoLastAssistantMessageAndClearsLive() {
        let vm = ChatViewModel()
        vm.isStreaming = true
        vm.handle(.thinkingDelta("Reasoning here"))
        vm.handle(.textDelta("Answer"))
        vm.handle(.result(sessionId: "s1", costUSD: nil))
        XCTAssertFalse(vm.isStreaming)
        XCTAssertEqual(vm.liveThinking, "")
        XCTAssertFalse(vm.isThinking)
        XCTAssertEqual(vm.messages.last?.thinking, "Reasoning here")
        XCTAssertNotNil(vm.messages.last?.thinkingSeconds)
    }

    func test_toolUseBetweenText_opensNewBubbleAfterTool() {
        let vm = ChatViewModel()
        vm.handle(.textDelta("Before"))
        vm.handle(.toolUse(id: "t1", name: "Bash", input: ["command": "ls"]))
        vm.handle(.textDelta("After"))
        XCTAssertEqual(vm.messages.count, 3)
        XCTAssertEqual(vm.messages[0].text, "Before")
        XCTAssertNotNil(vm.messages[1].tool)
        XCTAssertEqual(vm.messages[2].text, "After")
    }

    func test_resultWithoutThinking_leavesMessageThinkingNil() {
        let vm = ChatViewModel()
        vm.isStreaming = true
        vm.handle(.textDelta("Just an answer"))
        vm.handle(.result(sessionId: "s1", costUSD: nil))
        XCTAssertNil(vm.messages.last?.thinking)
    }

    func test_toolOnlyTurn_doesNotOverwritePriorTurnThinking() {
        let vm = ChatViewModel()
        // Turn 1: an answer that captured reasoning.
        vm.handle(.thinkingDelta("turn 1 reasoning"))
        vm.handle(.textDelta("Turn 1 answer"))
        vm.handle(.result(sessionId: "s", costUSD: nil))
        XCTAssertEqual(vm.messages[0].thinking, "turn 1 reasoning")

        // Turn 2: reasoning then a tool call, NO answer text bubble.
        vm.handle(.thinkingDelta("turn 2 reasoning"))
        vm.handle(.toolUse(id: "t1", name: "Bash", input: ["command": "ls"]))
        vm.handle(.result(sessionId: "s", costUSD: nil))

        // Turn 1's message must be untouched; turn 2's reasoning is discarded.
        XCTAssertEqual(vm.messages[0].thinking, "turn 1 reasoning")
        XCTAssertEqual(vm.liveThinking, "")
        XCTAssertFalse(vm.isThinking)
    }

    func test_resultAfterThinking_doesNotLeakIntoNextTurn() {
        let vm = ChatViewModel()
        // Turn 1 captures reasoning and completes.
        vm.isStreaming = true
        vm.turnStartedAt = Date()
        vm.handle(.thinkingDelta("turn 1 reasoning"))
        vm.handle(.textDelta("Turn 1 answer"))
        vm.handle(.result(sessionId: "s", costUSD: nil))
        XCTAssertEqual(vm.liveThinking, "")
        XCTAssertFalse(vm.isThinking)

        // A user message arrives for turn 2 (this is what really separates turns —
        // it breaks the assistant-bubble merge chain, just like send() does).
        vm.messages.append(ChatMessage(role: .user, text: "follow-up"))

        // Turn 2's reasoning must start clean — none of turn 1's text carries over,
        // and turn 2's reasoning stamps only onto turn 2's answer (a fresh bubble).
        vm.handle(.thinkingDelta("turn 2 reasoning"))
        XCTAssertEqual(vm.liveThinking, "turn 2 reasoning")
        vm.handle(.textDelta("Turn 2 answer"))
        vm.handle(.result(sessionId: "s", costUSD: nil))
        XCTAssertEqual(vm.messages[0].thinking, "turn 1 reasoning")
        XCTAssertEqual(vm.messages[0].text, "Turn 1 answer")
        XCTAssertEqual(vm.messages.last?.thinking, "turn 2 reasoning")
        XCTAssertEqual(vm.messages.last?.text, "Turn 2 answer")
    }

    func test_result_computesThinkingSecondsFromTurnStart() {
        let vm = ChatViewModel()
        vm.isStreaming = true
        vm.turnStartedAt = Date().addingTimeInterval(-3)
        vm.handle(.thinkingDelta("Reasoning"))
        vm.handle(.textDelta("Answer"))
        vm.handle(.result(sessionId: "s1", costUSD: nil))
        XCTAssertEqual(vm.messages.last?.thinking, "Reasoning")
        XCTAssertGreaterThanOrEqual(vm.messages.last?.thinkingSeconds ?? -1, 2)
    }
}
