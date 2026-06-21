import type { ComponentType } from "react";
import { Monitor, Laptop, Server, Database, HardDrive, House, Building2, Boxes, Cloud } from "lucide-react";
import { SiKubernetes, SiGooglecloud, SiDigitalocean } from "react-icons/si";
import { FaAws } from "react-icons/fa";
import { VscAzure } from "react-icons/vsc";
import type { ProviderKind } from "./clusterTile";

/** An icon a cluster tile can display. */
export type IconId =
  | "monitor" | "laptop" | "server" | "database" | "harddrive" | "home" | "building" | "boxes" | "cloud"
  | "aws" | "gcp" | "azure" | "digitalocean" | "kubernetes";

type IconEntry = { label: string; Component: ComponentType<{ size?: number; className?: string }> };

/** id → label + component. Brand marks (react-icons) + general icons (lucide). */
export const CLUSTER_ICONS: Record<IconId, IconEntry> = {
  monitor: { label: "Local / desktop", Component: Monitor },
  laptop: { label: "Laptop", Component: Laptop },
  server: { label: "Server", Component: Server },
  database: { label: "Database", Component: Database },
  harddrive: { label: "Storage", Component: HardDrive },
  home: { label: "Home / homelab", Component: House },
  building: { label: "Org / on-prem", Component: Building2 },
  boxes: { label: "Cluster", Component: Boxes },
  cloud: { label: "Cloud", Component: Cloud },
  // Brand marks — react-icons/si doesn't have AWS or Azure in v5.6.0;
  // using FaAws (Font Awesome) for AWS and VscAzure (VS Code icons) for Azure.
  aws: { label: "Amazon Web Services", Component: FaAws as ComponentType<{ size?: number; className?: string }> },
  gcp: { label: "Google Cloud", Component: SiGooglecloud as ComponentType<{ size?: number; className?: string }> },
  azure: { label: "Microsoft Azure", Component: VscAzure as ComponentType<{ size?: number; className?: string }> },
  digitalocean: { label: "DigitalOcean", Component: SiDigitalocean as ComponentType<{ size?: number; className?: string }> },
  kubernetes: { label: "Kubernetes", Component: SiKubernetes as ComponentType<{ size?: number; className?: string }> },
};

/** Order of icons in the right-click picker grid. */
export const ICON_PALETTE: IconId[] = [
  "monitor", "laptop", "server", "boxes", "kubernetes",
  "aws", "gcp", "azure", "digitalocean", "cloud",
  "database", "harddrive", "home", "building",
];

/** The auto-detected default icon for a provider class. */
export function providerDefaultIcon(kind: ProviderKind): IconId {
  switch (kind) {
    case "local": return "monitor";
    case "aws": return "aws";
    case "gcp": return "gcp";
    case "azure": return "azure";
    case "digitalocean": return "digitalocean";
    case "generic": return "kubernetes";
  }
}
