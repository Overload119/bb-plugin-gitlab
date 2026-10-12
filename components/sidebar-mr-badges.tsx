// Sidebar row badges: each thread whose branch has a GitLab merge request
// shows "!<iid>" with a state-colored icon beside its title.
//
// bb's built-in row only knows GitHub pull requests (its lookup runs `gh`),
// and it has no slot for row content, so an always-mounted app overlay reads
// the sidebar's live thread list, batches one rpc for every (project, branch)
// it sees, and portals a badge after each row's title anchor
// (`a[data-sidebar-thread-id]`). Works for threads on any machine: the branch
// comes from bb's environment record and glab runs on the bb server.
import { useEffect, useMemo, useRef, useState } from "react";
import type { SyntheticEvent } from "react";
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
  merged: "text-[#a371f7]",
  closed: "text-muted-foreground/70",
  draft: "text-muted-foreground",
  failed: "text-[#ef4444]",
  running: "text-[#eab308]",
  attention: "text-[#f97316]",
  ready: "text-[#22c55e]",
  open: "text-[#3b82f6]",
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

function MrBadge({ mergeRequest }: { mergeRequest: BranchMergeRequest }) {
  const badge = badgeFor(mergeRequest);
  return (
    <a
      href={mergeRequest.url}
      target="_blank"
      rel="noreferrer"
      title={badge.title}
      aria-label={badge.title.replace("\n", ": ")}
      draggable={false}
      onClick={stop}
      onPointerDown={stop}
      onMouseDown={stop}
      onKeyDown={stop}
      className={cn(
        "inline-flex h-5 items-center gap-0.5 rounded px-1 font-mono text-[11px] leading-none",
        "hover:bg-accent",
        TONE_CLASS[badge.tone],
      )}
    >
      <HostIcon name={badge.icon} fallback="GitMerge" className="size-3" aria-hidden />
      <span>{badge.text}</span>
    </a>
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
