import { describe, expect, it } from "vitest";
import {
  badgeFor,
  pickBranchMergeRequest,
  type BranchMergeRequest,
} from "./branch-mr";

const base: BranchMergeRequest = {
  project: "gitlab.com/acme/web",
  iid: 42,
  title: "Fix login",
  url: "https://gitlab.com/acme/web/-/merge_requests/42",
  state: "opened",
  draft: false,
  pipeline: "success",
  mergeStatus: "mergeable",
  pipelineUrl: null,
  hasConflicts: false,
  unresolvedThreads: 0,
  approvalsRequired: 1,
  approvalsLeft: 0,
  approvedBy: ["rio"],
  reviewers: [],
  author: "dana",
  sourceBranch: "dana/login",
  targetBranch: "master",
  updatedAt: "2026-10-01T00:00:00Z",
};

describe("pickBranchMergeRequest", () => {
  it("prefers an open MR over a newer merged one", () => {
    const picked = pickBranchMergeRequest([
      { iid: 2, state: "merged", updated_at: "2026-10-05" },
      { iid: 1, state: "opened", updated_at: "2026-10-01" },
    ]);
    expect(picked?.iid).toBe(1);
  });

  it("falls back to the most recently updated", () => {
    const picked = pickBranchMergeRequest([
      { iid: 1, state: "closed", updated_at: "2026-10-01" },
      { iid: 3, state: "merged", updated_at: "2026-10-03" },
    ]);
    expect(picked?.iid).toBe(3);
  });

  it("returns null for no MRs", () => {
    expect(pickBranchMergeRequest([])).toBeNull();
  });
});

describe("badgeFor", () => {
  it("is green with no conflicts, failures, or open threads", () => {
    expect(badgeFor(base)).toMatchObject({ tone: "green", text: "!42" });
  });

  it("stays green when only approval is missing", () => {
    expect(badgeFor({ ...base, mergeStatus: "not_approved", approvalsLeft: 1 }).tone).toBe(
      "green",
    );
  });

  it("is red on a failed pipeline, even with unresolved threads", () => {
    const badge = badgeFor({ ...base, pipeline: "failed", unresolvedThreads: 2 });
    expect(badge).toMatchObject({ tone: "red", summary: "pipeline failed" });
  });

  it("is red on a merge conflict", () => {
    expect(badgeFor({ ...base, hasConflicts: true }).summary).toBe("merge conflict");
    expect(badgeFor({ ...base, mergeStatus: "conflict" }).tone).toBe("red");
  });

  it("names both red reasons", () => {
    expect(badgeFor({ ...base, hasConflicts: true, pipeline: "failed" }).summary).toBe(
      "merge conflict · pipeline failed",
    );
  });

  it("is yellow with unresolved threads", () => {
    expect(badgeFor({ ...base, unresolvedThreads: 1 })).toMatchObject({
      tone: "yellow",
      summary: "1 unresolved thread",
    });
    expect(badgeFor({ ...base, unresolvedThreads: 3 }).summary).toBe("3 unresolved threads");
  });

  it("falls back to GitLab's merge status when the thread count is unknown", () => {
    expect(
      badgeFor({ ...base, unresolvedThreads: null, mergeStatus: "discussions_not_resolved" })
        .tone,
    ).toBe("yellow");
    expect(badgeFor({ ...base, unresolvedThreads: null }).tone).toBe("green");
  });

  it("uses the draft icon for drafts", () => {
    expect(badgeFor({ ...base, draft: true }).icon).toBe("GitPullRequestDraft");
  });

  it("mutes merged and closed MRs", () => {
    expect(badgeFor({ ...base, state: "merged", pipeline: "failed" })).toMatchObject({
      tone: "merged",
      icon: "GitMerge",
    });
    expect(badgeFor({ ...base, state: "closed" }).tone).toBe("closed");
  });
});
