import Foundation
import SwiftUI

enum MessageRenderer {
    static func render(_ text: String) -> AttributedString {
        if let s = try? AttributedString(markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            return s
        }
        return AttributedString(text)
    }
}
