import XCTest
@testable import Helmsman

final class ClarifyingQuestionTests: XCTestCase {

    /// Two question groups, one option chosen in each → a single message that
    /// pairs each group's full prose with its chosen answer, in order, blank-line
    /// separated. The second group's option carries an explicit `value`, so the
    /// richer value is sent rather than the short label.
    func test_combinedAnswer_pairsQuestionsWithChosenAnswers_inOrder() {
        let text = """
        ```question
        {"question":"Migration scope — move ClickHouse too?","options":[{"label":"Just Postgres for now"},{"label":"Both Postgres + ClickHouse"}]}
        ```
        ```question
        {"question":"Seed the new local-path volume how?","options":[{"label":"Fresh dump now"},{"label":"Use last night's dump","value":"Seed from last night's TrueNAS dump"}]}
        ```
        """
        let (_, _, questions) = SuggestedAction.parse(from: text)
        XCTAssertEqual(questions.count, 2)

        let selections: [UUID: UUID] = [
            questions[0].id: questions[0].options[1].id,   // "Both Postgres + ClickHouse"
            questions[1].id: questions[1].options[1].id,   // value → "Seed from last night's TrueNAS dump"
        ]

        let combined = ClarifyingQuestion.combinedAnswer(questions: questions, selections: selections)

        XCTAssertEqual(combined, """
        > Migration scope — move ClickHouse too?
        Both Postgres + ClickHouse

        > Seed the new local-path volume how?
        Seed from last night's TrueNAS dump
        """)
    }

    /// A question whose selection is missing (shouldn't happen once Submit gates
    /// on completeness, but the builder must not crash) is skipped, not rendered
    /// with an empty answer.
    func test_combinedAnswer_skipsUnansweredGroups() {
        let text = """
        ```question
        {"question":"First?","options":[{"label":"A"},{"label":"B"}]}
        ```
        ```question
        {"question":"Second?","options":[{"label":"C"},{"label":"D"}]}
        ```
        """
        let (_, _, questions) = SuggestedAction.parse(from: text)
        let selections: [UUID: UUID] = [questions[1].id: questions[1].options[0].id]

        let combined = ClarifyingQuestion.combinedAnswer(questions: questions, selections: selections)

        XCTAssertEqual(combined, """
        > Second?
        C
        """)
    }
}
