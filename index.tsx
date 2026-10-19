import { useEffect, useState, useSyncExternalStore } from "react";
import type { PluginApi, PluginContext } from "stewrd-plugin-api";
import { openInBrowser } from "./github.ts";
import { parsePrUrl, stateColor } from "./model.ts";
import type { Item, Role } from "./model.ts";
import { killAll, pollAll, processItem } from "./poll.ts";
import { flush, getState, init, newId, reloadSettings, subscribe, update } from "./store.ts";
import { setViewing } from "./status.ts";

const WAKE_MS = 2000;
const MS_PER_MINUTE = 60 * 1000;

export async function activate(ctx: PluginContext) {
  await init(ctx.api, ctx.signal);
  let minutes = 0;
  const tick = async () => {
    const settings = await reloadSettings();
    if (settings.pollMinutes !== minutes) {
      minutes = settings.pollMinutes;
      ctx.tick.setInterval(minutes * MS_PER_MINUTE);
    }
    await pollAll();
  };
  // Fire and forget: a poll waits on Claude and would trip the host's 30s tick watchdog.
  ctx.tick.register(() => {
    void tick();
  });
  // statusIcon.set is a no-op until the host registers this plugin, so poll shortly after startup.
  ctx.tick.requestWake(WAKE_MS);
  ctx.onDispose(() => {
    killAll();
    flush();
  });
}

const tabs: { label: string; value: Role }[] = [
  { label: "Author", value: "author" },
  { label: "Reviewer", value: "reviewer" },
];

type Dialog = "add" | "prompt" | null;

export function Component({ api }: { api: PluginApi }) {
  const { data, settings } = useSyncExternalStore(subscribe, getState);
  const palette = api.theme.palette;
  const { Tabs, TextButton } = api.ui;
  const [role, setRole] = useState<Role>("author");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [, setThemeVersion] = useState(0); // re-render on theme switches

  useEffect(() => {
    setViewing(true);
    const unsubscribe = api.theme.subscribe(() => setThemeVersion((v) => v + 1));
    return () => {
      setViewing(false);
      unsubscribe();
    };
  }, [api]);

  const items = data.items.filter((i) => i.role === role).sort((a, b) => b.createdAt - a.createdAt);
  const prompt = data.prompts[role] ?? (role === "author" ? settings.authorPrompt : settings.reviewerPrompt);

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 8, position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, borderBottom: `1px solid ${palette.border}`, paddingBottom: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Tabs tabs={tabs} value={role} onChange={(v) => setRole(v as Role)} />
        </div>
        <TextButton label="Add Review" variant="primary" onClick={() => setDialog("add")} />
        <TextButton label="Edit Prompt" variant="secondary" onClick={() => setDialog("prompt")} />
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", scrollbarWidth: "thin", scrollbarColor: `${palette.border} ${palette.surface}` }}>
        {items.map((item) => (
          <Row key={item.id} api={api} item={item} />
        ))}
        {items.length === 0 && <div style={{ color: palette.textMuted, padding: 8 }}>No Pull Requests Yet</div>}
      </div>

      {dialog === "add" && <AddDialog api={api} role={role} onClose={() => setDialog(null)} />}
      {dialog === "prompt" && <PromptDialog api={api} role={role} initial={prompt} onClose={() => setDialog(null)} />}
    </div>
  );
}

function Row({ api, item }: { api: PluginApi; item: Item }) {
  const { StatusDot, TextButton } = api.ui;
  const palette = api.theme.palette;
  const remove = async () => {
    const ok = await api.modal.confirm({
      title: "Remove Review",
      message: `Stop tracking ${item.owner}/${item.repo}#${item.number}? This cannot be undone.`,
      confirmLabel: "Remove",
    });
    if (ok) update((d) => ({ ...d, items: d.items.filter((i) => i.id !== item.id) }));
  };
  return (
    <div style={{ padding: "4px 8px", borderBottom: `1px solid ${palette.border}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 32 }}>
        <StatusDot color={stateColor(item.state)} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</div>
          <div style={{ color: palette.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {item.owner}/{item.repo}#{item.number} · {item.state}
          </div>
        </div>
        <TextButton label="Open In Browser" variant="secondary" onClick={() => openInBrowser(api, item.url)} />
        <TextButton label="Remove" variant="secondary" onClick={remove} />
      </div>
      {item.state === "Failed" && item.error && (
        <div style={{ color: palette.status.error, padding: "0 0 4px 24px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{item.error}</div>
      )}
    </div>
  );
}

function AddDialog({ api, role, onClose }: { api: PluginApi; role: Role; onClose: () => void }) {
  const { TextBox, TextButton, InlineDialog } = api.ui;
  const palette = api.theme.palette;
  const [url, setUrl] = useState("");
  const [folder, setFolder] = useState("");
  const [session, setSession] = useState("");
  const parsed = parsePrUrl(url);

  const add = () => {
    if (!parsed) return;
    const sessionId = session.trim();
    const item: Item = {
      id: newId(),
      role,
      ...parsed,
      title: `${parsed.repo}#${parsed.number}`,
      workingFolder: folder.trim(),
      sessionId: sessionId || crypto.randomUUID(),
      userSession: !!sessionId,
      sessionStarted: !!sessionId,
      state: role === "reviewer" ? "Reviewing" : "Pending",
      initialDone: false,
      lastSeen: new Date().toISOString(),
      createdAt: Date.now(),
    };
    update((d) => ({ ...d, items: [...d.items, item] }));
    void processItem(item.id);
    onClose();
  };

  return (
    <InlineDialog open title={role === "author" ? "Add Author Review" : "Add Reviewer Review"} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 360 }} onKeyDown={(e) => e.key === "Enter" && add()}>
        <TextBox singleLine value={url} onChange={setUrl} placeholder="Pull Request URL" />
        {url.trim() && !parsed && <div style={{ color: palette.status.error }}>Enter A Full Pull Request URL</div>}
        <TextBox singleLine value={folder} onChange={setFolder} placeholder="Working Folder (Optional)" />
        <TextBox singleLine value={session} onChange={setSession} placeholder="Session ID (Optional, Needs Its Working Folder)" />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <TextButton label="Cancel" variant="secondary" onClick={onClose} />
          <TextButton label="Add Review" variant="primary" disabled={!parsed} onClick={add} />
        </div>
      </div>
    </InlineDialog>
  );
}

function PromptDialog({ api, role, initial, onClose }: { api: PluginApi; role: Role; initial: string; onClose: () => void }) {
  const { TextBox, TextButton, InlineDialog } = api.ui;
  const [text, setText] = useState(initial);
  const save = () => {
    update((d) => ({ ...d, prompts: { ...d.prompts, [role]: text.trim() || undefined } }));
    onClose();
  };
  return (
    <InlineDialog open title={role === "author" ? "Edit Author Prompt" : "Edit Reviewer Prompt"} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 420 }}>
        <TextBox rows={12} value={text} onChange={setText} placeholder="Prompt" />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <TextButton label="Cancel" variant="secondary" onClick={onClose} />
          <TextButton label="Save" variant="primary" onClick={save} />
        </div>
      </div>
    </InlineDialog>
  );
}
