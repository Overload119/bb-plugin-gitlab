// Branch → merge request summaries for the sidebar row badges.
//
// bb's own pull-request lookup only speaks GitHub (`gh pr view`), so a thread
// on a GitLab project never shows review state in the sidebar. The server
// resolves each thread's (BB project, branch) to the most relevant merge
// request on that branch, and the app draws a compact badge on the row. This
// module holds the pure parts both sides share: the wire shape, choosing the
// merge request a branch "means", and turning one into a badge.

export type BranchMrState = "opened" | "merged" | "closed" | "locked";

/** What the sidebar needs to know about a branch's merge request. */
export interface BranchMergeRequest {
  project: string;
  iid: number;
  title: string;
  url: string;
  state: BranchMrState;
  draft: boolean;
  /** GitLab head-pipeline status (success, failed, running, …) or null. */
  pipeline: string | null;
  /** GitLab `detailed_merge_status` (mergeable, not_approved, conflict, …). */
  mergeStatus: string;
  hasConflicts: boolean;
  updatedAt: string;
}

export interface BranchMrCandidate {
  iid: number;
  state: string;
  updated_at: string;
}

/**
 * The merge request a branch stands for: an open one wins over anything
 * already merged or closed (a branch reused after a merge is being worked on
 * again), then the most recently updated.
 */
export function pickBranchMergeRequest<T extends BranchMrCandidate>(
  rows: readonly T[],
): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (best === null) {
      best = row;
      continue;
    }
    const rowOpen = row.state === "opened";
    const bestOpen = best.state === "opened";
    if (rowOpen !== bestOpen) {
      if (rowOpen) best = row;
      continue;
    }
    if (row.updated_at > best.updated_at) best = row;
  }
  return best;
}

export function normalizeMrState(state: string): BranchMrState {
  return state === "merged" || state === "closed" || state === "locked"
    ? state
    : "opened";
}

export type BadgeTone =
  | "merged"
  | "closed"
  | "draft"
  | "failed"
  | "running"
  | "attention"
  | "ready"
  | "open";

export interface MrBadge {
  tone: BadgeTone;
  /** Icon name from bb's icon registry. */
  icon: string;
  /** Short text after the icon, e.g. "!1234". */
  text: string;
  /** Hover text: one line per fact. */
  title: string;
}

const PIPELINE_FAILED = new Set(["failed", "canceled"]);
const PIPELINE_RUNNING = new Set([
  "running",
  "pending",
  "created",
  "preparing",
  "waiting_for_resource",
  "scheduled",
]);

const MERGE_STATUS_LABELS: Record<string, string> = {
  mergeable: "ready to merge",
  not_approved: "needs approval",
  approvals_syncing: "approvals syncing",
  discussions_not_resolved: "unresolved threads",
  ci_must_pass: "pipeline must pass",
  ci_still_running: "pipeline running",
  conflict: "has conflicts",
  need_rebase: "needs rebase",
  draft_status: "draft",
  blocked_status: "blocked by another MR",
  not_open: "not open",
  requested_changes: "changes requested",
  jira_association_missing: "Jira issue missing",
  checking: "checking mergeability",
  unchecked: "mergeability unchecked",
};

export function describeMergeStatus(status: string): string {
  return MERGE_STATUS_LABELS[status] ?? status.replaceAll("_", " ");
}

/** One badge per merge request, most urgent fact first. */
export function badgeFor(mr: BranchMergeRequest): MrBadge {
  const text = `!${mr.iid}`;
  const lines = [`!${mr.iid} ${mr.title}`];
  const facts: string[] = [];
  let tone: BadgeTone;
  let icon: string;

  if (mr.state === "merged") {
    tone = "merged";
    icon = "GitMerge";
    facts.push("merged");
  } else if (mr.state === "closed" || mr.state === "locked") {
    tone = "closed";
    icon = "GitPullRequestClosed";
    facts.push(mr.state);
  } else {
    facts.push(mr.draft ? "draft" : "open");
    if (mr.pipeline !== null) facts.push(`pipeline ${mr.pipeline}`);
    const status = mr.hasConflicts ? "conflict" : mr.mergeStatus;
    if (status.length > 0 && status !== "draft_status") {
      facts.push(describeMergeStatus(status));
    }
    if (mr.pipeline !== null && PIPELINE_FAILED.has(mr.pipeline)) {
      tone = "failed";
      icon = "GitPullRequestArrow";
    } else if (mr.hasConflicts || status === "conflict" || status === "need_rebase") {
      tone = "failed";
      icon = "GitPullRequestArrow";
    } else if (mr.draft) {
      tone = "draft";
      icon = "GitPullRequestDraft";
    } else if (mr.pipeline !== null && PIPELINE_RUNNING.has(mr.pipeline)) {
      tone = "running";
      icon = "GitPullRequestArrow";
    } else if (status === "mergeable") {
      tone = "ready";
      icon = "GitPullRequestArrow";
    } else if (
      status === "not_approved" ||
      status === "discussions_not_resolved" ||
      status === "requested_changes"
    ) {
      tone = "attention";
      icon = "GitPullRequestArrow";
    } else {
      tone = "open";
      icon = "GitPullRequestArrow";
    }
  }
  lines.push(facts.join(" · "));
  return { tone, icon, text, title: lines.join("\n") };
}

/** Cache key for a (BB project, branch) pair; NUL never appears in either. */
export function branchKey(projectId: string, branch: string): string {
  return `${projectId}\u0000${branch}`;
}
