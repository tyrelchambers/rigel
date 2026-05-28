import Foundation

enum PanelSelection {
    case pod(Pod, action: PodAction, describe: String, recentEvents: String, logs: String?)
    case deployment(Deployment, action: DeploymentAction, pods: [Pod], describe: String, perPodLogs: [String: String]?, rollout: String?)
    case logSlice(line: LogLine, surrounding: [LogLine])
    case event(K8sEvent, relatedEvents: [K8sEvent])
    // .alert, .node added in follow-up plans
}
