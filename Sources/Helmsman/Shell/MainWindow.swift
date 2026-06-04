import SwiftUI

struct MainWindow: View {
    @State private var contextManager = ClusterContextManager()
    @State private var chat = ChatViewModel()
    @State private var selectedPanel: PanelKind = .overview

    // Single watch-owning cache; all panel VMs read from it.
    @State private var cache: ClusterCache
    @State private var deploymentsVM: DeploymentsViewModel
    @State private var podsVM: PodsViewModel
    @State private var workloadsVM: WorkloadsViewModel
    @State private var rightSizingVM: RightSizingViewModel
    @State private var nodesVM: NodesViewModel
    @State private var ingressesVM: IngressesViewModel
    @State private var servicesVM: ServicesViewModel
    @State private var databasesVM: DatabasesViewModel
    @State private var eventsVM: EventsViewModel
    @State private var logsVM: LogsViewModel
    @State private var secretsVM: SecretsViewModel
    @State private var configMapsVM: ConfigMapsViewModel
    @State private var storageVM: StorageViewModel
    @State private var namespacesVM: NamespacesViewModel
    @State private var rbacVM: RBACViewModel
    @State private var catalogVM: CatalogViewModel
    @State private var assistantVM: AssistantViewModel
    @State private var settingsVM: SettingsViewModel
    @State private var accountsVM: AccountsViewModel
    @State private var updateScheduler: UpdateScheduler
    @State private var paletteOpen = false
    @State private var pendingWorkloadAction: WorkloadAction?
    /// True when the pending action came from a Claude chat suggestion — its
    /// result is fed back into the session so Claude can continue the task.
    @State private var pendingActionFromChat = false
    /// A queue of chat-suggested actions awaiting one combined confirm + run.
    @State private var pendingBatch: BatchActions?
    @State private var yamlTarget: YAMLTarget?
    @State private var historyOpen = false
    @State private var manageSecret: Secret?
    @State private var pendingSecretEditor: SecretEditorMode?
    @State private var manageIngress: Ingress?
    @State private var pendingIngressEditor: IngressEditorMode?
    @State private var manageService: Service?
    @State private var pendingServiceEditor: ServiceEditorMode?
    @State private var pendingPortForward: PortForwardTarget?
    @State private var manageConfigMap: ConfigMap?
    @State private var pendingConfigMapEditor: ConfigMapEditorMode?
    @State private var pendingNamespaceCreate = false
    @State private var pendingMetricsInstall: MetricsInstallModel?
    @State private var pendingSecretMove: Secret?
    @State private var pendingCatalogDetail: CatalogApp?
    @State private var pendingCatalogInstall: CatalogInstallWizardModel?

    init() {
        let cache = ClusterCache()
        let catalogStore = CatalogStore()
        _cache = State(initialValue: cache)
        _deploymentsVM = State(initialValue: DeploymentsViewModel(cache: cache))
        _podsVM = State(initialValue: PodsViewModel(cache: cache))
        _workloadsVM = State(initialValue: WorkloadsViewModel(cache: cache))
        _rightSizingVM = State(initialValue: RightSizingViewModel(cache: cache))
        _nodesVM = State(initialValue: NodesViewModel(cache: cache))
        _ingressesVM = State(initialValue: IngressesViewModel(cache: cache))
        _servicesVM = State(initialValue: ServicesViewModel(cache: cache))
        _databasesVM = State(initialValue: DatabasesViewModel(cache: cache))
        _eventsVM = State(initialValue: EventsViewModel(cache: cache))
        _logsVM = State(initialValue: LogsViewModel(cache: cache))
        _secretsVM = State(initialValue: SecretsViewModel(cache: cache))
        _configMapsVM = State(initialValue: ConfigMapsViewModel(cache: cache))
        _storageVM = State(initialValue: StorageViewModel(cache: cache))
        _namespacesVM = State(initialValue: NamespacesViewModel(cache: cache))
        _rbacVM = State(initialValue: RBACViewModel(cache: cache))
        let updateStore = UpdateCheckStore()
        _catalogVM = State(initialValue: CatalogViewModel(cache: cache, store: catalogStore, updates: updateStore))
        _updateScheduler = State(initialValue: UpdateScheduler(store: updateStore, cache: cache, catalog: catalogStore))
        let assistant = AssistantViewModel(cache: cache)
        _assistantVM = State(initialValue: assistant)
        _settingsVM = State(initialValue: SettingsViewModel(cache: cache, assistant: assistant))
        _accountsVM = State(initialValue: AccountsViewModel(context: ""))
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                NavStrip(selection: $selectedPanel)

                HSplitView {
                    VStack(spacing: 0) {
                        if selectedPanel.isNamespaceScoped {
                            NamespaceBar(cache: cache)
                        }
                        // Heavy list/table tabs mount one tick after the switch so
                        // navigation paints instantly; `.id` makes each tab a fresh
                        // identity so it re-defers on every visit.
                        DeferredView(isDeferred: selectedPanel.hasHeavyList) {
                            panelView
                        } placeholder: {
                            PanelLoading()
                        }
                        .id(selectedPanel)
                    }
                    .frame(minWidth: 480, idealWidth: 820, maxWidth: .infinity, maxHeight: .infinity)
                    .background(Theme.Surface.primary)

                    ChatView(
                        viewModel: chat,
                        onSlashCommand: handleSlash,
                        suggestedPrompts: {
                            SuggestedPromptsBuilder.build(
                                cache: cache,
                                contextName: contextManager.active?.name
                            )
                        },
                        onSuggestedPrompt: { chat.sendHandoff($0.prompt) },
                        mentionCandidates: { MentionIndex.build(from: cache) },
                        onNewChat: { chat.startNewChat(clusterContext: contextManager.active?.name) },
                        onOpenHistory: { historyOpen = true },
                        onSuggestedAction: runSuggestedAction,
                        onRunActions: runSuggestedActionBatch,
                        onAnswerQuestion: { chat.send($0) }
                    )
                    .frame(minWidth: 260, idealWidth: 340, maxWidth: 480, maxHeight: .infinity)
                    .background(Theme.Surface.elevated)
                }
            }
            StatusBar(
                cache: cache,
                context: contextManager.active?.name,
                chat: chat,
                onOpenPalette: { paletteOpen = true }
            )
        }
        .background(Theme.Surface.primary)
        .preferredColorScheme(.dark)
        .background {
            Button("Open Command Palette") { paletteOpen.toggle() }
                .keyboardShortcut("k", modifiers: .command)
                .hidden()
        }
        .sheet(isPresented: $historyOpen) {
            ChatHistorySheet(
                entries: SessionStore.shared.history,
                onResume: { entry in
                    historyOpen = false
                    chat.resumeHistory(entry)
                },
                onDelete: { entry in
                    SessionStore.shared.removeHistory(entry.id)
                },
                onClose: { historyOpen = false }
            )
        }
        .sheet(item: $yamlTarget) { target in
            YAMLViewerSheet(
                kind: target.kind,
                name: target.name,
                namespace: target.namespace,
                context: contextManager.active?.name,
                onClose: { yamlTarget = nil }
            )
        }
        .sheet(item: $manageSecret) { secret in
            SecretManageSheet(
                secret: secret,
                context: contextManager.active?.name,
                onClose: { manageSecret = nil },
                onViewYAML: {
                    manageSecret = nil
                    viewYAML(kind: "secret", name: secret.metadata.name, namespace: secret.metadata.namespace)
                },
                onEdit: { s in
                    manageSecret = nil
                    pendingSecretEditor = .edit(s)
                },
                onMove: { s in
                    manageSecret = nil
                    pendingSecretMove = s
                },
                onDelete: { s in
                    manageSecret = nil
                    requestWorkload(.deleteSecret(name: s.metadata.name, namespace: s.metadata.namespace ?? "default"))
                }
            )
        }
        .sheet(item: $pendingSecretEditor) { mode in
            SecretEditorSheet(
                mode: mode,
                onSubmit: { draft in
                    pendingSecretEditor = nil
                    requestWorkload(.applySecret(draft))
                },
                onCancel: { pendingSecretEditor = nil }
            )
        }
        .sheet(item: $manageIngress) { ingress in
            IngressManageSheet(
                ingress: ingress,
                context: contextManager.active?.name,
                onClose: { manageIngress = nil },
                onViewYAML: {
                    manageIngress = nil
                    viewYAML(kind: "ingress", name: ingress.metadata.name, namespace: ingress.metadata.namespace)
                },
                onEdit: { ing in
                    manageIngress = nil
                    pendingIngressEditor = .edit(ing)
                },
                onDelete: { ing in
                    manageIngress = nil
                    requestWorkload(.deleteIngress(name: ing.metadata.name, namespace: ing.metadata.namespace ?? "default"))
                },
                onAskClaude: { ing in
                    manageIngress = nil
                    handoffIngress(ing)
                }
            )
        }
        .sheet(item: $pendingIngressEditor) { mode in
            IngressEditorSheet(
                mode: mode,
                context: contextManager.active?.name,
                onSubmit: { ingress, isNew in
                    pendingIngressEditor = nil
                    requestWorkload(.applyIngress(ingress, isNew: isNew))
                },
                onCancel: { pendingIngressEditor = nil }
            )
        }
        .sheet(item: $manageService) { service in
            ServiceManageSheet(
                service: service,
                context: contextManager.active?.name,
                onClose: { manageService = nil },
                onViewYAML: {
                    manageService = nil
                    viewYAML(kind: "service", name: service.metadata.name, namespace: service.metadata.namespace)
                },
                onEdit: { s in
                    manageService = nil
                    pendingServiceEditor = .edit(s)
                },
                onDelete: { s in
                    manageService = nil
                    requestWorkload(.deleteService(name: s.metadata.name, namespace: s.metadata.namespace ?? "default"))
                },
                onAskClaude: { s in
                    manageService = nil
                    handoffService(s)
                },
                onForward: { s, port in
                    manageService = nil
                    beginPortForward(s, port: port)
                }
            )
        }
        .sheet(item: $pendingServiceEditor) { mode in
            ServiceEditorSheet(
                mode: mode,
                onSubmit: { service, isNew in
                    pendingServiceEditor = nil
                    requestWorkload(.applyService(service, isNew: isNew))
                },
                onCancel: { pendingServiceEditor = nil }
            )
        }
        .sheet(item: $pendingPortForward) { target in
            PortForwardStartSheet(
                targetKind: target.targetKind,
                targetName: target.targetName,
                namespace: target.namespace,
                remotePort: target.remotePort,
                isLocalPortInUse: { servicesVM.portForwards.isLocalPortInUse($0) },
                onStart: { local in
                    servicesVM.portForwards.start(
                        targetKind: target.targetKind,
                        targetName: target.targetName,
                        namespace: target.namespace,
                        remotePort: target.remotePort,
                        localPort: local,
                        context: contextManager.active?.name
                    )
                    pendingPortForward = nil
                },
                onCancel: { pendingPortForward = nil }
            )
        }
        .sheet(item: $manageConfigMap) { configMap in
            ConfigMapManageSheet(
                configMap: configMap,
                onClose: { manageConfigMap = nil },
                onViewYAML: {
                    manageConfigMap = nil
                    viewYAML(kind: "configmap", name: configMap.metadata.name, namespace: configMap.metadata.namespace)
                },
                onEdit: { c in
                    manageConfigMap = nil
                    pendingConfigMapEditor = .edit(c)
                },
                onDelete: { c in
                    manageConfigMap = nil
                    requestWorkload(.deleteConfigMap(name: c.metadata.name, namespace: c.metadata.namespace ?? "default"))
                }
            )
        }
        .sheet(item: $pendingConfigMapEditor) { mode in
            ConfigMapEditorSheet(
                mode: mode,
                onSubmit: { configMap, isNew in
                    pendingConfigMapEditor = nil
                    requestWorkload(.applyConfigMap(configMap, isNew: isNew))
                },
                onCancel: { pendingConfigMapEditor = nil }
            )
        }
        .sheet(item: $pendingMetricsInstall) { model in
            MetricsInstallSheet(model: model, onClose: {
                let installed = model.installedBackend != nil
                pendingMetricsInstall = nil
                // Pick up the newly-installed backend immediately.
                if installed {
                    rightSizingVM.load(context: contextManager.active?.name)
                    Task { await rightSizingVM.refresh(force: true) }
                }
            })
        }
        .sheet(isPresented: $pendingNamespaceCreate) {
            NamespaceCreateSheet(
                onSubmit: { name in
                    pendingNamespaceCreate = false
                    requestWorkload(.createNamespace(name: name))
                },
                onCancel: { pendingNamespaceCreate = false }
            )
        }
        .sheet(item: $pendingSecretMove) { secret in
            SecretMoveSheet(
                secret: secret,
                onSubmit: { newName, newNs in
                    pendingSecretMove = nil
                    requestWorkload(.moveSecret(original: secret, newName: newName, newNamespace: newNs))
                },
                onCancel: { pendingSecretMove = nil }
            )
        }
        .sheet(item: $pendingCatalogDetail) { app in
            CatalogDetailSheet(
                app: app,
                fit: catalogVM.fit(for: app),
                installed: catalogVM.installedInfo(for: app),
                onClose: { pendingCatalogDetail = nil },
                onInstall: { app, pinnedNode in
                    pendingCatalogDetail = nil
                    pendingCatalogInstall = CatalogInstallWizardModel(
                        app: app,
                        fit: catalogVM.fit(for: app),
                        cache: cache,
                        context: contextManager.active?.name,
                        initialNodePin: pinnedNode
                    )
                }
            )
        }
        .sheet(item: $pendingCatalogInstall) { model in
            CatalogInstallWizard(
                model: model,
                onClose: {
                    model.teardownSession()
                    pendingCatalogInstall = nil
                },
                onHandoffToChat: { prompt in
                    chat.sendHandoff(prompt, summary: "Continue installing \(model.app.name)")
                }
            )
        }
        .sheet(item: $pendingWorkloadAction) { action in
            WorkloadConfirmSheet(
                action: action,
                contextName: contextManager.active?.name,
                onApprove: { resolved in
                    pendingWorkloadAction = nil
                    executeWorkload(resolved)
                },
                onCancel: { pendingWorkloadAction = nil }
            )
        }
        .sheet(item: $pendingBatch) { batch in
            BatchActionConfirmSheet(
                actions: batch.actions,
                contextName: contextManager.active?.name,
                onApprove: {
                    pendingBatch = nil
                    executeBatch(batch.actions)
                },
                onCancel: { pendingBatch = nil }
            )
        }
        .sheet(isPresented: $paletteOpen) {
            CommandPalette(
                isPresented: $paletteOpen,
                commands: PaletteIndex.build(
                    cache: cache,
                    catalog: catalogVM.store,
                    contexts: contextManager.available,
                    switchTo: { selectedPanel = $0 },
                    expandDeployment: { deploymentsVM.expanded = [$0.id] },
                    tailLogs: { logsVM.select($0, context: contextManager.active?.name) },
                    switchContext: { contextManager.setActive($0) },
                    createSecret: { pendingSecretEditor = .create },
                    manageSecret: { manageSecret = $0 },
                    installApp: { app in
                        pendingCatalogInstall = CatalogInstallWizardModel(
                            app: app,
                            fit: catalogVM.fit(for: app),
                            cache: cache,
                            context: contextManager.active?.name
                        )
                    }
                )
            )
        }
        .onAppear {
            // reload() updates contextManager.active, which fires onChange below
            // — that's where the actual start happens. Avoid double-start here.
            contextManager.reload()
            SearchFocusController.shared.startGlobalSlashShortcut()
        }
        .onChange(of: contextManager.active) { _, newCtx in
            if let ctx = newCtx?.name {
                let saved = SessionStore.shared.sessionId(for: ctx)
                chat.stop()
                chat.start(resumingSessionId: saved, clusterContext: ctx)
                startPanelViewModels(context: ctx)
            }
        }
        .onChange(of: chat.sessionId) { _, newSid in
            if let sid = newSid, let ctx = contextManager.active?.name {
                SessionStore.shared.setSessionId(sid, for: ctx)
            }
        }
    }

    @ViewBuilder private var panelView: some View {
        switch selectedPanel {
        case .overview:
            OverviewPanel(
                cache: cache,
                contextManager: contextManager,
                databasesVM: databasesVM,
                rightSizingVM: rightSizingVM,
                onInvestigate: investigateCluster
            )
        case .assistant:
            AssistantPanel(
                viewModel: assistantVM,
                onRunSuggestion: runSuggestedAction,
                onRevert: { yaml, label in
                    requestWorkload(.applyManifest(yaml: yaml, label: "revert \(label)"))
                },
                onShowPod: { pod in
                    podsVM.search = pod.metadata.name
                    selectedPanel = .pods
                }
            )
        case .namespaces:
            NamespacesPanel(
                viewModel: namespacesVM,
                onCreate: { pendingNamespaceCreate = true },
                onDelete: { requestWorkload(.deleteNamespace(name: $0.metadata.name)) },
                onViewYAML: viewYAML
            )
        case .deployments:
            DeploymentsPanel(viewModel: deploymentsVM, onAction: { dep, pods, action in
                handoffDeployment(dep, pods: pods, action: action)
            }, onWorkload: { requestWorkload($0) }, onViewYAML: viewYAML, onMove: { dep, target in
                chat.sendHandoff(
                    ContextHandoffBuilder.moveDeploymentPrompt(dep, targetNamespace: target),
                    summary: "Move deployment \(dep.metadata.name): \(dep.metadata.namespace ?? "default") → \(target)"
                )
            }, contextName: contextManager.active?.name)
        case .pods:
            PodsPanel(viewModel: podsVM, onAction: { pod, action in
                handoffPod(pod, action: action)
            }, contextName: contextManager.active?.name, onWorkload: { requestWorkload($0) }, onViewYAML: viewYAML, onTailLogsForPod: tailLogsForPod, onForwardPod: beginPodPortForward)
        case .workloads:
            WorkloadsPanel(
                viewModel: workloadsVM,
                onViewYAML: viewYAML,
                onWorkload: { requestWorkload($0) }
            )
        case .rightSizing:
            RightSizingPanel(
                viewModel: rightSizingVM,
                contextName: contextManager.active?.name,
                onApply: { requestWorkload($0) },
                onAskClaude: handoffRightSizing,
                onInstall: { pendingMetricsInstall = MetricsInstallModel(context: contextManager.active?.name, cache: cache) }
            )
        case .nodes:
            NodesPanel(viewModel: nodesVM, onWorkload: { requestWorkload($0) }, onViewYAML: viewYAML)
        case .connectivity:
            ConnectivityPanel(
                cache: cache,
                onSelectService: { name, _ in
                    servicesVM.search = name
                    selectedPanel = .services
                },
                onSelectPods: { flow in
                    podsVM.search = flow.podNames.first ?? flow.serviceName
                    selectedPanel = .pods
                }
            )
        case .ingresses:
            IngressesPanel(
                viewModel: ingressesVM,
                onViewYAML: viewYAML,
                onAskClaude: handoffIngress,
                onManage: { manageIngress = $0 },
                onCreate: { pendingIngressEditor = .create },
                onEdit: { pendingIngressEditor = .edit($0) },
                onDelete: { requestWorkload(.deleteIngress(name: $0.metadata.name, namespace: $0.metadata.namespace ?? "default")) }
            )
        case .services:
            ServicesPanel(
                viewModel: servicesVM,
                onViewYAML: viewYAML,
                onAskClaude: handoffService,
                onManage: { manageService = $0 },
                onCreate: { pendingServiceEditor = .create },
                onEdit: { pendingServiceEditor = .edit($0) },
                onDelete: { requestWorkload(.deleteService(name: $0.metadata.name, namespace: $0.metadata.namespace ?? "default")) },
                onForward: beginPortForward
            )
        case .databases:
            DatabasesPanel(
                viewModel: databasesVM,
                onAction: { requestWorkload($0) },
                onPortForward: { conn in
                    pendingPortForward = PortForwardTarget(
                        targetKind: conn.targetKind,
                        targetName: conn.targetName,
                        namespace: conn.namespace,
                        remotePort: conn.port
                    )
                },
                onRevealCredentials: { secretName, namespace in
                    if let secret = cache.secrets.first(where: {
                        $0.metadata.name == secretName && ($0.metadata.namespace ?? "default") == namespace
                    }) {
                        manageSecret = secret
                    }
                },
                onCopyDSN: { dsn in
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(dsn, forType: .string)
                }
            )
        case .secrets:
            SecretsPanel(
                viewModel: secretsVM,
                onManage: { manageSecret = $0 },
                onNew: { pendingSecretEditor = .create },
                onViewYAML: viewYAML
            )
        case .configMaps:
            ConfigMapsPanel(
                viewModel: configMapsVM,
                onManage: { manageConfigMap = $0 },
                onNew: { pendingConfigMapEditor = .create },
                onViewYAML: viewYAML
            )
        case .storage:
            StoragePanel(
                viewModel: storageVM,
                onViewYAML: viewYAML,
                onDeletePVC: { requestWorkload(.deletePVC(name: $0.metadata.name, namespace: $0.metadata.namespace ?? "default")) },
                onDeletePV: { requestWorkload(.deletePV(name: $0.metadata.name)) }
            )
        case .rbac:
            RBACPanel(
                viewModel: rbacVM,
                onViewYAML: viewYAML,
                onDelete: { kind, name, ns in
                    requestWorkload(.deleteRBAC(kind: kind, name: name, namespace: ns))
                }
            )
        case .catalog:
            CatalogPanel(
                viewModel: catalogVM,
                onSelect: { pendingCatalogDetail = $0 },
                onUpdate: { handoffUpdate($0) },
                onCheckNow: { Task { await updateScheduler.checkNow() } },
                onCheckApp: { app in Task { await updateScheduler.checkNow(appID: app.id) } }
            )
        case .events:
            EventsPanel(viewModel: eventsVM) { event in
                handoffEvent(event)
            }
        case .logs:
            LogsPanel(contextManager: contextManager, viewModel: logsVM) { line, surrounding in
                handoffLogSlice(line: line, surrounding: surrounding)
            }
        case .settings:
            SettingsPanel(
                viewModel: settingsVM,
                onOpenAssistant: { selectedPanel = .assistant },
                updates: updateScheduler.store,
                onToggleDailyUpdates: { updateScheduler.setEnabled($0) },
                onCheckUpdatesNow: { Task { await updateScheduler.checkNow() } }
            )
        case .accounts:
            AccountsPanel(viewModel: accountsVM)
        }
    }

    private func startPanelViewModels(context: String) {
        logsVM.clearSelection()        // old-context stream no longer valid
        servicesVM.stopAllForwards()   // port-forwards are context-specific
        assistantVM.load(context: context)
        settingsVM.stopLinking()   // tear down any active link port-forward before the context changes
        settingsVM.load(context: context)
        accountsVM.load(context: context)
        cache.start(context: context)
        updateScheduler.start()
    }

    /// Hand a catalog app with an available update off to Claude to facilitate
    /// the upgrade. Builds a prompt anchored on the live deployment (so Claude
    /// works from what's actually running) and the target version.
    private func handoffUpdate(_ app: CatalogApp) {
        guard case let .updateAvailable(_, latest)? = catalogVM.updateStatus(for: app) else { return }
        // The exact running image (with its current tag) — UpgradePlan scans the
        // live workloads from it, so the assistant gets precise targets.
        let installed = installedImages(
            apps: [app],
            deployments: cache.deployments,
            statefulSets: cache.statefulSets,
            pods: cache.pods
        )
        guard let running = installed.first else {
            chat.appendSystem("⚠︎ Couldn't upgrade \(app.name): its running image isn't in the live cluster view.")
            return
        }
        let plan = UpgradePlan.make(
            appName: app.name,
            currentImage: running.image,
            targetTag: latest,
            deployments: cache.deployments,
            statefulSets: cache.statefulSets
        )
        let (text, playbookMissing) = UpgradePlaybook.upgradeMessage(for: plan)
        if playbookMissing {
            chat.appendSystem("⚠︎ Upgrade playbook resource unavailable — sending a basic upgrade request instead.")
        }
        chat.sendHandoff(text, summary: "Upgrade plan")
    }

    private func requestWorkload(_ action: WorkloadAction, fromChat: Bool = false) {
        pendingActionFromChat = fromChat
        pendingWorkloadAction = action
    }

    /// Resolve a chat-suggested action against the live cache, surfacing a
    /// system message (and returning nil) on a miss. Shared by the single-tap
    /// and batch paths.
    private func resolveSuggestion(_ suggestion: SuggestedAction) -> WorkloadAction? {
        switch SuggestedActionResolver.resolve(
            suggestion,
            deployments: cache.deployments,
            pods: cache.pods,
            nodes: cache.nodes,
            statefulSets: cache.statefulSets,
            daemonSets: cache.daemonSets,
            jobs: cache.jobs,
            cronJobs: cache.cronJobs,
            namespaces: cache.namespaces
        ) {
        case .action(let action):
            return action
        case .unresolved(let reason):
            chat.appendSystem("⚠︎ Couldn't run “\(suggestion.label)”: \(reason).")
            return nil
        }
    }

    /// Turn a single chat-suggested action into a confirmed kubectl mutation:
    /// resolve it, then open the confirm sheet.
    private func runSuggestedAction(_ suggestion: SuggestedAction) {
        if let action = resolveSuggestion(suggestion) {
            requestWorkload(action, fromChat: true)
        }
    }

    /// Queue several chat-suggested actions for one combined confirm + run.
    /// Unresolvable ones are reported and dropped; if none resolve, nothing opens.
    private func runSuggestedActionBatch(_ suggestions: [SuggestedAction]) {
        let actions = suggestions.compactMap(resolveSuggestion)
        guard !actions.isEmpty else { return }
        pendingBatch = BatchActions(actions: actions)
    }

    /// Run a confirmed queue sequentially, stopping at the first failure, then
    /// report all outcomes back to the session in ONE message so the assistant
    /// reacts once instead of after every action.
    private func executeBatch(_ actions: [WorkloadAction]) {
        let ctx = contextManager.active?.name
        Task {
            var ran: [(action: WorkloadAction, result: WorkloadCommander.Result)] = []
            var stoppedAt: Int? = nil
            for (idx, action) in actions.enumerated() {
                await MainActor.run { chat.appendSystem("▶︎ \(action.previewCommand(context: ctx))") }
                let result = await WorkloadCommander(context: ctx).run(action)
                await MainActor.run {
                    if result.ok {
                        let body = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
                        chat.appendSystem("✓ \(action.title) — \(body.isEmpty ? "ok" : body.prefix(400).description)")
                    } else {
                        chat.appendSystem("✗ \(action.title) failed (exit \(result.exitCode)):\n\(result.stderr.prefix(400))")
                    }
                }
                ran.append((action, result))
                if !result.ok { stoppedAt = idx + 1; break }
            }
            let skipped = stoppedAt.map { Array(actions[$0...]) } ?? []
            await MainActor.run {
                chat.send(
                    WorkloadResultReport.batchFeedback(ran: ran, skipped: skipped, context: ctx),
                    display: false
                )
            }
        }
    }

    private func viewYAML(kind: String, name: String, namespace: String?) {
        yamlTarget = YAMLTarget(kind: kind, name: name, namespace: namespace)
    }

    /// Find the Deployment owning `pod` by matching its labels against deployment selectors,
    /// switch to the Logs tab, and start tailing.
    private func tailLogsForPod(_ pod: Pod) {
        let podLabels = pod.metadata.labels ?? [:]
        let ns = pod.metadata.namespace
        let owner = cache.deployments.first { dep in
            guard dep.metadata.namespace == ns else { return false }
            let sel = dep.spec?.selector?.matchLabels ?? [:]
            guard !sel.isEmpty else { return false }
            return sel.allSatisfy { podLabels[$0.key] == $0.value }
        }
        guard let dep = owner else {
            chat.appendSystem("No deployment owns pod \(pod.metadata.name) — can't tail its deployment logs.")
            return
        }
        logsVM.select(dep, context: contextManager.active?.name)
        selectedPanel = .logs
    }

    private func executeWorkload(_ action: WorkloadAction) {
        let ctx = contextManager.active?.name
        let fromChat = pendingActionFromChat
        pendingActionFromChat = false
        let preview = action.previewCommand(context: ctx)
        chat.appendSystem("▶︎ \(preview)")
        Task {
            let result = await WorkloadCommander(context: ctx).run(action)
            await MainActor.run {
                if result.ok {
                    let body = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
                    chat.appendSystem("✓ \(action.title) — \(body.isEmpty ? "ok" : body.prefix(400).description)")
                } else {
                    chat.appendSystem("✗ \(action.title) failed (exit \(result.exitCode)):\n\(result.stderr.prefix(400))")
                }
                // Close the loop: hand the outcome back to the same Claude session
                // so it can verify and continue the task it proposed.
                if fromChat {
                    chat.send(WorkloadResultReport.chatFeedback(action: action, context: ctx, result: result), display: false)
                }
            }
        }
    }

    private func handleSlash(_ cmd: SlashCommand) {
        switch cmd {
        case .help:
            chat.appendSystem(SlashCommand.helpText)
        case .clear:
            chat.clear()
        case .investigate:
            investigateCluster()
        case .logs(let name):
            guard let name, let dep = findDeployment(named: name) else {
                chat.appendSystem("Usage: `/logs <deployment-name>`")
                return
            }
            logsVM.select(dep, context: contextManager.active?.name)
            selectedPanel = .logs
        case .restart(let name):
            guard let name, let dep = findDeployment(named: name) else {
                chat.appendSystem("Usage: `/restart <deployment-name>`")
                return
            }
            let ns = dep.metadata.namespace ?? "default"
            chat.sendHandoff("""
            Restart deployment **\(dep.metadata.name)** in namespace **\(ns)**.

            Run: `kubectl rollout restart deployment/\(dep.metadata.name) -n \(ns) --context \(contextManager.active?.name ?? "")`

            Then check the rollout status and confirm pods came back healthy.
            """, summary: "Restart deployment \(dep.metadata.name)")
        case .describe(let name):
            guard let name else {
                chat.appendSystem("Usage: `/describe <pod-or-deployment-name>`")
                return
            }
            chat.sendHandoff("Run `kubectl describe` against the resource named **\(name)** (look for matching pods or deployments) and summarize what you find.", summary: "Describe \(name)")
        }
    }

    private func findDeployment(named name: String) -> Deployment? {
        // Exact match first, then prefix match — both case-insensitive.
        if let exact = cache.deployments.first(where: { $0.metadata.name.caseInsensitiveCompare(name) == .orderedSame }) {
            return exact
        }
        return cache.deployments.first(where: { $0.metadata.name.lowercased().hasPrefix(name.lowercased()) })
    }

    private func investigateCluster() {
        let prompt = """
        Investigate the cluster's current health. Run kubectl read-only commands across nodes, pods, recent events, deployment status, and CNPG cluster health. Identify anything broken, broken-soon, or unusual.

        Be concise. Group findings by severity. If everything looks fine, say so briefly.
        """
        chat.sendHandoff(prompt, summary: "Investigate cluster health")
    }

    private func handoffLogSlice(line: LogLine, surrounding: [LogLine]) {
        let prompt = ContextHandoffBuilder.build(.logSlice(line: line, surrounding: surrounding))
        chat.sendHandoff(prompt, summary: "Explain this log line")
    }

    private func handoffEvent(_ event: K8sEvent) {
        // Related events: same involved-object name+namespace, excluding the focal event.
        let related = cache.events.filter {
            $0.metadata.uid != event.metadata.uid &&
            $0.involvedObject?.name == event.involvedObject?.name &&
            $0.involvedObject?.namespace == event.involvedObject?.namespace
        }.prefix(20)
        let prompt = ContextHandoffBuilder.build(.event(event, relatedEvents: Array(related)))
        chat.sendHandoff(prompt, summary: "Inspect event\(event.involvedObject?.name.map { ": \($0)" } ?? "")")
    }

    private func handoffIngress(_ ing: Ingress) {
        let ns = ing.metadata.namespace ?? "default"
        let hosts = ing.hosts.isEmpty ? "(none)" : ing.hosts.joined(separator: ", ")
        let routes = ing.routes
            .map { "  \($0.host)\($0.path) → \($0.service)\($0.port.isEmpty ? "" : ":\($0.port)")" }
            .joined(separator: "\n")
        chat.sendHandoff("""
        Inspect ingress **\(ing.metadata.name)** in namespace **\(ns)**.

        Class: \(ing.className)
        TLS: \(ing.isTLS ? "yes" : "no")
        Hosts: \(hosts)
        Routes:
        \(routes.isEmpty ? "  (none)" : routes)

        Run `kubectl describe ingress \(ing.metadata.name) -n \(ns)` and verify each backend \
        service exists and has ready endpoints. Flag any missing TLS secrets, hosts with no \
        backing service, or backends with zero endpoints.
        """, summary: "Inspect ingress \(ing.metadata.name)")
    }

    private func handoffService(_ svc: Service) {
        let ns = svc.metadata.namespace ?? "default"
        let ports = svc.portSummaries.isEmpty ? "(none)" : svc.portSummaries.joined(separator: ", ")
        let selector = (svc.spec?.selector ?? [:]).isEmpty
            ? "(none — headless / externally managed)"
            : (svc.spec?.selector ?? [:]).sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: ", ")
        chat.sendHandoff("""
        Inspect service **\(svc.metadata.name)** in namespace **\(ns)**.

        Type: \(svc.typeLabel)
        ClusterIP: \(svc.spec?.clusterIP ?? "—")
        Ports: \(ports)
        Selector: \(selector)

        Run `kubectl describe service \(svc.metadata.name) -n \(ns)` and check its endpoints \
        (`kubectl get endpoints \(svc.metadata.name) -n \(ns)`). Flag a selector that matches \
        no ready pods, ports with no backing target, or a type/config that won't route traffic.
        """, summary: "Inspect service \(svc.metadata.name)")
    }

    private func beginPortForward(_ service: Service, port: Service.Port) {
        pendingPortForward = PortForwardTarget(
            targetKind: "svc",
            targetName: service.metadata.name,
            namespace: service.metadata.namespace ?? "default",
            remotePort: port.port
        )
    }

    private func handoffRightSizing(_ w: WorkloadRightSizing) {
        let lines = w.containers.map { r -> String in
            let cur = "req cpu=\(r.cpuRequest.map(ResourceQuantity.formatCores) ?? "unset") mem=\(r.memRequest.map(ResourceQuantity.formatBytes) ?? "unset"); lim cpu=\(r.cpuLimit.map(ResourceQuantity.formatCores) ?? "unset") mem=\(r.memLimit.map(ResourceQuantity.formatBytes) ?? "unset")"
            let obs = "peak cpu=\(ResourceQuantity.formatCores(r.cpuPeak)) mem=\(ResourceQuantity.formatBytes(r.memPeak)); typical cpu=\(ResourceQuantity.formatCores(r.cpuTypical)) mem=\(ResourceQuantity.formatBytes(r.memTypical)) over \(r.hoursCovered)h"
            return "- \(r.container) [\(r.verdict.label)]\n    current: \(cur)\n    observed: \(obs)"
        }.joined(separator: "\n")
        chat.sendHandoff("""
        Review right-sizing for **\(w.kind)/\(w.name)** in namespace **\(w.namespace)**, based on \
        Helmsman's persisted usage history:

        \(lines)

        For each container, advise whether the requests/limits should change and to what, weighing \
        headroom for spikes against reclaiming waste. Call out anything risky (peak near a limit, or \
        missing requests/limits). Be concrete with suggested values.
        """, summary: "Right-size \(w.kind)/\(w.name)")
    }

    private func beginPodPortForward(_ pod: Pod, remotePort: Int) {
        pendingPortForward = PortForwardTarget(
            targetKind: "pod",
            targetName: pod.metadata.name,
            namespace: pod.metadata.namespace ?? "default",
            remotePort: remotePort
        )
    }

    private func handoffDeployment(_ dep: Deployment, pods: [Pod], action: DeploymentAction) {
        // Executable actions skip Claude — fire the corresponding kubectl
        // WorkloadAction directly (still gated by WorkloadConfirmSheet).
        if action.kind == .execute {
            switch action {
            case .rollout:
                requestWorkload(.restartDeployment(dep))
            default:
                break
            }
            return
        }
        Task {
            guard let ctx = contextManager.active?.name else { return }
            let ns = dep.metadata.namespace ?? "default"
            let kubectl: String
            do {
                kubectl = try KubectlClient(context: ctx).kubectl
            } catch {
                await MainActor.run { chat.error = "\(error)" }
                return
            }

            let describe = await runKubectl(kubectl, ["--context", ctx, "describe", "deployment", dep.metadata.name, "-n", ns])

            var perPodLogs: [String: String]? = nil
            if action == .errors || action == .logs {
                perPodLogs = await fetchPerPodLogs(kubectl: kubectl, ctx: ctx, pods: pods)
            }

            var rollout: String? = nil
            if action == .rollout {
                let history = await runKubectl(kubectl, ["--context", ctx, "rollout", "history", "deployment/\(dep.metadata.name)", "-n", ns])
                let status = await runKubectl(kubectl, ["--context", ctx, "rollout", "status", "deployment/\(dep.metadata.name)", "-n", ns, "--watch=false"])
                rollout = """
                # history
                \(history)

                # status
                \(status)
                """
            }

            let prompt = ContextHandoffBuilder.build(
                .deployment(dep, action: action, pods: pods, describe: describe, perPodLogs: perPodLogs, rollout: rollout)
            )
            await MainActor.run { chat.sendHandoff(prompt, summary: "\(action.label): deployment \(dep.metadata.name)") }
        }
    }

    private func handoffPod(_ pod: Pod, action: PodAction) {
        Task {
            guard let ctx = contextManager.active?.name else { return }
            let ns = pod.metadata.namespace ?? "default"
            let kubectl: String
            do {
                kubectl = try KubectlClient(context: ctx).kubectl
            } catch {
                await MainActor.run { chat.error = "\(error)" }
                return
            }

            async let describeOut = runKubectl(kubectl, ["--context", ctx, "describe", "pod", pod.metadata.name, "-n", ns])
            async let eventsOut = runKubectl(kubectl, ["--context", ctx, "get", "events", "-n", ns, "--field-selector", "involvedObject.name=\(pod.metadata.name)"])

            let describe = await describeOut
            let events = await eventsOut

            var logs: String? = nil
            if action == .errors || action == .logs {
                logs = await runKubectl(kubectl, ["--context", ctx, "logs", pod.metadata.name, "-n", ns, "--tail=200", "--all-containers=true"])
            }

            let prompt = ContextHandoffBuilder.build(
                .pod(pod, action: action, describe: describe, recentEvents: events, logs: logs)
            )
            await MainActor.run { chat.sendHandoff(prompt, summary: "\(action.label): pod \(pod.metadata.name)") }
        }
    }

    private func fetchPerPodLogs(kubectl: String, ctx: String, pods: [Pod]) async -> [String: String] {
        await withTaskGroup(of: (String, String).self) { group in
            for pod in pods {
                let ns = pod.metadata.namespace ?? "default"
                let name = pod.metadata.name
                group.addTask {
                    let logs = await runKubectl(kubectl, ["--context", ctx, "logs", name, "-n", ns, "--tail=50", "--all-containers=true"])
                    return (name, logs)
                }
            }
            var result: [String: String] = [:]
            for await (name, logs) in group {
                result[name] = logs
            }
            return result
        }
    }

    private func runKubectl(_ kubectl: String, _ args: [String]) async -> String {
        let data = (try? await runProcess(kubectl, args: args)) ?? Data()
        return String(data: data, encoding: .utf8) ?? ""
    }
}
