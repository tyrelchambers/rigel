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

    // MARK: - Field parsing (docs/parity/chat-input-fields.md § 2)

    /// A well-formed option with two fields yields both with correct
    /// name/label/placeholder/required, in array order.
    func test_fields_parsedWithAllAttributes_inOrder() {
        let text = """
        ```question
        {"question":"Ingress?","options":[{"label":"Deploy","value":"Deploy it","fields":[{"name":"hostname","label":"Public hostname","placeholder":"affine.example.com","required":true},{"name":"port","label":"Service port","placeholder":"3010","required":false}]}]}
        ```
        """
        let (_, _, questions) = SuggestedAction.parse(from: text)
        let fields = questions[0].options[0].fields
        XCTAssertEqual(fields.count, 2)
        XCTAssertEqual(fields[0].name, "hostname")
        XCTAssertEqual(fields[0].label, "Public hostname")
        XCTAssertEqual(fields[0].placeholder, "affine.example.com")
        XCTAssertTrue(fields[0].required)
        XCTAssertEqual(fields[1].name, "port")
        XCTAssertFalse(fields[1].required)
    }

    /// `required` defaults to true when absent; an explicit `false` is honored.
    func test_fields_requiredDefaultsTrue_explicitFalseHonored() {
        let text = """
        ```question
        {"question":"Q?","options":[{"label":"A","fields":[{"name":"a"},{"name":"b","required":false}]}]}
        ```
        """
        let (_, _, questions) = SuggestedAction.parse(from: text)
        let fields = questions[0].options[0].fields
        XCTAssertTrue(fields[0].required, "absent required → true")
        XCTAssertFalse(fields[1].required, "explicit false honored")
    }

    /// A field that is not an object, or lacks a string `name`, is dropped;
    /// surviving fields keep their order.
    func test_fields_malformedDropped_survivorsKeptInOrder() {
        let text = """
        ```question
        {"question":"Q?","options":[{"label":"A","fields":[{"name":"keep1"},"nope",{"label":"no name"},{"name":42},{"name":"keep2"}]}]}
        ```
        """
        let (_, _, questions) = SuggestedAction.parse(from: text)
        let fields = questions[0].options[0].fields
        XCTAssertEqual(fields.map(\.name), ["keep1", "keep2"])
    }

    /// An option whose every field is malformed parses with NO fields (plain
    /// instant-send) yet still renders the option.
    func test_fields_allDropped_degradesToPlainOption() {
        let text = """
        ```question
        {"question":"Q?","options":[{"label":"A","fields":[{"label":"no name"},123]}]}
        ```
        """
        let (_, _, questions) = SuggestedAction.parse(from: text)
        XCTAssertEqual(questions[0].options.count, 1)
        XCTAssertFalse(questions[0].options[0].hasFields)
    }

    /// A non-array `fields` is ignored; the option degrades to plain.
    func test_fields_nonArray_ignored() {
        let text = """
        ```question
        {"question":"Q?","options":[{"label":"A","fields":"oops"}]}
        ```
        """
        let (_, _, questions) = SuggestedAction.parse(from: text)
        XCTAssertEqual(questions[0].options.count, 1)
        XCTAssertFalse(questions[0].options[0].hasFields)
    }

    /// An empty `fields: []` degrades to plain.
    func test_fields_emptyArray_degradesToPlain() {
        let text = """
        ```question
        {"question":"Q?","options":[{"label":"A","fields":[]}]}
        ```
        """
        let (_, _, questions) = SuggestedAction.parse(from: text)
        XCTAssertFalse(questions[0].options[0].hasFields)
    }

    // MARK: - buildQuestionAnswer (docs/parity/chat-input-fields.md § 3)

    /// Fieldless option → byte-identical to today's `> question\n value??label`.
    func test_buildQuestionAnswer_fieldless_matchesLegacyOutput() {
        let text = """
        ```question
        {"question":"How to proceed?","options":[{"label":"Both","value":"Do both"}]}
        ```
        """
        let (_, _, questions) = SuggestedAction.parse(from: text)
        let answer = ClarifyingQuestion.buildQuestionAnswer(
            question: questions[0].question, option: questions[0].options[0], values: [:])
        XCTAssertEqual(answer, """
        > How to proceed?
        Do both
        """)
    }

    /// With values: emits `> question`, the option answer, then `name: value`
    /// lines in field order. Matches the web worked example § 3 byte-for-byte.
    func test_buildQuestionAnswer_withValues_emitsNamedLinesInOrder() {
        let text = """
        ```question
        {"question":"There's no AFFiNE in the cluster yet. How should I handle the Traefik ingress?","options":[{"label":"Deploy AFFiNE too","value":"Deploy AFFiNE and expose it","fields":[{"name":"hostname"},{"name":"port","required":false}]}]}
        ```
        """
        let (_, _, questions) = SuggestedAction.parse(from: text)
        let answer = ClarifyingQuestion.buildQuestionAnswer(
            question: questions[0].question,
            option: questions[0].options[0],
            values: ["hostname": "affine.example.com", "port": "3010"])
        XCTAssertEqual(answer, """
        > There's no AFFiNE in the cluster yet. How should I handle the Traefik ingress?
        Deploy AFFiNE and expose it
        hostname: affine.example.com
        port: 3010
        """)
    }

    /// A blank/whitespace optional field produces no line; the filled required
    /// field still does.
    func test_buildQuestionAnswer_blankOptionalOmitted() {
        let text = """
        ```question
        {"question":"There's no AFFiNE in the cluster yet. How should I handle the Traefik ingress?","options":[{"label":"Deploy AFFiNE too","value":"Deploy AFFiNE and expose it","fields":[{"name":"hostname"},{"name":"port","required":false}]}]}
        ```
        """
        let (_, _, questions) = SuggestedAction.parse(from: text)
        let answer = ClarifyingQuestion.buildQuestionAnswer(
            question: questions[0].question,
            option: questions[0].options[0],
            values: ["hostname": "affine.example.com", "port": "   "])
        XCTAssertEqual(answer, """
        > There's no AFFiNE in the cluster yet. How should I handle the Traefik ingress?
        Deploy AFFiNE and expose it
        hostname: affine.example.com
        """)
    }
}
