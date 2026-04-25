import { CloudDownload, ExternalLink, Tag } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ExternalViewer, HistoryEntryDetail, WebviewMessage } from "@perplexity-user-mcp/shared";
import { Markdown } from "../markdown";
import { AttachmentsList } from "./AttachmentsList";
import { DownloadMenu } from "./DownloadMenu";
import { OpenWithMenu } from "./OpenWithMenu";
import { useDashboardStore } from "../store";
import { PromptModal } from "./PromptModal";

type SendFn = (message: WebviewMessage | Omit<Extract<WebviewMessage, { id: string }>, "id">) => void;

export function RichView({
  entry,
  viewers,
  send,
  onClose,
}: {
  entry: HistoryEntryDetail;
  viewers: ExternalViewer[];
  send: SendFn;
  onClose: () => void;
}) {
  const cloudHydrate = useDashboardStore((s) => s.cloudHydrate);
  const hydrating = cloudHydrate.historyId === entry.id && cloudHydrate.phase === "starting";
  const needsHydration = entry.source === "cloud" && !entry.cloudHydratedAt;
  const autoTriggered = useRef<string | null>(null);
  const [tagPromptOpen, setTagPromptOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Auto-fetch the real content on first open of a cloud stub.
  useEffect(() => {
    if (!needsHydration) return;
    if (hydrating) return;
    if (autoTriggered.current === entry.id) return;
    autoTriggered.current = entry.id;
    send({ type: "history:cloud-hydrate", payload: { historyId: entry.id } });
  }, [entry.id, needsHydration, hydrating, send]);

  const updateTags = () => {
    setTagPromptOpen(true);
  };

  const handleTagConfirm = (next: string) => {
    setTagPromptOpen(false);
    send({
      type: "history:tag",
      payload: {
        historyId: entry.id,
        tags: next.split(",").map((tag) => tag.trim()).filter(Boolean),
      },
    });
  };

  return (
    <>
    <PromptModal
      open={tagPromptOpen}
      title="Edit tags"
      description="Enter comma-separated tags for this entry."
      defaultValue={(entry.tags ?? []).join(", ")}
      placeholder="tag1, tag2, …"
      confirmLabel="Save"
      onConfirm={handleTagConfirm}
      onCancel={() => setTagPromptOpen(false)}
    />
    <div className="rich-view-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="rich-view-panel glass-panel" onClick={(event) => event.stopPropagation()}>
        <div className="rich-view-header">
          <div className="rich-view-title-block">
            <div className="eyebrow">Rich View</div>
            <div className="title rich-view-title">{entry.query}</div>
            <div className="detail rich-view-detail">
              {entry.tool} · {entry.model ?? "default"} · {entry.status ?? "completed"}
            </div>
          </div>
          <div className="rich-view-actions">
            <button className="ghost-button btn-sm" onClick={() => send({ type: "history:open-preview", payload: { historyId: entry.id } })}>
              Preview
            </button>
            <DownloadMenu item={entry} send={send} />
            <OpenWithMenu item={entry} viewers={viewers} send={send} />
            <button className="ghost-button btn-sm" onClick={() => send({ type: "history:pin", payload: { historyId: entry.id, pinned: !entry.pinned } })}>
              {entry.pinned ? "Unpin" : "Pin"}
            </button>
            <button className="ghost-button btn-sm" onClick={updateTags}>
              <Tag size={13} />
              Tags
            </button>
            <button className="danger-button btn-sm" onClick={() => send({ type: "history:delete", payload: { historyId: entry.id } })}>
              Delete
            </button>
            <button className="ghost-button btn-sm" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div className="rich-view-grid">
          <div className="rich-view-body">
            {entry.source === "cloud" && !entry.cloudHydratedAt ? (
              <div className="glass-panel section-panel rich-view-cloud-card">
                <div className="rich-view-cloud-row">
                  <CloudDownload size={14} />
                  <span className="rich-view-cloud-message">
                    {hydrating ? "Fetching thread from Perplexity…" : cloudHydrate.phase === "error" && cloudHydrate.historyId === entry.id ? `Fetch failed: ${cloudHydrate.error}` : "Cloud thread — fetching details…"}
                  </span>
                  {cloudHydrate.phase === "error" && cloudHydrate.historyId === entry.id ? (
                    <button
                      className="ghost-button btn-sm rich-view-cloud-retry"
                      onClick={() => send({ type: "history:cloud-hydrate", payload: { historyId: entry.id } })}
                    >
                      Retry
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            <Markdown content={entry.body} />
          </div>
          <div className="rich-view-sidebar">
            <div className="glass-panel section-panel">
              <div className="eyebrow">Metadata</div>
              <div className="flex flex-wrap gap-2 mt-2">
                {entry.tier ? <span className="chip chip-accent">{entry.tier}</span> : null}
                {entry.status ? <span className="chip chip-neutral">{entry.status}</span> : null}
                {entry.pinned ? <span className="chip chip-pro">Pinned</span> : null}
                {entry.source === "cloud" ? (
                  <span className="chip chip-muted" title={entry.cloudHydratedAt ? `Fetched ${entry.cloudHydratedAt}` : "Stub — open to fetch"}>
                    {entry.cloudHydratedAt ? "Cloud" : "Cloud (stub)"}
                  </span>
                ) : null}
                {entry.tags?.map((tag) => (
                  <span key={tag} className="chip chip-muted">{tag}</span>
                ))}
              </div>
              {entry.threadUrl ? (
                <a className="hist-source-link rich-view-thread-link" href={entry.threadUrl}>
                  <ExternalLink size={12} />
                  Open thread on Perplexity
                </a>
              ) : null}
            </div>

            <div className="glass-panel section-panel">
              <div className="eyebrow">Sources</div>
              <div className="flex flex-col gap-2 mt-2">
                {entry.sources?.length ? entry.sources.map((source) => (
                  <a key={`${source.n}-${source.url}`} className="hist-source-link" href={source.url}>
                    <strong>{source.n}.</strong> {source.title || source.url}
                  </a>
                )) : <div className="empty-state">No structured sources saved for this entry.</div>}
              </div>
            </div>

            <div className="glass-panel section-panel">
              <div className="eyebrow">Attachments</div>
              <div className="mt-2">
                <AttachmentsList attachments={entry.attachments} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    </>
  );
}
