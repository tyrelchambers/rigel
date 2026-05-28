import SwiftUI
import MarkdownUI

private let bodyFamily: String? = Theme.Font.bodyFamilyName
private let monoFamily: String? = Theme.Font.monoFamilyName

extension MarkdownUI.Theme {
    static let claudeK8s: MarkdownUI.Theme = MarkdownUI.Theme()
        .text {
            if let bodyFamily { FontFamily(.custom(bodyFamily)) }
            ForegroundColor(Theme.Foreground.primary)
            FontSize(13)
        }
        .code {
            if let monoFamily { FontFamily(.custom(monoFamily)) }
            FontSize(12)
            BackgroundColor(Theme.Border.subtle)
            ForegroundColor(Theme.Accent.primary)
        }
        .strong { FontWeight(.semibold) }
        .link {
            ForegroundColor(Theme.Accent.primary)
            UnderlineStyle(.single)
        }
        .heading1 { config in
            config.label
                .markdownTextStyle {
                    FontWeight(.bold)
                    FontSize(20)
                    ForegroundColor(Theme.Foreground.primary)
                }
                .markdownMargin(top: 16, bottom: 8)
        }
        .heading2 { config in
            config.label
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(16)
                    ForegroundColor(Theme.Foreground.primary)
                }
                .markdownMargin(top: 14, bottom: 6)
        }
        .heading3 { config in
            config.label
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(14)
                    ForegroundColor(Theme.Foreground.primary)
                }
                .markdownMargin(top: 12, bottom: 4)
        }
        .paragraph { config in
            config.label.markdownMargin(top: 0, bottom: 8)
        }
        .listItem { config in
            config.label.markdownMargin(top: 2, bottom: 2)
        }
        .codeBlock { config in
            VStack(alignment: .leading, spacing: 0) {
                if let lang = config.language, !lang.isEmpty {
                    Text(lang)
                        .font(Theme.Font.mono(9, weight: .semibold))
                        .foregroundStyle(Theme.Foreground.tertiary)
                        .textCase(.uppercase)
                        .tracking(0.5)
                        .padding(.horizontal, 10).padding(.vertical, 4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.Border.subtle)
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    config.label
                        .markdownTextStyle {
                            if let monoFamily { FontFamily(.custom(monoFamily)) }
                            FontSize(12)
                            ForegroundColor(Theme.Foreground.primary)
                        }
                        .padding(10)
                }
            }
            .background(Theme.Surface.sunken)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                    .strokeBorder(Theme.Border.subtle, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            .markdownMargin(top: 6, bottom: 6)
        }
        .blockquote { config in
            config.label
                .markdownTextStyle {
                    ForegroundColor(Theme.Foreground.secondary)
                    FontStyle(.italic)
                }
                .padding(.leading, 12)
                .overlay(alignment: .leading) {
                    Rectangle().fill(Theme.Accent.primary).frame(width: 3)
                }
                .markdownMargin(top: 6, bottom: 6)
        }
        .table { config in
            config.label
                .markdownTableBackgroundStyle(
                    .alternatingRows(Theme.Surface.sunken.opacity(0.3), Color.clear)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.sm)
                        .strokeBorder(Theme.Border.subtle, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                .markdownMargin(top: 6, bottom: 6)
        }
        .tableCell { config in
            config.label
                .markdownTextStyle {
                    FontSize(12)
                    ForegroundColor(Theme.Foreground.primary)
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
        }
}
