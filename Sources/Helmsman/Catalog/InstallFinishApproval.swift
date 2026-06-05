import Foundation

/// Identifies the resources that belong to one in-progress install, so the
/// install-finish loop can auto-execute *scoped, low-risk* fixes while still
/// routing everything else through the confirm sheet.
struct InstallScope: Equatable {
    let namespace: String
    /// The `app.kubernetes.io/instance` value — also the baked resources' name
    /// stem (`{{instance}}`, `{{instance}}-secrets`, …).
    let instance: String
}

/// Decides whether a `SuggestedAction` emitted during the install-finish loop may
/// run WITHOUT a confirm-sheet click. The rule is deliberately conservative —
/// when in doubt it returns false and the action falls back to the normal
/// confirm flow. Two independent gates must BOTH pass:
///
///  1. **Scope** — the action targets a resource of *this* install (its namespace
///     AND a name tied to the instance). Namespace alone is not enough: a shared
///     namespace like `personal` holds multiple apps, so a fix must not be able
///     to touch a neighbour.
///  2. **Risk** — the verb is on the low-risk allowlist (config nudges, restarts,
///     scale-up). Anything destructive, image/tag changing, node-wide, or
///     cross-namespace requires a click.
enum InstallFinishApproval {

    /// Safe, in-scope generic `command` verbs (first non-flag token).
    private static let safeCommandVerbs: Set<String> = [
        "annotate", "label", "set", "patch", "rollout", "scale",
        "get", "describe", "logs", "events", "wait", "top",
    ]
    /// Verbs that ALWAYS require confirmation regardless of scope.
    private static let destructiveCommandVerbs: Set<String> = [
        "delete", "drain", "cordon", "uncordon", "taint", "replace", "edit",
        "exec", "cp", "port-forward", "apply", "create", "destroy", "uninstall",
        "remove", "rollout-undo",
    ]

    static func autoApprovable(_ a: SuggestedAction, in scope: InstallScope) -> Bool {
        switch a.kind {
        case .restart, .setEnv, .setResources, .resume, .resumeCronJob, .triggerCronJob:
            return targetsInstance(a, scope)
        case .scale:
            // Scale-UP only; scaling to 0 takes the app down → confirm.
            return (a.replicas ?? 0) >= 1 && targetsInstance(a, scope)
        case .command:
            return commandIsSafe(a, scope)
        // Destructive / out-of-scope / app-altering kinds always confirm.
        case .rollback, .setImage, .pause, .deletePod, .deleteWorkload,
             .cordon, .uncordon, .drain, .suspendCronJob,
             .createNamespace, .deleteNamespace, .deleteResource, .purge:
            return false
        }
    }

    /// True when a typed action's namespace + target name both belong to the install.
    private static func targetsInstance(_ a: SuggestedAction, _ scope: InstallScope) -> Bool {
        guard (a.namespace ?? scope.namespace) == scope.namespace else { return false }
        guard let t = a.target ?? a.pod, nameBelongs(t, scope.instance) else { return false }
        return true
    }

    /// A resource name belongs to the install when it IS the instance or is
    /// prefixed by it (`acme`, `acme-secrets`, `acme-server`). Generically-named
    /// shared resources (`postgres`, `redis`) deliberately don't match — they get
    /// a confirm, since the name alone can't prove ownership in a shared namespace.
    private static func nameBelongs(_ name: String, _ instance: String) -> Bool {
        name == instance || name.hasPrefix(instance + "-")
    }

    /// Generic `command` actions: a safe verb, no destructive verb anywhere, an
    /// explicit `-n <installNamespace>` (and never all-namespaces), an instance-
    /// owned target token, and not flagged destructive.
    private static func commandIsSafe(_ a: SuggestedAction, _ scope: InstallScope) -> Bool {
        guard a.destructive != true, let args = a.args, !args.isEmpty else { return false }
        let lower = args.map { $0.lowercased() }
        // No destructive verb may appear anywhere in the command.
        if lower.contains(where: { destructiveCommandVerbs.contains($0) }) { return false }
        // First non-flag token is the verb and must be allowlisted.
        guard let verb = lower.first(where: { !$0.hasPrefix("-") }),
              safeCommandVerbs.contains(verb) else { return false }
        // Never cluster-wide.
        if lower.contains("-a") || lower.contains("--all-namespaces") { return false }
        // Must be scoped to the install namespace via -n/--namespace.
        guard namespaceArg(args) == scope.namespace else { return false }
        // Some token must reference the instance (e.g. deployment/acme-web, or `acme`).
        guard args.contains(where: { tokenTargetsInstance($0, scope.instance) }) else { return false }
        return true
    }

    /// Extracts the value following `-n`/`--namespace`, or nil when absent.
    private static func namespaceArg(_ args: [String]) -> String? {
        var i = 0
        while i < args.count {
            if args[i] == "-n" || args[i] == "--namespace", i + 1 < args.count { return args[i + 1] }
            if args[i].hasPrefix("--namespace=") { return String(args[i].dropFirst("--namespace=".count)) }
            i += 1
        }
        return nil
    }

    /// A command token targets the instance when it is the instance, is prefixed
    /// by it, or is a `kind/instance…` ref (`deployment/acme-web`).
    private static func tokenTargetsInstance(_ token: String, _ instance: String) -> Bool {
        let bare = token.contains("/") ? String(token.split(separator: "/").last ?? "") : token
        return nameBelongs(bare, instance)
    }
}
