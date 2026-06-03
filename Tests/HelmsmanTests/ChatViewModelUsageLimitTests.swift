import XCTest
@testable import Helmsman

@MainActor
final class ChatViewModelUsageLimitTests: XCTestCase {
    func test_usageLimit_setsState_clearsStreaming_appendsSystemMessage() {
        let vm = ChatViewModel()
        vm.isStreaming = true
        vm.handle(.textDelta("partial answer"))
        let reset = Date(timeIntervalSince1970: 1_900_000_000)
        vm.handle(.usageLimit(resetAt: reset))

        XCTAssertFalse(vm.isStreaming)
        XCTAssertEqual(vm.usageLimit?.resetAt, reset)
        XCTAssertEqual(vm.messages.last?.role, .system)
        XCTAssertTrue(vm.messages.last?.text.contains("usage limit") ?? false)
    }

    func test_usageLimit_withNilReset_stillSetsState() {
        let vm = ChatViewModel()
        vm.handle(.usageLimit(resetAt: nil))
        XCTAssertNotNil(vm.usageLimit)
        XCTAssertNil(vm.usageLimit?.resetAt)
    }

    func test_successfulResult_clearsUsageLimit() {
        let vm = ChatViewModel()
        vm.handle(.usageLimit(resetAt: Date(timeIntervalSince1970: 1_900_000_000)))
        XCTAssertNotNil(vm.usageLimit)
        vm.handle(.result(sessionId: "s1", costUSD: nil))
        XCTAssertNil(vm.usageLimit)
    }

    func test_clear_clearsUsageLimit() {
        let vm = ChatViewModel()
        vm.handle(.usageLimit(resetAt: nil))
        vm.clear()
        XCTAssertNil(vm.usageLimit)
    }
}
