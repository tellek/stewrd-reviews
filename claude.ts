// Every AI call goes through api.ai.run, so it uses whichever provider the
// user configured in Stewrd (headless `claude` in this setup).
import type { PluginApi } from "stewrd-plugin-api";
import { sessionArgs, sessionFallback, toolRules } from "./model.ts";
import type { Item, SessionMode } from "./model.ts";

const handles = new Set<{ kill(): void }>();

/** Called on dispose so a hot-reload does not leave runs behind. */
export function killAll() {
  handles.forEach((h) => h.kill());
  handles.clear();
}

let tempDir: string | undefined;

/** Default cwd: outside the Stewrd tree so its plugins\CLAUDE.md is not loaded into the session. */
async function defaultCwd(api: PluginApi, itemId: string): Promise<string> {
  tempDir ??= (await api.shell.exec("cmd", ["/c", "echo %TEMP%"])).stdout.trim();
  const dir = `${tempDir}\stewrd-reviews\${itemId}`;
  await api.shell.exec("cmd", ["/c", "mkdir", dir]); // fails harmlessly when it already exists
  return dir;
}

export async function resolveCwd(api: PluginApi, item: Item): Promise<string> {
  return item.workingFolder || defaultCwd(api, item.id);
}

export interface RunOptions {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  extraArgs?: string[];
  onSpawned: () => void; // the session now exists on disk, so later runs must resume it
}

async function attempt(api: PluginApi, item: Item, mode: SessionMode, o: RunOptions): Promise<string> {
  const rules = toolRules(item.role);
  const handle = api.ai.run(o.prompt, {
    cwd: o.cwd,
    allowedTools: rules.allowed,
    disallowedTools: rules.denied,
    extraArgs: [...sessionArgs(item.sessionId, mode), ...(o.extraArgs ?? [])],
  });
  handles.add(handle);
  o.onSpawned();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    handle.kill();
  }, o.timeoutMs);
  try {
    return await handle.done;
  } catch (err) {
    if (timedOut) throw new Error(`Timed out after ${Math.round(o.timeoutMs / 60000)} minutes`);
    throw err;
  } finally {
    clearTimeout(timer);
    handles.delete(handle);
  }
}

/** Runs one prompt in the item's session, falling back between --session-id and --resume when the CLI disagrees. */
export async function runClaude(api: PluginApi, item: Item, o: RunOptions): Promise<string> {
  let mode: SessionMode = item.sessionStarted ? "resume" : "new";
  for (let tries = 0; ; tries++) {
    try {
      return await attempt(api, item, mode, o);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const next = tries === 0 ? sessionFallback(message, mode, item.userSession) : null;
      if (next === "mismatch") throw new Error(`Session ${item.sessionId} was not found. Check that the Working Folder matches the folder it was started in.`);
      if (!next) throw err;
      mode = next;
    }
  }
}
