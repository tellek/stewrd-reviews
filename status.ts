// Central status for the sidebar icon. Each activity reports its own color and
// the sidebar icon shows the highest-priority one (see CLAUDE.md "Status Color
// Rules"). Deviation: success outranks in-progress here, per the plugin spec
// (ready items must stay visible while other items are still tracked).
import type { PluginApi, StatusColor } from "stewrd-plugin-api";

// "items" is derived from item state and never fades; "event" and "save" are one-shots.
export type StatusSource = "items" | "event" | "save";

const PRIORITY: StatusColor[] = ["idle", "in-progress", "success", "warning", "error"];
const FADING: StatusSource[] = ["event", "save"];
const SUCCESS_RESET_MS = 3000;

const colors: Record<StatusSource, StatusColor> = { items: "idle", event: "idle", save: "idle" };
let tooltips: Partial<Record<StatusSource, string | undefined>> = {};
let lastApi: PluginApi | undefined;
let viewing = false;
let resetTimer: ReturnType<typeof setTimeout> | undefined;

export function setStatus(api: PluginApi, source: StatusSource, color: StatusColor, tooltip?: string) {
  lastApi = api;
  colors[source] = color;
  tooltips[source] = tooltip;
  publish();
  scheduleReset();
}

/** Called by the pane on mount/unmount: success only fades while it is showing. */
export function setViewing(value: boolean) {
  viewing = value;
  scheduleReset();
}

function publish() {
  let worst: StatusSource = "items";
  for (const source of Object.keys(colors) as StatusSource[]) {
    if (PRIORITY.indexOf(colors[source]) > PRIORITY.indexOf(colors[worst])) worst = source;
  }
  try {
    lastApi?.statusIcon.set(colors[worst], tooltips[worst]); // throws after deactivation/hot-reload
  } catch {
    // plugin deactivated
  }
}

// Success fades to idle 3s after the pane is on screen AND the app has focus.
// Leaving the pane or the app cancels the countdown; returning restarts it.
function scheduleReset() {
  if (resetTimer) clearTimeout(resetTimer);
  resetTimer = undefined;
  const pending = FADING.some((s) => colors[s] === "success");
  if (!pending || !viewing || !document.hasFocus()) return;
  resetTimer = setTimeout(() => {
    resetTimer = undefined;
    for (const source of FADING) {
      if (colors[source] === "success") {
        colors[source] = "idle";
        tooltips[source] = undefined;
      }
    }
    publish();
  }, SUCCESS_RESET_MS);
}

window.addEventListener("focus", scheduleReset);
window.addEventListener("blur", scheduleReset);
