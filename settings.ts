// Options live in this plugin's own settings.json (Settings > Plugins >
// Configure). `read_plugin_settings_file` is an existing host command.
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_SETTINGS } from "./model.ts";
import type { Settings } from "./model.ts";

const positive = (value: unknown, fallback: number) => (typeof value === "number" && value > 0 ? value : fallback);
const text = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() ? value : fallback);
const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

export async function loadSettings(pluginId: string): Promise<Settings> {
  try {
    const p = JSON.parse(await invoke<string>("read_plugin_settings_file", { dir: pluginId })) as Partial<Record<keyof Settings, unknown>>;
    const d = DEFAULT_SETTINGS;
    return {
      pollMinutes: positive(p.pollMinutes, d.pollMinutes),
      autoMerge: flag(p.autoMerge, d.autoMerge),
      autoApprove: flag(p.autoApprove, d.autoApprove),
      requiredApprovals: positive(p.requiredApprovals, d.requiredApprovals),
      runTimeoutMinutes: positive(p.runTimeoutMinutes, d.runTimeoutMinutes),
      initialReviewPrompt: text(p.initialReviewPrompt, d.initialReviewPrompt),
      authorPrompt: text(p.authorPrompt, d.authorPrompt),
      reviewerPrompt: text(p.reviewerPrompt, d.reviewerPrompt),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}
