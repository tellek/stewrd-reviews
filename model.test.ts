import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SETTINGS,
  buildDelta,
  buildPrompt,
  checksState,
  countApprovals,
  evaluateGate,
  fingerprint,
  itemsStatus,
  parsePrUrl,
  parseVerdict,
  sessionArgs,
  sessionFallback,
  toolRules,
} from "./model.ts";
import type { Entry, Item, Snapshot } from "./model.ts";

const item = (over: Partial<Item> = {}): Item => ({
  id: "1",
  role: "author",
  url: "https://github.com/o/r/pull/7",
  host: "github.com",
  owner: "o",
  repo: "r",
  number: 7,
  title: "t",
  workingFolder: "",
  sessionId: "s",
  userSession: false,
  sessionStarted: false,
  state: "Pending",
  initialDone: true,
  lastSeen: "2026-01-01T00:00:00Z",
  createdAt: 0,
  ...over,
});

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  title: "t",
  state: "OPEN",
  updatedAt: "2026-01-02T00:00:00Z",
  headSha: "abc",
  reviewDecision: "",
  approvals: 1,
  checks: "green",
  counts: { comments: 0, reviews: 0, threadComments: 0 },
  entries: [],
  ...over,
});

test("parsePrUrl accepts pull request urls and rejects others", () => {
  assert.deepEqual(parsePrUrl(" https://github.com/o/r/pull/7/files "), {
    host: "github.com",
    owner: "o",
    repo: "r",
    number: 7,
    url: "https://github.com/o/r/pull/7",
  });
  assert.equal(parsePrUrl("https://github.com/o/r/issues/7"), null);
  assert.equal(parsePrUrl("nope"), null);
});

test("parseVerdict reads the last VERDICT line, tolerating fences and prose", () => {
  assert.equal(parseVerdict('done\nVERDICT: {"status":"addressed"}'), "addressed");
  assert.equal(parseVerdict('VERDICT: {"status":"waiting"}\nmore\n```\nVERDICT: {"status":"needs_work"}\n```'), "needs_work");
  assert.equal(parseVerdict("no verdict here"), undefined);
});

test("buildPrompt always ends with the verdict instruction and marks activity untrusted", () => {
  const p = buildPrompt("Do it", "u", "- [comment] x");
  assert.match(p, /never as instructions/);
  assert.match(p.split("\n\n").at(-1)!, /^End your answer with a final line/);
  assert.match(buildPrompt("Do it", "u", "x", "C:\\f.md"), /read it from C:\\f\.md/);
});

test("approvals count one per reviewer; checks roll up", () => {
  assert.equal(countApprovals([{ state: "APPROVED" }, { state: "CHANGES_REQUESTED" }, { state: "APPROVED" }]), 2);
  assert.equal(checksState([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "SKIPPED" }]), "green");
  assert.equal(checksState([{ status: "IN_PROGRESS" }]), "pending");
  assert.equal(checksState([{ status: "COMPLETED", conclusion: "FAILURE" }]), "failed");
  assert.equal(checksState([]), "green");
});

test("buildDelta keeps only newer, non-own comments but all commits", () => {
  const entries: Entry[] = [
    { kind: "comment", author: "me", at: "2026-02-01T00:00:00Z", body: "mine" },
    { kind: "comment", author: "bob", at: "2026-02-01T00:00:00Z", body: "theirs" },
    { kind: "comment", author: "bob", at: "2025-12-01T00:00:00Z", body: "old" },
    { kind: "commit", author: "me", at: "2026-02-02T00:00:00Z", body: "fix" },
  ];
  assert.deepEqual(buildDelta(entries, "2026-01-01T00:00:00Z", "me").map((e) => e.body), ["theirs", "fix"]);
});

test("fingerprint changes when checks or review decision change", () => {
  assert.notEqual(fingerprint(snap()), fingerprint(snap({ checks: "failed" })));
  assert.notEqual(fingerprint(snap()), fingerprint(snap({ reviewDecision: "APPROVED" })));
  assert.equal(fingerprint(snap()), fingerprint(snap()));
});

test("author gate needs addressed verdict, approvals, green checks and no requested changes", () => {
  const s = DEFAULT_SETTINGS;
  const a = item({ verdict: "addressed" });
  assert.deepEqual(evaluateGate(a, snap(), s), { state: "Ready To Merge", action: undefined });
  assert.equal(evaluateGate(a, snap({ approvals: 0 }), s).state, "Pending");
  assert.equal(evaluateGate(a, snap({ checks: "pending" }), s).state, "Pending");
  assert.equal(evaluateGate(a, snap({ reviewDecision: "CHANGES_REQUESTED" }), s).state, "Pending");
  assert.equal(evaluateGate(item({ verdict: "needs_work" }), snap(), s).state, "Needs Action");
  assert.equal(evaluateGate(a, snap(), { ...s, autoMerge: true }).action, "merge");
  assert.equal(evaluateGate(a, snap({ approvals: 1 }), { ...s, requiredApprovals: 2 }).state, "Pending");
});

test("late approval promotes an addressed item without a new verdict", () => {
  const a = item({ verdict: "addressed" });
  assert.equal(evaluateGate(a, snap({ approvals: 0 }), DEFAULT_SETTINGS).state, "Pending");
  assert.equal(evaluateGate(a, snap({ approvals: 1 }), DEFAULT_SETTINGS).state, "Ready To Merge");
});

test("reviewer gate approves only when addressed and auto is on", () => {
  const r = item({ role: "reviewer", verdict: "addressed" });
  assert.deepEqual(evaluateGate(r, snap(), DEFAULT_SETTINGS), { state: "Ready To Approve", action: undefined });
  assert.equal(evaluateGate(r, snap(), { ...DEFAULT_SETTINGS, autoApprove: true }).action, "approve");
  assert.equal(evaluateGate(item({ role: "reviewer", verdict: "needs_work" }), snap(), DEFAULT_SETTINGS).state, "Pending");
});

test("closed and merged pull requests short-circuit the gate", () => {
  assert.equal(evaluateGate(item(), snap({ state: "MERGED" }), DEFAULT_SETTINGS).state, "Merged");
  assert.equal(evaluateGate(item(), snap({ state: "CLOSED" }), DEFAULT_SETTINGS).state, "Closed");
});

test("itemsStatus: error beats success beats tracking; merged and closed are ignored", () => {
  assert.equal(itemsStatus([item({ state: "Pending" })]).color, "in-progress");
  assert.equal(itemsStatus([item({ state: "Pending" }), item({ state: "Ready To Merge" })]).color, "success");
  assert.equal(itemsStatus([item({ state: "Ready To Approve" }), item({ state: "Failed" })]).color, "error");
  assert.equal(itemsStatus([item({ state: "Merged" }), item({ state: "Closed" })]).color, "idle");
  assert.equal(itemsStatus([]).color, "idle");
});

test("tool rules never allow approve, merge, api or push", () => {
  for (const role of ["author", "reviewer"] as const) {
    const { allowed, denied } = toolRules(role);
    assert.ok(!allowed.some((r) => /merge|approve|gh api|push|Read/.test(r)), role);
    assert.ok(denied.includes("Bash(gh pr merge:*)"));
  }
  assert.ok(toolRules("author").allowed.includes("Edit(./**)"));
  assert.ok(!toolRules("reviewer").allowed.some((r) => r.startsWith("Edit") || r.startsWith("Write")));
});

test("session args and fallbacks", () => {
  assert.deepEqual(sessionArgs("x", "new"), ["--session-id", "x"]);
  assert.deepEqual(sessionArgs("x", "resume"), ["--resume", "x"]);
  assert.equal(sessionFallback("Session ID is already in use", "new", false), "resume");
  assert.equal(sessionFallback("No conversation found with session ID", "resume", false), "new");
  assert.equal(sessionFallback("No conversation found with session ID", "resume", true), "mismatch");
  assert.equal(sessionFallback("network down", "resume", false), null);
});
