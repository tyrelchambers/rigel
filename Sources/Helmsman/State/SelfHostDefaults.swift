import Foundation

/// Per-cluster infrastructure conventions the self-hosted install wizard bakes
/// into the prompt it sends Claude (and into the rendered catalog templates).
///
/// These used to be hardcoded to the original author's homelab (a
/// `letsencrypt-prod` ClusterIssuer, a `*.tyrelchambers.com` domain, a `ghrc`
/// pull secret, a `default/redirect-https` Middleware, a fixed edge IP). They're
/// now user-supplied so anyone can point the wizard at their own cluster.
/// Persisted per kubectl context in `SessionStore` — different clusters
/// legitimately have different issuers, domains, middlewares, and edge IPs.
///
/// Every field is optional-with-default at decode time (see `init(from:)`) so
/// new fields can be added without invalidating a `sessions.json` written by an
/// older build.
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

    /// Traefik HTTPS-redirect Middleware reference for the
    /// `traefik.ingress.kubernetes.io/router.middlewares` annotation, in
    /// Traefik's `<namespace>-<name>@kubernetescrd` form (e.g.
    /// `default-redirect-https@kubernetescrd`). Empty = none; the wizard omits
    /// the annotation rather than pointing ingresses at a Middleware that may
    /// not exist on the user's cluster.
    var redirectMiddleware: String

    /// Public edge IP that `*.<domain>` A-records point at. Purely informational
    /// context for Claude (e.g. DNS sanity checks). Empty = omitted.
    var edgeIP: String

    /// Conservative starting point for a fresh install: the conventional
    /// Let's Encrypt production issuer name, and nothing else. Everything that
    /// would reference a cluster-specific resource (domain, pull secret,
    /// redirect middleware, edge IP) is left blank for the user to fill in under
    /// Settings, so an unconfigured install still produces a valid manifest.
    static let `default` = SelfHostDefaults(
        clusterIssuer: "letsencrypt-prod",
        ingressDomain: "",
        imagePullSecret: "",
        redirectMiddleware: "",
        edgeIP: ""
    )

    init(clusterIssuer: String, ingressDomain: String, imagePullSecret: String,
         redirectMiddleware: String, edgeIP: String) {
        self.clusterIssuer = clusterIssuer
        self.ingressDomain = ingressDomain
        self.imagePullSecret = imagePullSecret
        self.redirectMiddleware = redirectMiddleware
        self.edgeIP = edgeIP
    }

    /// Lenient decode: any missing field falls back to the `.default` value, so
    /// adding fields over time never breaks an older persisted config.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = SelfHostDefaults.default
        clusterIssuer      = try c.decodeIfPresent(String.self, forKey: .clusterIssuer)      ?? d.clusterIssuer
        ingressDomain      = try c.decodeIfPresent(String.self, forKey: .ingressDomain)      ?? d.ingressDomain
        imagePullSecret    = try c.decodeIfPresent(String.self, forKey: .imagePullSecret)    ?? d.imagePullSecret
        redirectMiddleware = try c.decodeIfPresent(String.self, forKey: .redirectMiddleware) ?? d.redirectMiddleware
        edgeIP             = try c.decodeIfPresent(String.self, forKey: .edgeIP)             ?? d.edgeIP
    }
}
