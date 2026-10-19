// One shared store for the poller and the pane, so neither overwrites the
// other's edits. Saves are debounced and flushed on dispose.
import type { PluginApi } from "stewrd-plugin-api";
import { DEFAULT_SETTINGS, itemsStatus } from "./model.ts";
import type { Data, Item, Settings } from "./model.ts";
import { loadSettings } from "./settings.ts";
import { setStatus } from "./status.ts";

export interface State {
  data: Data;
  settings: Settings;
}

const KEY = "data";
const PLUGIN_ID = "reviews";
const SAVE_DEBOUNCE_MS = 500;

let api: PluginApi | undefined;
let signal: AbortSignal | undefined;
let state: State = { data: { items: [], prompts: {} }, settings: DEFAULT_SETTINGS };
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

/** Items with a run in flight. In memory only, so a killed run can never leave an item stuck. */
export const busy = new Set<string>();

export const newId = () => crypto.randomUUID();

export function getState(): State {
  return state;
}

export function getApi(): PluginApi {
  if (!api) throw new Error("Store is not initialised");
  return api;
}

/** False once the plugin is deactivated or hot-reloaded; stop touching the host after that. */
export function alive(): boolean {
  return !!api && !signal?.aborted;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function set(next: State) {
  state = next;
  listeners.forEach((fn) => fn());
}

export async function init(pluginApi: PluginApi, abort: AbortSignal) {
  api = pluginApi;
  signal = abort;
  const settings = await loadSettings(PLUGIN_ID);
  const stored = await api.storage.get<Data>(KEY);
  set({ data: { items: stored?.items ?? [], prompts: stored?.prompts ?? {} }, settings });
  publish();
}

/** Re-reads settings.json so edits apply without a restart. */
export async function reloadSettings(): Promise<Settings> {
  const settings = await loadSettings(PLUGIN_ID);
  set({ ...state, settings });
  return settings;
}

export function publish() {
  if (!alive()) return;
  const { color, tooltip } = itemsStatus(state.data.items);
  setStatus(getApi(), "items", color, tooltip);
}

export function update(fn: (data: Data) => Data) {
  set({ ...state, data: fn(state.data) });
  publish();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
}

export function patchItem(id: string, changes: Partial<Item>) {
  update((d) => ({ ...d, items: d.items.map((i) => (i.id === id ? { ...i, ...changes } : i)) }));
}

export function getItem(id: string): Item | undefined {
  return state.data.items.find((i) => i.id === id);
}

export function flush() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = undefined;
  if (!api) return;
  const pluginApi = api;
  pluginApi.storage.set(KEY, state.data).then(
    () => alive() && setStatus(pluginApi, "save", "idle"),
    (err) => alive() && setStatus(pluginApi, "save", "error", `Save failed: ${err}`),
  );
}
