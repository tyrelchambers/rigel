import type { ComponentType, CSSProperties } from "react";
import {
  LayoutGrid, Layers, Box, Boxes, Gauge, Server, GitBranch, Signpost,
  Network, Database, DatabaseBackup, KeyRound, FileText, HardDrive,
  ShieldCheck, BadgeCheck, Bell, ScrollText, SquareDashed, UserRoundKey,
  Settings, AppWindow, FilePlus2, FileInput, Package, Puzzle,
} from "lucide-react";
import { RigelMark } from "@/components/RigelMark";

/**
 * Nav icons are usually lucide icons, but the Assistant uses the Rigel mark.
 * Both accept this prop shape, so PanelMeta.icon is typed to the common surface.
 */
export type NavIcon = ComponentType<{
  size?: number;
  strokeWidth?: number;
  style?: CSSProperties;
  className?: string;
}>;

export interface PanelMeta {
  route: string;
  title: string;
  subtitle: string;
  icon: NavIcon;
}

export const PANEL_META: Record<string, PanelMeta> = {
  overview:     { route: "/overview",     title: "Overview",     subtitle: "Health at a glance",    icon: LayoutGrid },
  assistant:    { route: "/assistant",    title: "Assistant",    subtitle: "AI cluster operator",   icon: RigelMark },
  deployments:  { route: "/deployments",  title: "Deployments",  subtitle: "Rollouts & replicas",   icon: Layers },
  pods:         { route: "/pods",         title: "Pods",         subtitle: "Running containers",    icon: Box },
  workloads:    { route: "/workloads",    title: "Workloads",    subtitle: "All controllers",       icon: Boxes },
  rightsizing:  { route: "/rightsizing",  title: "Right-sizing", subtitle: "Resource tuning",       icon: Gauge },
  services:     { route: "/services",     title: "Services",     subtitle: "Internal networking",   icon: Network },
  ingresses:    { route: "/ingresses",    title: "Ingresses",    subtitle: "External routing",      icon: Signpost },
  configmaps:   { route: "/configmaps",   title: "ConfigMaps",   subtitle: "App configuration",    icon: FileText },
  secrets:      { route: "/secrets",      title: "Secrets",      subtitle: "Sensitive config",      icon: KeyRound },
  storage:      { route: "/storage",      title: "Storage",      subtitle: "Volumes & claims",      icon: HardDrive },
  databases:    { route: "/databases",    title: "Databases",    subtitle: "Stateful stores",       icon: Database },
  backups:      { route: "/backups",      title: "Backups",      subtitle: "Snapshots & backups",   icon: DatabaseBackup },
  namespaces:   { route: "/namespaces",   title: "Namespaces",   subtitle: "Logical partitions",    icon: SquareDashed },
  nodes:        { route: "/nodes",        title: "Nodes",        subtitle: "Cluster machines",      icon: Server },
  connectivity: { route: "/connectivity", title: "Connectivity", subtitle: "Traffic & reachability",icon: GitBranch },
  rbac:         { route: "/rbac",         title: "RBAC",         subtitle: "Access control",        icon: ShieldCheck },
  certificates: { route: "/certificates", title: "Certificates", subtitle: "TLS & cert-manager",    icon: BadgeCheck },
  events:       { route: "/events",       title: "Events",       subtitle: "Recent activity",       icon: Bell },
  logs:         { route: "/logs",         title: "Logs",         subtitle: "Container output",      icon: ScrollText },
  catalog:      { route: "/catalog",      title: "Apps",         subtitle: "Install apps",          icon: AppWindow },
  helm:         { route: "/helm",         title: "Helm",         subtitle: "Releases & charts",     icon: Package },
  plugins:      { route: "/plugins",      title: "Plugins",      subtitle: "Cluster add-ons",       icon: Puzzle },
  apply:        { route: "/apply",        title: "Apply YAML",   subtitle: "Create from manifest",  icon: FilePlus2 },
  compose:      { route: "/compose",      title: "Migrate from Compose", subtitle: "Convert a docker-compose.yml to Kubernetes manifests", icon: FileInput },
  gitops:       { route: "/gitops",       title: "GitOps",       subtitle: "Deploy from Git",       icon: GitBranch },
  accounts:     { route: "/accounts",     title: "Accounts",     subtitle: "Registry credentials",  icon: UserRoundKey },
  settings:     { route: "/settings",     title: "Settings",     subtitle: "Preferences",           icon: Settings },
};

export interface NavGroup {
  title: string | null;
  panels: string[]; // panel keys
}

export const NAV_GROUPS: NavGroup[] = [
  { title: null, panels: ["overview", "assistant"] },
  { title: "Workloads", panels: ["deployments", "pods", "workloads", "rightsizing"] },
  { title: "Networking", panels: ["services", "ingresses"] },
  { title: "Config & Storage", panels: ["configmaps", "secrets", "storage", "databases", "backups"] },
  { title: "Cluster", panels: ["namespaces", "nodes", "connectivity", "rbac"] },
  { title: "Security & Certs", panels: ["certificates"] },
  { title: "Observability", panels: ["events", "logs"] },
  { title: "Self-host", panels: ["catalog", "helm", "plugins"] },
  { title: "Tools", panels: ["apply", "compose", "gitops"] },
  { title: "System", panels: ["accounts", "settings"] },
];
