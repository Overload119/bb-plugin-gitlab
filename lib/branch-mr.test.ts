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
  hasConflicts: false,
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
  it("marks a mergeable, green MR ready", () => {
    const badge = badgeFor(base);
    expect(badge).toMatchObject({ tone: "ready", text: "!42" });
    expect(badge.title).toContain("ready to merge");
  });

  it("puts a failed pipeline above everything else on an open MR", () => {
    expect(badgeFor({ ...base, draft: true, pipeline: "failed" }).tone).toBe("failed");
  });

  it("flags conflicts", () => {
    expect(badgeFor({ ...base, hasConflicts: true }).tone).toBe("failed");
  });

  it("shows drafts as drafts", () => {
    const badge = badgeFor({ ...base, draft: true, mergeStatus: "draft_status" });
    expect(badge.tone).toBe("draft");
    expect(badge.icon).toBe("GitPullRequestDraft");
  });

  it("shows running pipelines", () => {
    expect(
      badgeFor({ ...base, pipeline: "running", mergeStatus: "ci_still_running" }).tone,
    ).toBe("running");
  });

  it("asks for attention when approval is missing", () => {
    expect(badgeFor({ ...base, mergeStatus: "not_approved" }).tone).toBe("attention");
  });

  it("shows merged and closed MRs", () => {
    expect(badgeFor({ ...base, state: "merged" })).toMatchObject({
      tone: "merged",
      icon: "GitMerge",
    });
    expect(badgeFor({ ...base, state: "closed" }).tone).toBe("closed");
  });
});
