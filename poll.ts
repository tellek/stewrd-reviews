// Background polling: decide per item whether anything changed that matters,
// run Claude only when it did, then re-evaluate the merge/approve gate.
import { killAll, resolveCwd, runClaude } from "./claude.ts";
import { approve, currentUser, fetchSnapshot, gitHead, gitPush, squashMerge } from "./github.ts";
import { INLINE_DELTA_LIMIT, TERMINAL, buildDelta, buildPrompt, evaluateGate, fingerprint, formatDelta, parseVerdict } from "./model.ts";
import type { Entry, Item, Snapshot, State, Verdict } from "./model.ts";
import { alive, busy, getApi, getItem, getState, patchItem } from "./store.ts";
import { setStatus } from "./status.ts";

let polling = false;

export { killAll };

/** Polls every open item once. Overlapping calls are ignored. */
export async function pollAll() {
  if (polling) return;
  polling = true;
  try {
    for (const item of getState().data.items) {
      if (!alive()) return;
      if (!TERMINAL.includes(item.state)) await processItem(item.id);
    }
  } finally {
    polling = false;
  }
}

export async function processItem(id: string) {
  if (busy.has(id) || !getItem(id)) return;
  busy.add(id);
  const api = getApi();
  try {
    const startedAt = new Date().toISOString();
    const me = await currentUser(api);
    const snap = await fetchSnapshot(api, getItem(id)!);
    if (!alive()) return;
    patchItem(id, { title: snap.title });

    if (snap.state === "OPEN") await assess(id, snap, me, startedAt);
    if (!alive()) return;
    await applyGate(id, snap);
  } catch (err) {
    if (!alive()) return;
    patchItem(id, { state: "Failed", error: err instanceof Error ? err.message : String(err) });
  } finally {
    busy.delete(id);
  }
}

/** Runs Claude when the initial review is outstanding or relevant activity arrived. */
async function assess(id: string, snap: Snapshot, me: string, startedAt: string) {
  const item = getItem(id)!;
  const { settings, data } = getState();
  const print = fingerprint(snap);

  if (!item.initialDone) {
    patchItem(id, { state: item.role === "reviewer" ? "Reviewing" : "Pending", error: undefined });
    const base = item.role === "reviewer" ? settings.initialReviewPrompt : (data.prompts.author ?? settings.authorPrompt);
    const entries = item.role === "author" ? buildDelta(snap.entries, "1970-01-01T00:00:00Z", me) : [];
    const verdict = await run(item, base, entries);
    if (!alive()) return;
    patchItem(id, { initialDone: true, verdict: verdict ?? item.verdict, fingerprint: print, headSha: snap.headSha, lastSeen: startedAt });
    return;
  }

  if (print === item.fingerprint) return;
  const delta = buildDelta(snap.entries, item.lastSeen, me);
  const fixedByHand = item.role === "author" && item.verdict === "needs_work" && item.headSha !== snap.headSha;
  let verdict: Verdict | undefined = item.verdict;
  if (delta.length > 0 || fixedByHand) {
    const base = data.prompts[item.role] ?? (item.role === "author" ? settings.authorPrompt : settings.reviewerPrompt);
    verdict = (await run(item, base, delta)) ?? verdict;
    if (!alive()) return;
  }
  patchItem(id, { verdict, fingerprint: print, headSha: snap.headSha, lastSeen: startedAt, error: undefined });
}

async function run(item: Item, base: string, entries: Entry[]): Promise<Verdict | undefined> {
  const api = getApi();
  const { settings } = getState();
  const cwd = await resolveCwd(api, item);
  const delta = formatDelta(entries);
  const oversize = delta.length > INLINE_DELTA_LIMIT;
  const deltaName = `delta-${item.id}.md`;
  const root = oversize ? await api.fs.getRootPath() : "";
  if (oversize) await api.fs.writeTextFile(deltaName, delta);
  const headBefore = item.role === "author" && item.workingFolder ? await gitHead(api, cwd) : "";
  try {
    const output = await runClaude(api, getItem(item.id)!, {
      prompt: buildPrompt(base, item.url, delta, oversize ? `${root}\\${deltaName}` : undefined),
      cwd,
      timeoutMs: settings.runTimeoutMinutes * 60000,
      extraArgs: oversize ? ["--add-dir", root] : undefined,
      onSpawned: () => alive() && patchItem(item.id, { sessionStarted: true }),
    });
    // Claude may commit but never pushes; the plugin pushes when HEAD moved.
    if (headBefore && (await gitHead(api, cwd)) !== headBefore) await gitPush(api, cwd);
    return parseVerdict(output);
  } finally {
    if (oversize && alive()) await api.fs.deleteFile(deltaName).catch(() => {});
  }
}

async function applyGate(id: string, snap: Snapshot) {
  const item = getItem(id)!;
  const gate = evaluateGate(item, snap, getState().settings);
  let next: State = gate.state;
  if (gate.action === "merge") {
    await squashMerge(getApi(), item);
    next = "Merged";
  } else if (gate.action === "approve") {
    await approve(getApi(), item);
    next = "Approved";
  }
  if (!alive()) return;
  patchItem(id, { state: next, error: undefined });
  if ((next === "Merged" || next === "Approved") && item.state !== next) setStatus(getApi(), "event", "success", `${item.title} ${next.toLowerCase()}`);
}
