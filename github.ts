// All GitHub access goes through the `gh` CLI.
import type { PluginApi } from "stewrd-plugin-api";
import { checksState, countApprovals } from "./model.ts";
import type { Entry, Item, Snapshot } from "./model.ts";

const PR_FIELDS = "title,state,updatedAt,headRefOid,reviewDecision,latestReviews,reviews,comments,commits,statusCheckRollup";
const THREADS_QUERY =
  "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){" +
  "reviewThreads(first:100){nodes{path comments(first:50){nodes{author{login} body createdAt}}}}}}}";

async function gh(api: PluginApi, args: string[], cwd?: string): Promise<string> {
  const result = await api.shell.exec("gh", args, cwd ? { cwd } : undefined);
  if (result.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout;
}

let cachedMe: string | undefined;

export async function currentUser(api: PluginApi): Promise<string> {
  cachedMe ??= (await gh(api, ["api", "user", "--jq", ".login"])).trim();
  return cachedMe;
}

interface RawPr {
  title: string;
  state: Snapshot["state"];
  updatedAt: string;
  headRefOid: string;
  reviewDecision: string;
  latestReviews: { state: string }[];
  reviews: { author: { login: string }; state: string; body: string; submittedAt: string }[];
  comments: { author: { login: string }; body: string; createdAt: string }[];
  commits: { committedDate: string; messageHeadline: string; authors: { login: string }[] }[];
  statusCheckRollup: { status?: string; conclusion?: string; state?: string }[] | null;
}

interface RawThreads {
  data: { repository: { pullRequest: { reviewThreads: { nodes: { path: string; comments: { nodes: { author: { login: string } | null; body: string; createdAt: string }[] } }[] } } } };
}

export async function fetchSnapshot(api: PluginApi, item: Item): Promise<Snapshot> {
  const [prText, threadText] = await Promise.all([
    gh(api, ["pr", "view", item.url, "--json", PR_FIELDS]),
    gh(api, ["api", "graphql", "-f", `query=${THREADS_QUERY}`, "-F", `owner=${item.owner}`, "-F", `repo=${item.repo}`, "-F", `number=${item.number}`]),
  ]);
  const pr = JSON.parse(prText) as RawPr;
  const threads = (JSON.parse(threadText) as RawThreads).data.repository.pullRequest.reviewThreads.nodes;

  const entries: Entry[] = [
    ...pr.comments.map((c): Entry => ({ kind: "comment", author: c.author?.login ?? "unknown", at: c.createdAt, body: c.body })),
    ...pr.reviews.map((r): Entry => ({ kind: "review", author: r.author?.login ?? "unknown", at: r.submittedAt, body: r.body || `(${r.state.toLowerCase()})` })),
    ...pr.commits.map((c): Entry => ({ kind: "commit", author: c.authors[0]?.login ?? "unknown", at: c.committedDate, body: c.messageHeadline })),
    ...threads.flatMap((t) =>
      t.comments.nodes.map((c): Entry => ({ kind: "thread", author: c.author?.login ?? "unknown", at: c.createdAt, body: c.body, path: t.path })),
    ),
  ];
  return {
    title: pr.title,
    state: pr.state,
    updatedAt: pr.updatedAt,
    headSha: pr.headRefOid,
    reviewDecision: pr.reviewDecision ?? "",
    approvals: countApprovals(pr.latestReviews),
    checks: checksState(pr.statusCheckRollup ?? []),
    counts: { comments: pr.comments.length, reviews: pr.reviews.length, threadComments: threads.reduce((n, t) => n + t.comments.nodes.length, 0) },
    entries,
  };
}

export async function squashMerge(api: PluginApi, item: Item) {
  await gh(api, ["pr", "merge", item.url, "--squash"]);
}

export async function approve(api: PluginApi, item: Item) {
  await gh(api, ["pr", "review", item.url, "--approve"]);
}

export async function gitHead(api: PluginApi, cwd: string): Promise<string> {
  const r = await api.shell.exec("git", ["rev-parse", "HEAD"], { cwd });
  return r.code === 0 ? r.stdout.trim() : "";
}

export async function gitPush(api: PluginApi, cwd: string) {
  const r = await api.shell.exec("git", ["push"], { cwd });
  if (r.code !== 0) throw new Error(`git push failed: ${r.stderr.trim()}`);
}

export async function openInBrowser(api: PluginApi, url: string) {
  await api.shell.exec("cmd", ["/c", "start", "", url]);
}
