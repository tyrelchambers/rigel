// Maps catalog `iconSystemName` (Apple SF Symbol names) to astro-icon Lucide
// names ("lucide:<kebab>"). Ported from apps/web/src/panels/catalog/icons.tsx
// (the source of truth for the 19 it covers); the rest are closest-sensible
// matches. Every name here is verified against @iconify-json/lucide.

export const SF_TO_LUCIDE: Record<string, string> = {
  // --- from the web app's icon map (source of truth) ---
  "arrow.triangle.branch": "lucide:git-branch",
  "chart.bar.fill": "lucide:bar-chart-3",
  "chart.line.uptrend.xyaxis": "lucide:line-chart",
  "chevron.left.forwardslash.chevron.right": "lucide:code",
  "cloud.fill": "lucide:cloud",
  curlybraces: "lucide:code",
  "cylinder.split.1x2.fill": "lucide:database",
  "doc.text.fill": "lucide:file-text",
  "film.fill": "lucide:film",
  "flag.fill": "lucide:flag",
  globe: "lucide:globe",
  "lock.shield.fill": "lucide:shield-check",
  "megaphone.fill": "lucide:megaphone",
  "music.note": "lucide:music",
  "newspaper.fill": "lucide:newspaper",
  "paperplane.fill": "lucide:send",
  "photo.stack.fill": "lucide:image",
  "shippingbox.fill": "lucide:container",
  "waveform.path.ecg": "lucide:activity",

  // --- closest sensible matches ---
  "archivebox.fill": "lucide:archive",
  "bell.badge.fill": "lucide:bell-ring",
  "bolt.horizontal.fill": "lucide:wifi",
  "book.closed.fill": "lucide:book",
  "bookmark.fill": "lucide:bookmark",
  "books.vertical.fill": "lucide:library",
  checklist: "lucide:list-checks",
  "checkmark.shield.fill": "lucide:shield-check",
  "doc.on.doc.fill": "lucide:file-stack",
  "doc.text.magnifyingglass": "lucide:file-search",
  "dot.radiowaves.up.forward": "lucide:radio-tower",
  "ellipsis.message.fill": "lucide:message-circle-more",
  "exclamationmark.octagon.fill": "lucide:octagon-alert",
  "externaldrive.fill.badge.person.crop": "lucide:hard-drive",
  "hammer.fill": "lucide:hammer",
  headphones: "lucide:headphones",
  "list.bullet.clipboard.fill": "lucide:clipboard-list",
  "lock.rectangle.stack.fill": "lucide:folder-lock",
  "macwindow.on.rectangle": "lucide:app-window",
  "note.text": "lucide:sticky-note",
  "paintpalette.fill": "lucide:palette",
  "pencil.and.outline": "lucide:pencil-ruler",
  "person.badge.key.fill": "lucide:user-cog",
  "person.crop.rectangle.fill": "lucide:contact",
  "person.crop.rectangle.stack.fill": "lucide:users",
  "rectangle.3.group.fill": "lucide:layout-grid",
  "scribble.variable": "lucide:spline",
  "shippingbox.and.arrow.backward.fill": "lucide:package-x",
  "square.grid.3x3.square": "lucide:grid-3x3",
  tablecells: "lucide:table",
  "tablecells.fill": "lucide:table",
  "ticket.fill": "lucide:ticket",
  "tray.full.fill": "lucide:inbox",
  wind: "lucide:wind",
  "wrench.and.screwdriver.fill": "lucide:wrench",
};

// Display metadata for each catalog category, in the order they appear on the
// page. Section icons are verified Lucide names.
export const CATEGORY_META: Record<
  string,
  { label: string; icon: string; order: number }
> = {
  "dev-tools": { label: "Dev tools", icon: "lucide:wrench", order: 1 },
  productivity: { label: "Productivity", icon: "lucide:check-square", order: 2 },
  database: { label: "Databases", icon: "lucide:database", order: 3 },
  observability: { label: "Observability", icon: "lucide:activity", order: 4 },
  network: { label: "Networking", icon: "lucide:network", order: 5 },
  media: { label: "Media", icon: "lucide:film", order: 6 },
};

const CATEGORY_FALLBACK_ICON: Record<string, string> = {
  "dev-tools": "lucide:wrench",
  productivity: "lucide:check-square",
  observability: "lucide:activity",
  database: "lucide:database",
  network: "lucide:network",
  media: "lucide:film",
};

export function iconForApp(app: {
  iconSystemName?: string | null;
  category: string;
}): string {
  return (
    (app.iconSystemName && SF_TO_LUCIDE[app.iconSystemName]) ||
    CATEGORY_FALLBACK_ICON[app.category] ||
    "lucide:package"
  );
}
