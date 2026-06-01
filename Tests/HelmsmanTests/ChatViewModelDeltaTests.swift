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
}
