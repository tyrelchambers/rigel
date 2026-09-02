import type { ComponentType, CSSProperties } from "react";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faTableColumns, faLayerGroup, faCube, faBoxesStacked, faGauge, faServer,
  faCodeBranch, faSignsPost, faNetworkWired, faDatabase, faKey, faFileLines,
  faHardDrive, faShieldCheck, faCircleCheck, faBell, faScroll, faSquareDashed,
  faUserLock, faGear, faWindowMaximize, faFilePlus, faFileImport, faBox, faPuzzlePiece,
  faReceipt, faListCheck, faBoxArchive,
} from "@awesome.me/kit-6050953220/icons/classic/solid";
import { RigelMark } from "@/components/RigelMark";

/** A nav glyph is a Font Awesome icon def, or a component (RigelMark). */
export type NavIcon =
  | IconDefinition
  | ComponentType<{
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
  overview:     { route: "/overview",     title: "Overview",     subtitle: "Health at a glance",    icon: faTableColumns },
  assistant:    { route: "/assistant",    title: "Assistant",    subtitle: "AI cluster operator",   icon: RigelMark },
  deployments:  { route: "/deployments",  title: "Deployments",  subtitle: "Rollouts & replicas",   icon: faLayerGroup },
  pods:         { route: "/pods",         title: "Pods",         subtitle: "Running containers",    icon: faCube },
  workloads:    { route: "/workloads",    title: "Workloads",    subtitle: "All controllers",       icon: faBoxesStacked },
  rightsizing:  { route: "/rightsizing",  title: "Right-sizing", subtitle: "Resource tuning",       icon: faGauge },
  services:     { route: "/services",     title: "Services",     subtitle: "Internal networking",   icon: faNetworkWired },
  ingresses:    { route: "/ingresses",    title: "Ingresses",    subtitle: "External routing",      icon: faSignsPost },
  configmaps:   { route: "/configmaps",   title: "ConfigMaps",   subtitle: "App configuration",    icon: faFileLines },
  secrets:      { route: "/secrets",      title: "Secrets",      subtitle: "Sensitive config",      icon: faKey },
  storage:      { route: "/storage",      title: "Storage",      subtitle: "Volumes & claims",      icon: faHardDrive },
  databases:    { route: "/databases",    title: "Databases",    subtitle: "Stateful stores",       icon: faDatabase },
  backups:      { route: "/backups",      title: "Backups",      subtitle: "Snapshots & backups",   icon: faDatabase },
  namespaces:   { route: "/namespaces",   title: "Namespaces",   subtitle: "Logical partitions",    icon: faSquareDashed },
  nodes:        { route: "/nodes",        title: "Nodes",        subtitle: "Cluster machines",      icon: faServer },
  connectivity: { route: "/connectivity", title: "Connectivity", subtitle: "Traffic & reachability",icon: faCodeBranch },
  rbac:         { route: "/rbac",         title: "RBAC",         subtitle: "Access control",        icon: faShieldCheck },
  certificates: { route: "/certificates", title: "Certificates", subtitle: "TLS & cert-manager",    icon: faCircleCheck },
  orders:       { route: "/orders",       title: "Orders",       subtitle: "ACME orders",           icon: faReceipt },
  challenges:   { route: "/challenges",   title: "Challenges",   subtitle: "ACME validation",       icon: faListCheck },
  events:       { route: "/events",       title: "Events",       subtitle: "Recent activity",       icon: faBell },
  logs:         { route: "/logs",         title: "Logs",         subtitle: "Container output",      icon: faScroll },
  catalog:      { route: "/catalog",      title: "Apps",         subtitle: "Install apps",          icon: faWindowMaximize },
  helm:         { route: "/helm",         title: "Helm",         subtitle: "Releases & charts",     icon: faBox },
  plugins:      { route: "/plugins",      title: "Plugins",      subtitle: "Cluster add-ons",       icon: faPuzzlePiece },
  apply:        { route: "/apply",        title: "Apply YAML",   subtitle: "Create from manifest",  icon: faFilePlus },
  compose:      { route: "/compose",      title: "Migrate from Compose", subtitle: "Convert a docker-compose.yml to Kubernetes manifests", icon: faFileImport },
  failover:     { route: "/failover",     title: "Failover",     subtitle: "Storm-time DigitalOcean copy", icon: faBoxArchive },
  gitops:       { route: "/gitops",       title: "GitOps",       subtitle: "Deploy from Git",       icon: faCodeBranch },
  accounts:     { route: "/accounts",     title: "Accounts",     subtitle: "Registry credentials",  icon: faUserLock },
  settings:     { route: "/settings",     title: "Settings",     subtitle: "Preferences",           icon: faGear },
};

export interface NavGroup {
  title: string | null;
  panels: string[];
}

export const NAV_GROUPS: NavGroup[] = [
  { title: null, panels: ["overview", "assistant"] },
  { title: "Workloads", panels: ["deployments", "pods", "workloads", "rightsizing"] },
  { title: "Networking", panels: ["services", "ingresses"] },
  { title: "Config & Storage", panels: ["configmaps", "secrets", "storage", "databases", "backups"] },
  { title: "Cluster", panels: ["namespaces", "nodes", "connectivity", "rbac"] },
  { title: "Security & Certs", panels: ["certificates", "orders", "challenges"] },
  { title: "Observability", panels: ["events", "logs"] },
  { title: "Self-host", panels: ["catalog", "helm", "plugins"] },
  { title: "Tools", panels: ["apply", "compose", "failover", "gitops"] },
  { title: "System", panels: ["accounts", "settings"] },
];
