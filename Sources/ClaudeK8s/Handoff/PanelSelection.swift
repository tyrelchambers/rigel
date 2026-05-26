import Foundation

enum PanelSelection {
    case pod(Pod, describe: String, recentEvents: String)
    // .logSlice, .alert, .node added in follow-up plans
}
