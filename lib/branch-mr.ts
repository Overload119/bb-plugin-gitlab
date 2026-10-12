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
  pipelineUrl: string | null;
  /** GitLab `detailed_merge_status` (mergeable, not_approved, conflict, …). */
  mergeStatus: string;
  hasConflicts: boolean;
  /** Resolvable discussions with an unresolved note; null when unknown. */
  unresolvedThreads: number | null;
  approvalsRequired: number | null;
  approvalsLeft: number | null;
  approvedBy: string[];
  reviewers: string[];
  author: string;
  sourceBranch: string;
  targetBranch: string;
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

/**
 * Open MRs get one of three colors:
 * - red: merge conflict or failed pipeline
 * - yellow: unresolved review threads
 * - green: neither
 * Merged and closed MRs are muted; they no longer need anything.
 */
export type BadgeTone = "red" | "yellow" | "green" | "merged" | "closed";

export interface MrBadge {
  tone: BadgeTone;
  /** Icon name from bb's icon registry. */
  icon: string;
  /** Short text after the icon, e.g. "!1234". */
  text: string;
  /** One-line reason for the color, e.g. "pipeline failed". */
  summary: string;
}

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

export function hasMergeConflict(mr: BranchMergeRequest): boolean {
  return mr.hasConflicts || mr.mergeStatus === "conflict";
}

export function pipelineFailed(mr: BranchMergeRequest): boolean {
  return mr.pipeline === "failed";
}

export function hasUnresolvedThreads(mr: BranchMergeRequest): boolean {
  return mr.unresolvedThreads !== null
    ? mr.unresolvedThreads > 0
    : mr.mergeStatus === "discussions_not_resolved";
}

export function badgeFor(mr: BranchMergeRequest): MrBadge {
  const text = `!${mr.iid}`;
  if (mr.state === "merged") {
    return { tone: "merged", icon: "GitMerge", text, summary: "merged" };
  }
  if (mr.state === "closed" || mr.state === "locked") {
    return { tone: "closed", icon: "GitPullRequestClosed", text, summary: mr.state };
  }
  const icon = mr.draft ? "GitPullRequestDraft" : "GitPullRequestArrow";
  const red: string[] = [];
  if (hasMergeConflict(mr)) red.push("merge conflict");
  if (pipelineFailed(mr)) red.push("pipeline failed");
  if (red.length > 0) return { tone: "red", icon, text, summary: red.join(" · ") };
  if (hasUnresolvedThreads(mr)) {
    const count = mr.unresolvedThreads;
    const summary =
      count === null
        ? "unresolved threads"
        : `${count} unresolved thread${count === 1 ? "" : "s"}`;
    return { tone: "yellow", icon, text, summary };
  }
  return { tone: "green", icon, text, summary: "no conflicts, failures, or open threads" };
}

/** Cache key for a (BB project, branch) pair; NUL never appears in either. */
export function branchKey(projectId: string, branch: string): string {
  return `${projectId}\u0000${branch}`;
}
