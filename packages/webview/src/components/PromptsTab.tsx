import { useState } from "react";
import { ArrowLeft, Info, Plus, RotateCcw, Save, SquareSlash, Trash2, X } from "lucide-react";
import type { PromptArg, PromptDef, WebviewMessage } from "@perplexity-user-mcp/shared";

type SendFn = (m: WebviewMessage | Omit<Extract<WebviewMessage, { id: string }>, "id">) => void;

/** Mirrors CUSTOM_NAME_RE in mcp-server/src/prompts-config.ts. */
const NAME_RE = /^[a-z][a-z0-9-]*$/;

function emptyPrompt(): PromptDef {
  return { name: "", description: "", arguments: [], template: "", isBuiltin: false, isModified: false };
}

function ReconnectNotice() {
  return (
    <div className="prompts-notice" role="note">
      <Info size={13} className="prompts-notice-icon" />
      <div>
        <span className="prompts-notice-strong">Reconnect required after changes. </span>
        MCP clients cache prompts at connect-time. After saving:
        <ul className="prompts-notice-list">
          <li><b>Cursor / Windsurf</b> — Reload Window</li>
          <li><b>Claude Code</b> — restart the session or run <code className="code-pill">/mcp</code></li>
          <li><b>Claude Desktop</b> — restart the app</li>
        </ul>
        <span className="prompts-notice-muted">The embedded daemon picks up changes on the next connection automatically.</span>
      </div>
    </div>
  );
}

function ArgRow({
  arg,
  onChange,
  onRemove,
}: {
  arg: PromptArg;
  onChange: (updated: PromptArg) => void;
  onRemove: () => void;
}) {
  return (
    <div className="prompts-arg-row">
      <input
        className="setting-input prompts-arg-name"
        value={arg.name}
        onChange={(e) => onChange({ ...arg, name: e.target.value })}
        placeholder="name"
        aria-label="Argument name"
      />
      <input
        className="setting-input prompts-arg-desc"
        value={arg.description}
        onChange={(e) => onChange({ ...arg, description: e.target.value })}
        placeholder="description"
        aria-label="Argument description"
      />
      <label className="prompts-arg-req">
        <input
          type="checkbox"
          checked={arg.required}
          onChange={(e) => onChange({ ...arg, required: e.target.checked })}
          aria-label="Required"
        />
        req
      </label>
      <button className="ghost-button btn-sm prompts-arg-remove" onClick={onRemove} aria-label="Remove argument">
        <X size={12} />
      </button>
    </div>
  );
}

function PromptEditor({
  initial,
  isNew,
  send,
  onBack,
}: {
  initial: PromptDef;
  isNew: boolean;
  send: SendFn;
  onBack: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [args, setArgs] = useState<PromptArg[]>(initial.arguments);
  const [template, setTemplate] = useState(initial.template);
  const [dirty, setDirty] = useState(isNew);

  const nameValid = initial.isBuiltin || NAME_RE.test(name);
  const canSave = dirty && nameValid && template.trim().length > 0;

  function markDirty() {
    setDirty(true);
  }

  function handleSave() {
    if (!canSave) return;
    send({
      type: "prompts:save",
      payload: {
        prompt: { name, description, arguments: args, template, isBuiltin: initial.isBuiltin, isModified: initial.isBuiltin },
      },
    });
    onBack();
  }

  function handleDelete() {
    send({ type: "prompts:delete", payload: { name: initial.name } });
    onBack();
  }

  function handleReset() {
    send({ type: "prompts:reset", payload: { name: initial.name } });
    onBack();
  }

  return (
    <div className="grid gap-3">
      <div className="glass-panel section-panel grid gap-3">
        <button className="prompts-back" onClick={onBack}>
          <ArrowLeft size={12} /> Back to prompts
        </button>

        <ReconnectNotice />

        <div className="prompts-editor-title">
          <span className="font-mono">{isNew ? "New prompt" : `/${initial.name}`}</span>
          {initial.isBuiltin ? <span className="chip chip-accent">built-in</span> : null}
          {initial.isModified ? <span className="chip chip-warn">modified</span> : null}
        </div>

        <div>
          <label className="prompts-label">Slash command name</label>
          <input
            className="setting-input font-mono"
            value={name}
            disabled={initial.isBuiltin}
            onChange={(e) => {
              setName(e.target.value);
              markDirty();
            }}
            placeholder="my-prompt"
            aria-label="Prompt name"
          />
          {!nameValid && name.length > 0 ? (
            <div className="prompts-error">Lowercase letters, digits, and hyphens only (must start with a letter).</div>
          ) : (
            <div className="prompts-hint">
              Appears as <code className="code-pill">/{name || "…"}</code> in MCP clients.
            </div>
          )}
        </div>

        <div>
          <label className="prompts-label">Description</label>
          <input
            className="setting-input"
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              markDirty();
            }}
            placeholder="What this prompt does"
            aria-label="Prompt description"
          />
        </div>

        <div>
          <div className="prompts-args-head">
            <label className="prompts-label">Arguments</label>
            <button
              className="ghost-button btn-sm"
              onClick={() => {
                setArgs((a) => [...a, { name: "", description: "", required: false }]);
                markDirty();
              }}
            >
              <Plus size={11} /> Add
            </button>
          </div>
          {args.length === 0 ? (
            <div className="prompts-hint">No arguments — this prompt has no user-fillable slots.</div>
          ) : (
            <div className="grid gap-1.5">
              {args.map((arg, i) => (
                <ArgRow
                  key={i}
                  arg={arg}
                  onChange={(u) => {
                    setArgs((a) => a.map((x, idx) => (idx === i ? u : x)));
                    markDirty();
                  }}
                  onRemove={() => {
                    setArgs((a) => a.filter((_, idx) => idx !== i));
                    markDirty();
                  }}
                />
              ))}
            </div>
          )}
          <div className="prompts-hint">
            Use <code className="code-pill">{"{argName}"}</code> in the template to insert argument values.
          </div>
        </div>

        <div>
          <label className="prompts-label">Template</label>
          <textarea
            className="setting-input prompts-template"
            value={template}
            onChange={(e) => {
              setTemplate(e.target.value);
              markDirty();
            }}
            rows={10}
            spellCheck={false}
            aria-label="Prompt template"
          />
        </div>

        <div className="prompts-actions">
          <button className="primary-button" disabled={!canSave} onClick={handleSave}>
            <Save size={12} /> Save
          </button>
          {initial.isBuiltin && initial.isModified ? (
            <button className="ghost-button" onClick={handleReset}>
              <RotateCcw size={12} /> Reset to default
            </button>
          ) : null}
          {!initial.isBuiltin && !isNew ? (
            <button className="danger-button" onClick={handleDelete}>
              <Trash2 size={12} /> Delete
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function PromptsTab({ prompts, send }: { prompts: PromptDef[]; send: SendFn }) {
  const [editing, setEditing] = useState<{ prompt: PromptDef; isNew: boolean } | null>(null);

  if (editing) {
    return (
      <PromptEditor
        initial={editing.prompt}
        isNew={editing.isNew}
        send={send}
        onBack={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="grid gap-3">
      <div className="glass-panel section-panel grid gap-3">
        <div className="section-header">
          <div className="section-header-row">
            <div className="section-header-copy">
              <div className="eyebrow">MCP</div>
              <div className="title">Prompts</div>
              <div className="detail">
                Reusable slash commands available in Claude, Cursor, and every other connected MCP client.
              </div>
            </div>
            <div className="section-header-action">
              <button className="ghost-button btn-sm" onClick={() => setEditing({ prompt: emptyPrompt(), isNew: true })}>
                <Plus size={13} /> New prompt
              </button>
            </div>
          </div>
        </div>

        <ReconnectNotice />

        {prompts.length === 0 ? (
          <div className="empty-state">No prompts yet. Create one with the New prompt button.</div>
        ) : (
          <div className="grid gap-2">
            {prompts.map((p) => (
              <button key={p.name} className="action-card" onClick={() => setEditing({ prompt: p, isNew: false })}>
                <div className="icon-badge">
                  <SquareSlash size={13} />
                </div>
                <div className="action-card-body">
                  <div className="action-card-title prompts-card-title">
                    <span className="font-mono">/{p.name}</span>
                    {p.isBuiltin ? <span className="chip chip-muted">built-in</span> : null}
                    {p.isModified ? <span className="chip chip-warn">modified</span> : null}
                  </div>
                  <div className="action-card-desc">{p.description}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
