/**
 * ChatHistorySheet — modal listing saved conversations (mirrors the Swift
 * ChatHistorySheet). Click a row to resume it; trash to delete. Searchable.
 */
import { useEffect, useState } from "react";
import { Clock, X, Search, Trash2, MessagesSquare } from "lucide-react";
import { ageDescription, type ChatHistoryEntry } from "./chatHistory";

interface Props {
  open: boolean;
  entries: ChatHistoryEntry[];
  onResume: (entry: ChatHistoryEntry) => void;
  onDelete: (entry: ChatHistoryEntry) => void;
  onClose: () => void;
}

export function ChatHistorySheet({ open, entries, onResume, onDelete, onClose }: Props) {
  const [search, setSearch] = useState("");

  // Escape closes the sheet (parity with the Sheet/Dialog-based modals).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const q = search.trim().toLowerCase();
  const filtered = q
    ? entries.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          e.messages.some((m) => m.text.toLowerCase().includes(q)),
      )
    : entries;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(560px, 92vw)",
          height: "min(540px, 86vh)",
          display: "flex",
          flexDirection: "column",
          background: "#141417",
          border: "1px solid #2A2A2A",
          borderRadius: 12,
          boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderBottom: "1px solid #1A1A1A" }}>
          <Clock size={14} style={{ color: "#A855F7" }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: "#FFFFFF" }}>Chat history</span>
          <span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 10, color: "#6B6B73" }}>{entries.length}</span>
          <div style={{ flex: 1 }} />
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, borderRadius: 6, background: "#0A0A0C", border: "1px solid #2A2A2A", color: "#A1A1AA", cursor: "pointer" }}
          >
            <X size={12} />
          </button>
        </div>

        {/* Search */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderBottom: "1px solid #1A1A1A" }}>
          <Search size={13} style={{ color: "#6B6B73", flexShrink: 0 }} />
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title or messages…"
            style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "#FFFFFF", fontSize: 12, fontFamily: "var(--font-mono, monospace)" }}
          />
        </div>

        {/* Body */}
        {filtered.length === 0 ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, color: "#6B6B73" }}>
            <MessagesSquare size={30} style={{ color: "#3A3A3A" }} />
            <div style={{ fontSize: 13, fontWeight: 500, color: "#A1A1AA" }}>
              {entries.length === 0 ? "No saved chats yet" : "No matches"}
            </div>
            <div style={{ fontSize: 12 }}>
              {entries.length === 0 ? "Conversations are saved once you send a message." : "Try a different search."}
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, overflowY: "auto", padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            {filtered.map((e) => (
              <div
                key={e.id}
                onClick={() => onResume(e)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 12px",
                  background: "#18181C",
                  border: "1px solid #26262C",
                  borderRadius: 8,
                  cursor: "pointer",
                }}
                onMouseEnter={(ev) => (ev.currentTarget.style.borderColor = "#3A3A3A")}
                onMouseLeave={(ev) => (ev.currentTarget.style.borderColor = "#26262C")}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500, color: "#FFFFFF", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {e.title}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3 }}>
                    <span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 10, color: "#6B6B73" }}>{ageDescription(e.updatedAt)}</span>
                    <span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 10, color: "#6B6B73" }}>
                      {e.messages.length} msg{e.messages.length === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>
                <button
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onDelete(e);
                  }}
                  title="Delete chat"
                  aria-label="Delete chat"
                  style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, borderRadius: 6, background: "#0A0A0C", border: "1px solid #2A2A2A", color: "#6B6B73", cursor: "pointer", flexShrink: 0 }}
                  onMouseEnter={(ev) => (ev.currentTarget.style.color = "#EF4444")}
                  onMouseLeave={(ev) => (ev.currentTarget.style.color = "#6B6B73")}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
