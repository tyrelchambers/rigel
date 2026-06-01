import Foundation

/// Per-cluster infrastructure conventions the self-hosted install wizard bakes
/// into the prompt it sends Claude (and into the rendered catalog templates).
///
/// These used to be hardcoded to the original author's homelab (a
/// `letsencrypt-prod` ClusterIssuer, a `*.tyrelchambers.com` domain, a `ghrc`
/// pull secret, a fixed edge IP). They're now user-supplied so anyone can point
/// the wizard at their own cluster. Persisted per kubectl context in
/// `SessionStore` — different clusters legitimately have different issuers,
/// domains, and edge IPs.
struct SelfHostDefaults: Codable, Hashable {
    /// cert-manager ClusterIssuer name used in the `cert-manager.io/cluster-issuer`
    /// ingress annotation. Empty = no issuer configured; the wizard then tells
    /// Claude to omit the annotation entirely.
    var clusterIssuer: String

    /// Base domain ingress hostnames default under (`<instance>.<domain>`).
    /// Empty = no default; the hostname field starts blank.
    var ingressDomain: String

    /// Name of the image-pull secret to reference on every pod spec
    /// (`imagePullSecrets: [{name: <secret>}]`). Empty = none; the wizard tells
    /// Claude not to add `imagePullSecrets`.
    var imagePullSecret: String

    /// Public edge IP that `*.<domain>` A-records point at. Purely informational
    /// context for Claude (e.g. DNS sanity checks). Empty = omitted.
    var edgeIP: String

    /// Conservative starting point for a fresh install: the conventional
    /// Let's Encrypt production issuer name, and nothing personal. Everything
    /// else is left blank for the user to fill in under Settings.
    static let `default` = SelfHostDefaults(
        clusterIssuer: "letsencrypt-prod",
        ingressDomain: "",
        imagePullSecret: "",
        edgeIP: ""
    )
}
