import Foundation

enum WatchEventType: String, Codable {
    case added = "ADDED"
    case modified = "MODIFIED"
    case deleted = "DELETED"
    case error = "ERROR"
    case bookmark = "BOOKMARK"
}

struct WatchEvent<T: Codable>: Codable {
    let type: WatchEventType
    let object: T
}
