import Foundation

enum PanelSelection {
    case pod(Pod, describe: String, recentEvents: String)
    case logSlice(line: LogLine, surrounding: [LogLine])
    // .alert, .node added in follow-up plans
}
