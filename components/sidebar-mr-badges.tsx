// Sidebar row badges: each thread whose branch has a GitLab merge request
// shows "!<iid>" with a state-colored icon beside its title.
//
// bb's built-in row only knows GitHub pull requests (its lookup runs `gh`),
// and it has no slot for row content, so an always-mounted app overlay reads
// the sidebar's live thread list, batches one rpc for every (project, branch)
// it sees, and portals a badge after each row's title anchor
// (`a[data-sidebar-thread-id]`). Works for threads on any machine: the branch
// comes from bb's environment record and glab runs on the bb server.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import {
  experimental_Icon as HostIcon,
  experimental_usePluginId,
  experimental_useSidebarThreads,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { gitlabRpcContract } from "../server";
import {
  badgeFor,
  branchKey,
  describeMergeStatus,
  hasMergeConflict,
  hasUnresolvedThreads,
  pipelineFailed,
  type BadgeTone,
  type BranchMergeRequest,
} from "../lib/branch-mr";
import { cn } from "../lib/utils";

const ROW_ANCHOR = "a[data-sidebar-thread-id]";
const SLOT_ATTR = "data-gitlab-mr-slot";
const REFRESH_MS = 60_000;
/** Branches that are never a merge request's source in practice. */
const SKIPPED_BRANCHES = new Set(["main", "master", "develop", "HEAD"]);

// The host theme has no semantic palette for review states, so set our own.
const TONE_CLASS: Record<BadgeTone, string> = {
  red: "text-[#ef4444]",
  yellow: "text-[#eab308]",
  green: "text-[#22c55e]",
  merged: "text-[#a371f7]",
  closed: "text-muted-foreground/70",
};

type ThreadBranch = { threadId: string; projectId: string; branch: string };

function useThreadBranches(): ThreadBranch[] {
  const { threads } = experimental_useSidebarThreads();
  return useMemo(() => {
    const out: ThreadBranch[] = [];
    for (const thread of threads) {
      const branch = thread.environment?.branchName ?? null;
      if (branch === null || branch.length === 0) continue;
      if (SKIPPED_BRANCHES.has(branch)) continue;
      out.push({ threadId: thread.id, projectId: thread.projectId, branch });
    }
    return out;
  }, [threads]);
}

function useBranchMergeRequests(
  items: readonly ThreadBranch[],
): Map<string, BranchMergeRequest> {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const [byKey, setByKey] = useState<Map<string, BranchMergeRequest>>(
    () => new Map(),
  );
  // Re-query only when the set of (project, branch) pairs changes, not on
  // every sidebar update (status flips, titles, unread state).
  const pairsKey = useMemo(
    () =>
      [...new Set(items.map((item) => branchKey(item.projectId, item.branch)))]
        .sort()
        .join("\u0001"),
    [items],
  );
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    if (pairsKey.length === 0) {
      setByKey(new Map());
      return;
    }
    let cancelled = false;
    const load = () => {
      const unique = new Map<string, { projectId: string; branch: string }>();
      for (const item of itemsRef.current) {
        unique.set(branchKey(item.projectId, item.branch), {
          projectId: item.projectId,
          branch: item.branch,
        });
      }
      rpc
        .call("branchMergeRequests", { items: [...unique.values()].slice(0, 500) })
        .then(
          ({ results }) => {
            if (cancelled) return;
            const next = new Map<string, BranchMergeRequest>();
            for (const result of results) {
              if (result.mergeRequest !== null) {
                next.set(branchKey(result.projectId, result.branch), result.mergeRequest);
              }
            }
            setByKey(next);
          },
          () => {
            // glab missing / unauthenticated: show nothing, keep last state.
          },
        );
    };
    load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [rpc, pairsKey]);

  return byKey;
}

type RowSlot = { threadId: string; node: HTMLElement; key: string };
let slotSequence = 0;

/** One portal target after each visible row anchor whose thread has an MR. */
function useRowSlots(threadIds: ReadonlySet<string>): RowSlot[] {
  const pluginId = experimental_usePluginId();
  const [slots, setSlots] = useState<RowSlot[]>([]);
  useEffect(() => {
    const nodes = new Map<HTMLElement, RowSlot>();
    let frame = 0;
    const sync = () => {
      frame = 0;
      const seen = new Set<HTMLElement>();
      for (const anchor of Array.from(document.querySelectorAll<HTMLElement>(ROW_ANCHOR))) {
        const threadId = anchor.getAttribute("data-sidebar-thread-id");
        if (threadId === null || !threadIds.has(threadId)) continue;
        seen.add(anchor);
        // The anchor is an absolute click overlay over the row's content; the
        // badge goes last in the same flex line, right after the title, and
        // sits above the overlay so it takes its own clicks.
        const line = anchor.parentElement;
        if (line === null) continue;
        const existing = nodes.get(anchor);
        if (
          existing !== undefined &&
          existing.threadId === threadId &&
          existing.node.parentElement === line &&
          line.lastElementChild === existing.node
        ) {
          continue;
        }
        existing?.node.remove();
        const node = document.createElement("span");
        node.setAttribute(SLOT_ATTR, threadId);
        // Plugin CSS is scoped to plugin roots.
        node.setAttribute("data-bb-plugin-root", "");
        node.setAttribute("data-bb-plugin", pluginId);
        node.className = "relative z-[31] flex shrink-0 items-center";
        line.append(node);
        nodes.set(anchor, { threadId, node, key: `mr-slot-${++slotSequence}` });
      }
      for (const [anchor, entry] of nodes) {
        if (!seen.has(anchor) || !anchor.isConnected) {
          entry.node.remove();
          nodes.delete(anchor);
        }
      }
      setSlots((prev) => {
        const next = [...nodes.values()];
        const same =
          prev.length === next.length &&
          prev.every(
            (slot, i) =>
              slot.node === next[i]!.node && slot.threadId === next[i]!.threadId,
          );
        return same ? prev : next;
      });
    };
    sync();
    // Rows are windowed and re-render constantly; batch to one pass a frame.
    const observer = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(sync);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      for (const entry of nodes.values()) entry.node.remove();
      setSlots([]);
    };
  }, [pluginId, threadIds]);
  return slots;
}

// The row is a link and a drag source; keep our clicks to ourselves.
const stop = (event: SyntheticEvent) => event.stopPropagation();

const DOT_CLASS: Record<BadgeTone, string> = {
  red: "bg-[#ef4444]",
  yellow: "bg-[#eab308]",
  green: "bg-[#22c55e]",
  merged: "bg-[#a371f7]",
  closed: "bg-muted-foreground",
};

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** One check in the hover card: a colored dot, a label, and a value. */
function Check({
  tone,
  label,
  children,
}: {
  tone: "bad" | "warn" | "ok" | "neutral";
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span
        className={cn(
          "mt-1 size-1.5 shrink-0 self-start rounded-full",
          tone === "bad" && "bg-[#ef4444]",
          tone === "warn" && "bg-[#eab308]",
          tone === "ok" && "bg-[#22c55e]",
          tone === "neutral" && "bg-muted-foreground/50",
        )}
      />
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}

function MrHoverCard({ mergeRequest: mr }: { mergeRequest: BranchMergeRequest }) {
  const badge = badgeFor(mr);
  const open = mr.state === "opened";
  const conflict = hasMergeConflict(mr);
  const failed = pipelineFailed(mr);
  const unresolved = hasUnresolvedThreads(mr);
  const approvals =
    mr.approvalsRequired === null
      ? null
      : mr.approvalsLeft === 0
        ? mr.approvedBy.length > 0
          ? `approved by ${mr.approvedBy.join(", ")}`
          : "no approvals required"
        : `${mr.approvalsLeft} of ${mr.approvalsRequired} left` +
          (mr.approvedBy.length > 0 ? ` (approved by ${mr.approvedBy.join(", ")})` : "");
  return (
    <div className="flex w-80 flex-col gap-2 text-xs">
      <div className="flex items-start gap-2">
        <span className={cn("mt-1 size-2 shrink-0 rounded-full", DOT_CLASS[badge.tone])} />
        <div className="min-w-0">
          <div className="font-medium leading-snug text-foreground">
            <span className="font-mono text-muted-foreground">!{mr.iid}</span> {mr.title}
          </div>
          <div className="mt-0.5 text-muted-foreground">
            {open
              ? `${mr.draft ? "Draft" : "Open"} · ${badge.tone === "green" ? "ready to merge" : badge.summary}`
              : badge.summary}
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-1 border-t border-border pt-2">
        <Check tone="neutral" label="Branch">
          <span className="font-mono">
            {mr.sourceBranch} → {mr.targetBranch}
          </span>
        </Check>
        {open ? (
          <>
            <Check tone={conflict ? "bad" : "ok"} label="Conflicts">
              {conflict ? "merge conflict" : "none"}
            </Check>
            <Check
              tone={
                failed
                  ? "bad"
                  : mr.pipeline === "success"
                    ? "ok"
                    : mr.pipeline === null
                      ? "neutral"
                      : "warn"
              }
              label="Pipeline"
            >
              {mr.pipeline === null ? (
                "none"
              ) : mr.pipelineUrl !== null ? (
                <a
                  href={mr.pipelineUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                >
                  {mr.pipeline}
                </a>
              ) : (
                mr.pipeline
              )}
            </Check>
            <Check tone={unresolved ? "warn" : "ok"} label="Threads">
              {mr.unresolvedThreads === null
                ? unresolved
                  ? "unresolved"
                  : "unknown"
                : mr.unresolvedThreads === 0
                  ? "all resolved"
                  : `${mr.unresolvedThreads} unresolved`}
            </Check>
            {approvals !== null ? (
              <Check tone={mr.approvalsLeft === 0 ? "ok" : "neutral"} label="Approvals">
                {approvals}
              </Check>
            ) : null}
            <Check
              tone={mr.mergeStatus === "mergeable" ? "ok" : "neutral"}
              label="GitLab says"
            >
              {describeMergeStatus(mr.mergeStatus)}
            </Check>
          </>
        ) : null}
        {mr.reviewers.length > 0 ? (
          <Check tone="neutral" label="Reviewers">
            {mr.reviewers.join(", ")}
          </Check>
        ) : null}
        <Check tone="neutral" label="Author">
          {mr.author}
          {mr.updatedAt ? (
            <span className="text-muted-foreground"> · updated {relativeTime(mr.updatedAt)}</span>
          ) : null}
        </Check>
      </div>
      <div className="border-t border-border pt-2 text-muted-foreground">
        Click the badge to open in GitLab
      </div>
    </div>
  );
}

/**
 * A fixed-position card beside the badge, portalled to <body> so the
 * sidebar's overflow clipping cannot cut it off. Opens after a short hover,
 * stays open while the pointer moves into it, and closes on leave.
 */
function useHoverCard() {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const openTimer = useRef(0);
  const closeTimer = useRef(0);
  const clear = () => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
  };
  useEffect(() => clear, []);
  const onEnter = useCallback((target: HTMLElement) => {
    clear();
    openTimer.current = window.setTimeout(
      () => setAnchor(target.getBoundingClientRect()),
      250,
    );
  }, []);
  const onLeave = useCallback(() => {
    clear();
    closeTimer.current = window.setTimeout(() => setAnchor(null), 150);
  }, []);
  const keepOpen = useCallback(() => clear(), []);
  return { anchor, onEnter, onLeave, keepOpen };
}

function HoverCardPortal({
  anchor,
  onEnter,
  onLeave,
  children,
}: {
  anchor: DOMRect;
  onEnter: () => void;
  onLeave: () => void;
  children: ReactNode;
}) {
  const pluginId = experimental_usePluginId();
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(anchor.top - 8);
  useEffect(() => {
    // Keep the card on screen vertically once its height is known.
    const height = ref.current?.offsetHeight ?? 0;
    setTop(Math.max(8, Math.min(anchor.top - 8, window.innerHeight - height - 8)));
  }, [anchor]);
  const left = Math.min(anchor.right + 8, window.innerWidth - 336);
  return createPortal(
    <div
      data-bb-plugin-root=""
      data-bb-plugin={pluginId}
      ref={ref}
      role="tooltip"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{ position: "fixed", top, left, zIndex: 1000 }}
      className="rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg"
    >
      {children}
    </div>,
    document.body,
  );
}

function MrBadge({ mergeRequest }: { mergeRequest: BranchMergeRequest }) {
  const badge = badgeFor(mergeRequest);
  const card = useHoverCard();
  return (
    <>
      <a
        href={mergeRequest.url}
        target="_blank"
        rel="noreferrer"
        aria-label={`!${mergeRequest.iid} ${mergeRequest.title}: ${badge.summary}`}
        draggable={false}
        onClick={stop}
        onPointerDown={stop}
        onMouseDown={stop}
        onKeyDown={stop}
        onMouseEnter={(event) => card.onEnter(event.currentTarget)}
        onMouseLeave={card.onLeave}
        onFocus={(event) => card.onEnter(event.currentTarget)}
        onBlur={card.onLeave}
        className={cn(
          "inline-flex h-5 items-center gap-0.5 rounded px-1 font-mono text-[11px] leading-none",
          "hover:bg-accent",
          TONE_CLASS[badge.tone],
        )}
      >
        <HostIcon name={badge.icon} fallback="GitMerge" className="size-3" aria-hidden />
        <span>{badge.text}</span>
      </a>
      {card.anchor !== null ? (
        <HoverCardPortal
          anchor={card.anchor}
          onEnter={card.keepOpen}
          onLeave={card.onLeave}
        >
          <MrHoverCard mergeRequest={mergeRequest} />
        </HoverCardPortal>
      ) : null}
    </>
  );
}

export function SidebarMergeRequestBadges() {
  const branches = useThreadBranches();
  const byKey = useBranchMergeRequests(branches);
  const mrByThread = useMemo(() => {
    const out = new Map<string, BranchMergeRequest>();
    for (const item of branches) {
      const mr = byKey.get(branchKey(item.projectId, item.branch));
      if (mr !== undefined) out.set(item.threadId, mr);
    }
    return out;
  }, [branches, byKey]);
  // Stable identity unless the set of badged threads changes, so the
  // observer is not torn down on every sidebar update.
  const idsKey = [...mrByThread.keys()].sort().join(",");
  const threadIds = useMemo(
    () => new Set(idsKey.length === 0 ? [] : idsKey.split(",")),
    [idsKey],
  );
  const slots = useRowSlots(threadIds);
  return (
    <>
      {slots.map((slot) => {
        const mr = mrByThread.get(slot.threadId);
        return mr === undefined
          ? null
          : createPortal(<MrBadge mergeRequest={mr} />, slot.node, slot.key);
      })}
    </>
  );
}
