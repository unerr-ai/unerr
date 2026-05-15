/**
 * Sprint 8: Codebase Health Map — treemap visualization of per-file/per-directory health.
 *
 * Color-coded: green (healthy) → yellow (warning) → red (critical).
 * Click-to-drill: click a directory to zoom in, click a file to see detailed metrics.
 */

import { fetchJson } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

interface HealthMetrics {
  fan_in: number;
  fan_out: number;
  durability: number;
  convention_adherence: number;
  change_frequency: number;
  coupling_count: number;
}

interface HealthMapNode {
  path: string;
  name: string;
  health_score: number;
  risk_level: "low" | "medium" | "high" | "critical";
  metrics: HealthMetrics;
  entity_count: number;
  children?: HealthMapNode[];
}

function riskColor(risk: string): string {
  switch (risk) {
    case "low":
      return "bg-emerald-500/20 border-emerald-500/40 text-emerald-300";
    case "medium":
      return "bg-amber-500/20 border-amber-500/40 text-amber-300";
    case "high":
      return "bg-orange-500/20 border-orange-500/40 text-orange-300";
    case "critical":
      return "bg-red-500/20 border-red-500/40 text-red-300";
    default:
      return "bg-zinc-700/30 border-zinc-600 text-zinc-400";
  }
}

function riskBadge(risk: string): string {
  switch (risk) {
    case "low":
      return "bg-emerald-500/30 text-emerald-300";
    case "medium":
      return "bg-amber-500/30 text-amber-300";
    case "high":
      return "bg-orange-500/30 text-orange-300";
    case "critical":
      return "bg-red-500/30 text-red-300";
    default:
      return "bg-zinc-600/30 text-zinc-400";
  }
}

function MetricRow({
  label,
  value,
  max,
  unit,
  hint,
}: {
  label: string;
  value: number;
  max: number;
  unit?: string;
  hint?: string;
}) {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div>
      <div className="flex items-center gap-2 text-xs">
        <span className="w-28 text-zinc-300 shrink-0 font-medium">{label}</span>
        <div className="flex-1 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-violet-500 rounded-full transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="w-12 text-right text-zinc-400 tabular-nums">
          {typeof value === "number" && value % 1 !== 0
            ? value.toFixed(2)
            : value}
          {unit ?? ""}
        </span>
      </div>
      {hint && (
        <div className="mt-0.5 ml-[7.5rem] text-[10px] text-zinc-500 leading-snug">
          {hint}
        </div>
      )}
    </div>
  );
}

function NodeCard({
  node,
  onDrillDown,
  onSelect,
  isSelected,
}: {
  node: HealthMapNode;
  onDrillDown?: (node: HealthMapNode) => void;
  onSelect: (node: HealthMapNode) => void;
  isSelected: boolean;
}) {
  const hasChildren = node.children && node.children.length > 0;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(node)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(node);
        }
      }}
      className={`border rounded-lg p-3 text-left transition-all hover:scale-[1.01] cursor-pointer ${
        isSelected ? "ring-2 ring-violet-500 " : ""
      }${riskColor(node.risk_level)}`}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="font-medium text-sm truncate">{node.name}</span>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${riskBadge(node.risk_level)}`}
        >
          {node.risk_level}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 text-[11px] text-zinc-400">
          <span>Score: {Math.round(node.health_score * 100)}%</span>
          <span>{node.entity_count} entities</span>
          {hasChildren && <span>{node.children?.length} dirs</span>}
        </div>
        {hasChildren && onDrillDown && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDrillDown(node);
            }}
            className="text-[11px] text-violet-300 hover:text-violet-200 transition-colors px-1.5 py-0.5 rounded hover:bg-violet-500/10"
            aria-label={`Open ${node.name}`}
          >
            Open \u25B8
          </button>
        )}
      </div>
    </div>
  );
}

type RecentActivity = {
  edit_count: number;
  session_count: number;
  most_recent_ts: string | null;
  window_days: number;
};

function DetailPanel({
  node,
  activity,
}: {
  node: HealthMapNode;
  activity: RecentActivity | null;
}) {
  const m = node.metrics;
  return (
    <div className="border border-zinc-700 rounded-lg p-4 bg-zinc-800/50">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-sm text-zinc-200 truncate">
          {node.path}
        </h3>
        <span
          className={`text-xs px-2 py-0.5 rounded-full font-medium ${riskBadge(node.risk_level)}`}
        >
          {Math.round(node.health_score * 100)}% health
        </span>
      </div>
      {activity && activity.edit_count >= 3 && (
        <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <div className="font-medium">
            🩹 Active churn — {activity.edit_count} edits in the last{" "}
            {activity.window_days} days
          </div>
          <div className="mt-0.5 text-[11px] text-amber-200/80">
            {activity.session_count} session
            {activity.session_count !== 1 ? "s" : ""} touched this file. Hot
            files are more likely to break unrelated callers.
          </div>
        </div>
      )}
      <div className="space-y-3">
        <MetricRow
          label="Called by"
          value={m.fan_in}
          max={40}
          hint={
            m.fan_in >= 20
              ? `${m.fan_in} places depend on this — high-blast file`
              : m.fan_in >= 5
                ? `${m.fan_in} dependents`
                : "Few dependents"
          }
        />
        <MetricRow
          label="Calls"
          value={m.fan_out}
          max={40}
          hint={
            m.fan_out >= 20
              ? `Imports ${m.fan_out} things — consider splitting`
              : `Uses ${m.fan_out} other entities`
          }
        />
        <MetricRow
          label="Edited recently"
          value={m.change_frequency}
          max={10}
          hint={
            m.change_frequency >= 5
              ? `${m.change_frequency} recent edits — hot file`
              : `${m.change_frequency} recent edits`
          }
        />
        <MetricRow
          label="Co-changes with"
          value={m.coupling_count}
          max={10}
          hint={
            m.coupling_count >= 5
              ? `Edited alongside ${m.coupling_count} other files — likely coupled`
              : `${m.coupling_count} co-change partners`
          }
        />
        <MetricRow
          label="Stability"
          value={Math.round(m.durability * 100)}
          max={100}
          unit="%"
          hint={
            m.durability >= 0.7
              ? "Rarely changes — stable surface"
              : m.durability >= 0.4
                ? "Moderate churn"
                : "Changes often"
          }
        />
      </div>
      <div className="mt-3 pt-3 border-t border-zinc-700 text-xs text-zinc-500">
        {node.entity_count} entities in this{" "}
        {node.children ? "directory" : "file"}
      </div>
    </div>
  );
}

export function HealthMapView({
  initialFilter,
}: {
  initialFilter?: string;
} = {}) {
  const [drillPath, setDrillPath] = useState<string[]>([]);
  const [selectedNode, setSelectedNode] = useState<HealthMapNode | null>(null);
  const [filter, setFilter] = useState(initialFilter ?? "");

  useEffect(() => {
    if (initialFilter !== undefined) {
      setFilter(initialFilter);
    }
  }, [initialFilter]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["health-map"],
    queryFn: () =>
      fetchJson<{ data: HealthMapNode }>("/api/intelligence/health-map"),
    staleTime: 30_000,
  });

  // R4: fetch recent activity for the selected file
  const isFileSelected = !!selectedNode && !selectedNode.children;
  const activityQ = useQuery({
    queryKey: ["health-map-file", selectedNode?.path],
    queryFn: () =>
      fetchJson<{ data: HealthMapNode & { recent_activity?: RecentActivity } }>(
        `/api/intelligence/health-map/file?path=${encodeURIComponent(
          selectedNode?.path ?? ""
        )}`
      ),
    enabled: isFileSelected,
    staleTime: 30_000,
  });
  const activity = activityQ.data?.data?.recent_activity ?? null;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-zinc-500">
        Loading health map...
      </div>
    );
  }
  if (error || !data?.data) {
    return (
      <div className="flex items-center justify-center h-64 text-red-400">
        Failed to load health map
      </div>
    );
  }

  const root = data.data;

  // Navigate to the current drill-down level
  let currentNode = root;
  for (const segment of drillPath) {
    const child = currentNode.children?.find((c) => c.path === segment);
    if (child) {
      currentNode = child;
    } else {
      break;
    }
  }

  const allNodes = currentNode.children ?? [currentNode];
  const q = filter.trim().toLowerCase();
  const nodes = q
    ? allNodes.filter(
        (n) =>
          n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)
      )
    : allNodes;

  return (
    <div className="space-y-4">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-xs text-zinc-400">
        <button
          type="button"
          onClick={() => {
            setDrillPath([]);
            setSelectedNode(null);
          }}
          className="hover:text-zinc-200 transition-colors"
        >
          root
        </button>
        {drillPath.map((seg, i) => (
          <span key={seg} className="flex items-center gap-1.5">
            <span className="text-zinc-600">/</span>
            <button
              type="button"
              onClick={() => {
                setDrillPath(drillPath.slice(0, i + 1));
                setSelectedNode(null);
              }}
              className="hover:text-zinc-200 transition-colors"
            >
              {seg.split("/").pop()}
            </button>
          </span>
        ))}
      </div>

      {/* Summary bar + filter */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4 text-sm">
          <span className="text-zinc-300">
            Overall health:{" "}
            <span className="font-semibold text-violet-400">
              {Math.round(currentNode.health_score * 100)}%
            </span>
          </span>
          <span className="text-zinc-500">
            {currentNode.entity_count} entities
          </span>
          <span
            className={`text-xs px-2 py-0.5 rounded-full ${riskBadge(currentNode.risk_level)}`}
          >
            {currentNode.risk_level} risk
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files in this level…"
            className="text-xs rounded-md border border-zinc-700 bg-zinc-800/60 px-2.5 py-1.5 w-56 focus:outline-none focus:border-violet-500 placeholder:text-zinc-500"
          />
          {filter && (
            <button
              type="button"
              onClick={() => setFilter("")}
              className="text-xs text-zinc-500 hover:text-zinc-300"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Grid / treemap area */}
        <div className="lg:col-span-2 grid grid-cols-2 sm:grid-cols-3 gap-2">
          {nodes.map((node) => (
            <NodeCard
              key={node.path}
              node={node}
              onDrillDown={(n) => {
                setDrillPath([...drillPath, n.path]);
                setSelectedNode(null);
              }}
              onSelect={setSelectedNode}
              isSelected={selectedNode?.path === node.path}
            />
          ))}
          {nodes.length === 0 && (
            <div className="col-span-full text-center text-zinc-500 py-8">
              No health data for this path
            </div>
          )}
        </div>

        {/* Detail panel */}
        <div>
          {selectedNode ? (
            <DetailPanel node={selectedNode} activity={activity} />
          ) : (
            <div className="border border-zinc-700 rounded-lg p-4 bg-zinc-800/50 text-zinc-500 text-sm">
              Click a file to see detailed health metrics
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
