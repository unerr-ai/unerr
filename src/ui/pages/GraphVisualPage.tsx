import { fetchJson } from "@/lib/api";
import { useRepoApi } from "@/lib/repo-context";
import type {
  GraphPositions,
  GraphVisualFileCommunity,
  GraphVisualFileNode,
  GraphVisualNode,
  GraphVisualResponse,
} from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { DataSet, Network } from "vis-network/standalone";

// ── Community palette: 16 HSL hues anchored on brand violet (271deg) ────────
const HUES = [
  271, 195, 140, 25, 320, 50, 170, 240, 0, 90, 210, 300, 60, 150, 30, 280,
];

function communityColor(id: number): string {
  const hue = HUES[id % HUES.length];
  const sat = id % 3 === 0 ? 70 : id % 3 === 1 ? 85 : 60;
  return `hsl(${hue}, ${sat}%, 62%)`;
}

function communityColorDark(id: number): string {
  const hue = HUES[id % HUES.length];
  const sat = id % 3 === 0 ? 70 : id % 3 === 1 ? 85 : 60;
  return `hsl(${hue}, ${sat}%, 42%)`;
}

function communityColorBg(id: number): string {
  const hue = HUES[id % HUES.length];
  return `hsl(${hue}, 60%, 20%)`;
}

const TEST_NODE_COLOR = "hsl(160, 40%, 45%)";
const TEST_NODE_BORDER = "hsl(160, 40%, 30%)";

// ── Types ───────────────────────────────────────────────────────────────────
type ViewLevel = "L0" | "L1" | "L2";
type BreadcrumbItem = {
  label: string;
  level: ViewLevel;
  communityId?: number;
  file?: string;
};

type LoadingStage = "fetching" | "building" | "done";
const STAGE_LABELS: Record<LoadingStage, string> = {
  fetching: "Fetching graph data…",
  building: "Building graph layout…",
  done: "",
};

// Cluster ID conventions
const COMMUNITY_CLUSTER_PREFIX = "cluster:filecommunity:";
const FILE_CLUSTER_PREFIX = "cluster:file:";

function communityClusterId(id: number) {
  return `${COMMUNITY_CLUSTER_PREFIX}${id}`;
}
function fileClusterId(file: string) {
  return `${FILE_CLUSTER_PREFIX}${file}`;
}
function parseCommunityId(clusterId: string): number {
  return Number.parseInt(clusterId.replace(COMMUNITY_CLUSTER_PREFIX, ""), 10);
}
function parseFilePath(clusterId: string): string {
  return clusterId.replace(FILE_CLUSTER_PREFIX, "");
}
function fileName(fp: string): string {
  return fp.split("/").pop() ?? fp;
}

// ── Position cache (localStorage) ──────────────────────────────────────────
const POSITION_CACHE_KEY = "unerr:graph-positions";

function getCachedPositions(): GraphPositions | null {
  try {
    const raw = localStorage.getItem(POSITION_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as GraphPositions;
  } catch {
    return null;
  }
}

function setCachedPositions(positions: GraphPositions): void {
  try {
    localStorage.setItem(POSITION_CACHE_KEY, JSON.stringify(positions));
  } catch {
    // localStorage full or unavailable
  }
}

// ── Edge visibility: max edges per level ───────────────────────────────────
const MAX_VISIBLE_EDGES = 100;

function filterEdgesForLevel(
  edges: Array<{ from: string; to: string; type: string }>,
  visibleNodeIds: Set<string>
): Array<{ from: string; to: string; type: string }> {
  // Only show edges where both endpoints are visible
  const relevant = edges.filter(
    (e) => visibleNodeIds.has(e.from) && visibleNodeIds.has(e.to)
  );
  if (relevant.length <= MAX_VISIBLE_EDGES) return relevant;
  // Prioritize: calls > tests > imports > others
  const priority: Record<string, number> = { calls: 3, tests: 2, imports: 1 };
  const sorted = [...relevant].sort(
    (a, b) => (priority[b.type] ?? 0) - (priority[a.type] ?? 0)
  );
  return sorted.slice(0, MAX_VISIBLE_EDGES);
}

export function GraphVisualPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const networkRef = useRef<Network | null>(null);
  const nodeDataSetRef = useRef<DataSet<any> | null>(null);
  const edgeDataSetRef = useRef<DataSet<any> | null>(null);

  const [selected, setSelected] = useState<GraphVisualNode | null>(null);
  const [selectedFile, setSelectedFile] = useState<GraphVisualFileNode | null>(
    null
  );
  const [neighbors, setNeighbors] = useState<GraphVisualNode[]>([]);
  const [searchQ, setSearchQ] = useState("");

  // Hierarchical state
  const [level, setLevel] = useState<ViewLevel>("L0");
  const [activeCommunity, setActiveCommunity] = useState<number | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbItem[]>([
    { label: "All Clusters", level: "L0" },
  ]);

  // Loading state
  const [stage, setStage] = useState<LoadingStage>("fetching");
  // Incremented to force network rebuild on navigation
  const [rebuildKey, setRebuildKey] = useState(0);

  const { url, queryKey } = useRepoApi();
  const { data, isLoading, isError } = useQuery({
    queryKey: queryKey(["intelligence", "graph-visual"]),
    queryFn: () =>
      fetchJson<GraphVisualResponse>(url("/api/intelligence/graph-visual")),
  });

  useEffect(() => {
    if (data && stage === "fetching") setStage("building");
    else if (isLoading) setStage("fetching");
  }, [data, isLoading, stage]);

  // ── Main graph effect: build network with pre-computed positions ─────────
  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuildKey is an intentional force-rebuild trigger
  useEffect(() => {
    if (!data?.data || !containerRef.current) return;
    if (networkRef.current) {
      networkRef.current.destroy();
      networkRef.current = null;
    }

    const { nodes, edges, fileNodes, fileEdges, fileCommunities, positions } =
      data.data;
    const viewMode = data._meta.view_mode;
    if (nodes.length === 0) {
      setStage("done");
      return;
    }

    // Use cached positions if server didn't provide them
    const effectivePositions: GraphPositions =
      positions && Object.keys(positions.files).length > 0
        ? positions
        : (getCachedPositions() ?? {
            communities: {},
            files: {},
            entities: {},
          });

    // Cache the positions for next load
    if (positions && Object.keys(positions.files).length > 0) {
      setCachedPositions(positions);
    }

    const maxDegree = Math.max(...nodes.map((n) => n.fanIn + n.fanOut), 1);

    // Build entity-level vis nodes with pre-computed positions
    const visNodes = nodes.map((n) => {
      const degree = n.fanIn + n.fanOut;
      const members = n.members ?? 0;
      const baseSize = 8 + 28 * (degree / maxDegree);
      const memberBoost = members > 0 ? Math.min(members * 2, 12) : 0;
      const size = baseSize + memberBoost;
      const isTest = n.isTest === true;
      const fileNode = fileNodes.find((fn) => fn.filePath === n.file);
      const fileComm = fileNode?.fileCommunity ?? 0;
      const color = isTest ? TEST_NODE_COLOR : communityColor(fileComm);
      const borderColor = isTest
        ? TEST_NODE_BORDER
        : communityColorDark(fileComm);
      const showLabel = degree > maxDegree * 0.1 || members > 3;
      const memberLabel = members > 0 ? ` (${members})` : "";
      const extLabel = n.externalOut > 0 ? ` ↗${n.externalOut}` : "";

      // Pre-computed position for L2
      const pos = effectivePositions.entities[n.id];

      return {
        id: n.id,
        label: showLabel ? `${n.label}${memberLabel}${extLabel}` : "",
        title: `${n.label}\n${n.kind}${members > 0 ? ` · ${members} members` : ""}\n${n.file}\nfan_in: ${n.fanIn}  fan_out: ${n.fanOut}\nrisk: ${n.risk}${n.externalOut > 0 ? `\n↗ ${n.externalOut} cross-cluster` : ""}`,
        size,
        shape: isTest ? "diamond" : "dot",
        color: {
          background: color,
          border: borderColor,
          highlight: { background: color, border: "#fafafa" },
          hover: { background: color, border: "#fafafa" },
        },
        font: {
          color: "rgba(250, 250, 250, 0.85)",
          size: Math.max(10, size * 0.7),
          face: "JetBrains Mono, monospace",
        },
        borderWidth: members > 0 ? 3 : 2,
        borderWidthSelected: 3,
        // Position from server (only used in flat/L2 mode)
        x: pos?.x,
        y: pos?.y,
        // Custom data for clustering
        filePath: n.file,
        fileCommunity: fileComm,
        _raw: n,
      };
    });

    // Build vis edges — apply edge visibility cap
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const allNodeIds = new Set(nodes.map((n) => n.id));
    const filteredEdges = filterEdgesForLevel(edges, allNodeIds);
    const visEdges = filteredEdges.map((e, i) => {
      const sourceNode = nodeMap.get(e.from);
      const sourceFile = fileNodes.find(
        (fn) => fn.filePath === sourceNode?.file
      );
      const edgeColor = sourceFile
        ? communityColor(sourceFile.fileCommunity)
        : "#8B5CF6";
      return {
        id: `e-${i}`,
        from: e.from,
        to: e.to,
        title: e.type,
        color: {
          color: edgeColor,
          opacity: 0.25,
          highlight: edgeColor,
          hover: edgeColor,
        },
        width: e.type === "calls" ? 1.5 : 1,
        smooth: { type: "continuous", roundness: 0.3 },
        arrows: { to: { enabled: true, scaleFactor: 0.4 } },
        font: {
          color: "rgba(250, 250, 250, 0.3)",
          size: 8,
          face: "JetBrains Mono, monospace",
          strokeWidth: 0,
        },
      };
    });

    const nodeDataSet = new DataSet(visNodes);
    const edgeDataSet = new DataSet(visEdges);
    nodeDataSetRef.current = nodeDataSet;
    edgeDataSetRef.current = edgeDataSet;

    // Network options: physics disabled (positions pre-computed), only enabled briefly for clustering transitions
    const network = new Network(
      containerRef.current,
      { nodes: nodeDataSet, edges: edgeDataSet },
      {
        physics: {
          enabled: false,
        },
        interaction: {
          hover: true,
          tooltipDelay: 150,
          zoomView: true,
          dragView: true,
          multiselect: false,
        },
        nodes: { shape: "dot" },
        edges: { selectionWidth: 2 },
      }
    );

    networkRef.current = network;

    // ── Clustering functions ────────────────────────────────────────────────

    function clusterByFileCommunity() {
      // First cluster all entities into their file nodes
      for (const fn of fileNodes) {
        const entitiesInFile = nodes.filter((n) => n.file === fn.filePath);
        if (entitiesInFile.length === 0) continue;

        // Get the file position from server
        const filePos = effectivePositions.files[fn.filePath];

        network.cluster({
          joinCondition: (nodeOptions: any) =>
            nodeOptions.filePath === fn.filePath,
          clusterNodeProperties: {
            id: fileClusterId(fn.filePath),
            label: `${fn.label}\n(${fn.entityCount})`,
            title: `${fn.filePath}\n${fn.entityCount} entities\nfan_in: ${fn.totalFanIn}  fan_out: ${fn.totalFanOut}\nrisk: ${fn.maxRisk}`,
            shape: "box",
            size: 15 + Math.min(fn.entityCount * 3, 30),
            x: filePos?.x,
            y: filePos?.y,
            color: {
              background: communityColorBg(fn.fileCommunity),
              border: communityColor(fn.fileCommunity),
              highlight: {
                background: communityColorBg(fn.fileCommunity),
                border: "#fafafa",
              },
              hover: {
                background: communityColorBg(fn.fileCommunity),
                border: "#fafafa",
              },
            },
            font: {
              color: "rgba(250, 250, 250, 0.9)",
              size: 11,
              face: "JetBrains Mono, monospace",
              multi: true,
            },
            borderWidth: 2,
            borderWidthSelected: 3,
            fileCommunity: fn.fileCommunity,
            _fileNode: fn,
          },
          clusterEdgeProperties: {
            color: { inherit: "both", opacity: 0.35 },
          },
        });
      }

      // Then cluster file nodes into file-community clusters
      for (const comm of fileCommunities) {
        const commPos = effectivePositions.communities[comm.id];

        network.cluster({
          joinCondition: (nodeOptions: any) =>
            nodeOptions.fileCommunity === comm.id,
          clusterNodeProperties: {
            id: communityClusterId(comm.id),
            label: `${comm.label}\n(${comm.fileCount} files)`,
            title: `${comm.label}\n${comm.fileCount} files · ${comm.entityCount} entities\nCohesion: ${Math.round(comm.cohesion * 100)}%`,
            shape: "dot",
            size: 25 + Math.min(comm.fileCount * 4, 45),
            x: commPos?.x,
            y: commPos?.y,
            color: {
              background: communityColorBg(comm.id),
              border: communityColor(comm.id),
              highlight: {
                background: communityColorBg(comm.id),
                border: "#fafafa",
              },
              hover: {
                background: communityColorBg(comm.id),
                border: "#fafafa",
              },
            },
            font: {
              color: communityColor(comm.id),
              size: 14,
              face: "Space Grotesk, sans-serif",
              bold: { color: "#fafafa" },
              multi: true,
            },
            borderWidth: comm.cohesion > 0.5 ? 3 : 2,
            borderWidthSelected: 4,
            shapeProperties: {
              borderDashes: comm.cohesion < 0.3 ? [5, 5] : false,
            },
          },
          clusterEdgeProperties: {
            color: { inherit: "both", opacity: 0.4 },
            smooth: { type: "continuous", roundness: 0.5 },
          },
        });
      }
    }

    function clusterByFile(communityId?: number) {
      const relevantFiles =
        communityId !== undefined
          ? fileNodes.filter((fn) => fn.fileCommunity === communityId)
          : fileNodes;

      for (const fn of relevantFiles) {
        const entitiesInFile = nodes.filter((n) => n.file === fn.filePath);
        if (entitiesInFile.length < 2) continue;
        const filePos = effectivePositions.files[fn.filePath];

        network.cluster({
          joinCondition: (nodeOptions: any) => {
            if (
              communityId !== undefined &&
              nodeOptions.fileCommunity !== communityId
            )
              return false;
            return nodeOptions.filePath === fn.filePath;
          },
          clusterNodeProperties: {
            id: fileClusterId(fn.filePath),
            label: `${fn.label}\n(${fn.entityCount})`,
            title: `${fn.filePath}\n${fn.entityCount} entities`,
            shape: "box",
            size: 15 + Math.min(fn.entityCount * 3, 25),
            x: filePos?.x,
            y: filePos?.y,
            color: {
              background: communityColorBg(fn.fileCommunity),
              border: communityColor(fn.fileCommunity),
              highlight: {
                background: communityColorBg(fn.fileCommunity),
                border: "#fafafa",
              },
              hover: {
                background: communityColorBg(fn.fileCommunity),
                border: "#fafafa",
              },
            },
            font: {
              color: "rgba(250, 250, 250, 0.9)",
              size: 11,
              face: "JetBrains Mono, monospace",
              multi: true,
            },
            borderWidth: 2,
            borderWidthSelected: 3,
            fileCommunity: fn.fileCommunity,
            _fileNode: fn,
          },
          clusterEdgeProperties: {
            color: { inherit: "both", opacity: 0.35 },
          },
        });
      }
    }

    // Apply initial clustering based on view_mode
    if (viewMode === "hierarchical") {
      clusterByFileCommunity();
      setLevel("L0");
      setBreadcrumb([{ label: "All Clusters", level: "L0" }]);
    } else if (viewMode === "file-clusters") {
      clusterByFile();
      setLevel("L1");
      setBreadcrumb([{ label: "All Files", level: "L1" }]);
    } else {
      setLevel("L2");
      setBreadcrumb([{ label: "Flat View", level: "L2" }]);
    }

    // Enable physics briefly to settle clusters, then disable
    network.setOptions({
      physics: {
        enabled: true,
        solver: "forceAtlas2Based",
        forceAtlas2Based: {
          gravitationalConstant: -60,
          centralGravity: 0.008,
          springLength: 120,
          springConstant: 0.06,
          damping: 0.8,
          avoidOverlap: 0.3,
        },
        stabilization: false,
      },
    });
    // Explicitly trigger stabilization (must call stabilize() since physics was disabled at creation)
    network.stabilize(80);

    // ── Double-click → drill down (local expansion) ─────────────────────────
    network.on("doubleClick", (params: any) => {
      const nodeId = params.nodes?.[0];
      if (!nodeId) return;

      if (network.isCluster(nodeId)) {
        const isCommCluster = String(nodeId).startsWith(
          COMMUNITY_CLUSTER_PREFIX
        );
        const isFileCluster = String(nodeId).startsWith(FILE_CLUSTER_PREFIX);

        // Open the cluster with circular release (local expansion, not rebuild)
        network.openCluster(nodeId, {
          releaseFunction: (clusterPos: any, containedPositions: any) => {
            const keys = Object.keys(containedPositions);
            const count = keys.length;
            const radius = Math.max(80, count * 12);
            const result: Record<string, { x: number; y: number }> = {};

            // Use pre-computed positions offset from cluster center
            keys.forEach((k, i) => {
              // Check if we have a pre-computed position for this node
              const precomputed =
                effectivePositions.files[k] ?? effectivePositions.entities[k];
              if (precomputed) {
                result[k] = {
                  x: clusterPos.x + precomputed.x * 0.5,
                  y: clusterPos.y + precomputed.y * 0.5,
                };
              } else {
                const angle = (2 * Math.PI * i) / count;
                result[k] = {
                  x: clusterPos.x + radius * Math.cos(angle),
                  y: clusterPos.y + radius * Math.sin(angle),
                };
              }
            });
            return result;
          },
        });

        // Brief physics to settle revealed nodes
        network.setOptions({
          physics: {
            enabled: true,
            solver: "forceAtlas2Based",
            forceAtlas2Based: { damping: 0.85, gravitationalConstant: -40 },
            stabilization: { enabled: false },
          },
        });
        setTimeout(() => {
          network.setOptions({ physics: { enabled: false } });
        }, 1500);

        if (isCommCluster) {
          const commId = parseCommunityId(nodeId);
          setLevel("L1");
          setActiveCommunity(commId);
          setActiveFile(null);
          const commLabel =
            fileCommunities.find((c) => c.id === commId)?.label ||
            `Cluster ${commId}`;
          setBreadcrumb([
            { label: "All Clusters", level: "L0" },
            { label: commLabel, level: "L1", communityId: commId },
          ]);
        } else if (isFileCluster) {
          const fp = parseFilePath(nodeId);
          setLevel("L2");
          setActiveFile(fp);
          setBreadcrumb((prev) => [
            ...prev.slice(0, prev.length > 1 ? 2 : 1),
            { label: fileName(fp), level: "L2", file: fp },
          ]);
        }

        // Fit to revealed area
        setTimeout(() => {
          network.fit({
            animation: { duration: 600, easingFunction: "easeInOutQuad" },
          });
        }, 200);
      }
    });

    // ── Single-click → select node ──────────────────────────────────────────
    network.on("selectNode", (params: any) => {
      const nodeId = params.nodes[0];
      if (network.isCluster(nodeId)) {
        if (String(nodeId).startsWith(FILE_CLUSTER_PREFIX)) {
          const fp = parseFilePath(nodeId);
          const fn = fileNodes.find((f) => f.filePath === fp);
          if (fn) {
            setSelectedFile(fn);
            setSelected(null);
          }
        }
        return;
      }
      const rawNode = nodes.find((n) => n.id === nodeId);
      if (rawNode) {
        setSelected(rawNode);
        setSelectedFile(null);
        const connectedEdges = edges.filter(
          (e) => e.from === nodeId || e.to === nodeId
        );
        const neighborIds = new Set(
          connectedEdges.map((e) => (e.from === nodeId ? e.to : e.from))
        );
        setNeighbors(nodes.filter((n) => neighborIds.has(n.id)).slice(0, 20));
      }
    });

    network.on("deselectNode", () => {
      setSelected(null);
      setSelectedFile(null);
      setNeighbors([]);
    });

    // ── Stabilization → done ────────────────────────────────────────────────
    let stabilized = false;
    const markDone = () => {
      if (stabilized) return;
      stabilized = true;
      network.setOptions({ physics: { enabled: false } });
      setStage("done");
      updateMinimap();
    };
    network.on("stabilizationIterationsDone", markDone);
    // Safety timeout: if stabilization event doesn't fire within 3s, force done
    const safetyTimer = setTimeout(markDone, 3000);

    // ── Minimap: update on viewport change ─────────────────────────────────
    network.on("zoom", () => updateMinimap());
    network.on("dragEnd", () => updateMinimap());

    setStage("building");

    return () => {
      clearTimeout(safetyTimer);
      network.destroy();
      networkRef.current = null;
      nodeDataSetRef.current = null;
      edgeDataSetRef.current = null;
    };
  }, [data, rebuildKey]);

  // ── Minimap rendering ───────────────────────────────────────────────────
  const updateMinimap = useCallback(() => {
    const canvas = minimapRef.current;
    const network = networkRef.current;
    if (!canvas || !network) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Get all node positions
    const positions = network.getPositions();
    const posArr = Object.values(positions) as Array<{ x: number; y: number }>;
    if (posArr.length === 0) return;

    // Compute bounding box of all nodes
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const p of posArr) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;
    const pad = 10;

    // Draw nodes as dots
    ctx.fillStyle = "rgba(139, 92, 246, 0.5)";
    for (const p of posArr) {
      const x = pad + ((p.x - minX) / rangeX) * (w - 2 * pad);
      const y = pad + ((p.y - minY) / rangeY) * (h - 2 * pad);
      ctx.beginPath();
      ctx.arc(x, y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw viewport rectangle
    try {
      const viewPos = network.getViewPosition();
      const scale = network.getScale();
      const container = containerRef.current;
      if (container && viewPos) {
        const vw = container.clientWidth / scale;
        const vh = container.clientHeight / scale;

        const vx = pad + ((viewPos.x - vw / 2 - minX) / rangeX) * (w - 2 * pad);
        const vy = pad + ((viewPos.y - vh / 2 - minY) / rangeY) * (h - 2 * pad);
        const vWidth = (vw / rangeX) * (w - 2 * pad);
        const vHeight = (vh / rangeY) * (h - 2 * pad);

        ctx.strokeStyle = "rgba(250, 250, 250, 0.6)";
        ctx.lineWidth = 1;
        ctx.strokeRect(vx, vy, vWidth, vHeight);
      }
    } catch {
      // viewport info not available yet
    }
  }, []);

  // ── Breadcrumb navigation: re-cluster without destroying ────────────────
  const navigateTo = useCallback(
    (item: BreadcrumbItem) => {
      const network = networkRef.current;
      if (!network || !data?.data) return;

      const { fileCommunities, fileNodes, nodes } = data.data;

      // Strategy: instead of destroying, we re-cluster visible nodes
      // For going back to L0, we need to rebuild — but without destroying the Network instance
      // vis-network doesn't support "re-clustering" open nodes easily, so we rebuild DataSets
      if (item.level === "L0") {
        setLevel("L0");
        setActiveCommunity(null);
        setActiveFile(null);
        setBreadcrumb([{ label: "All Clusters", level: "L0" }]);
      } else if (item.level === "L1" && item.communityId != null) {
        setLevel("L1");
        setActiveCommunity(item.communityId);
        setActiveFile(null);
        setBreadcrumb([
          { label: "All Clusters", level: "L0" },
          { label: item.label, level: "L1", communityId: item.communityId },
        ]);
      }

      // Trigger a rebuild by incrementing rebuildKey (effect depends on it)
      // vis-network clustering doesn't support "re-clustering" opened nodes,
      // but since positions are pre-computed, the rebuild is instant and stable
      setStage("building");
      setRebuildKey((k) => k + 1);
    },
    [data]
  );

  // ── Escape key → go up one level ────────────────────────────────────────
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && breadcrumb.length > 1) {
        const parent = breadcrumb[breadcrumb.length - 2];
        navigateTo(parent);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [breadcrumb, navigateTo]);

  // ── Search → focus node ─────────────────────────────────────────────────
  const handleSearch = useCallback(
    (query: string) => {
      setSearchQ(query);
      if (!networkRef.current || !data?.data || query.length < 2) return;
      const q = query.toLowerCase();
      const matchEntity = data.data.nodes.find((n) =>
        n.label.toLowerCase().includes(q)
      );
      const matchFile = data.data.fileNodes.find(
        (f) =>
          f.label.toLowerCase().includes(q) ||
          f.filePath.toLowerCase().includes(q)
      );

      const target =
        matchEntity?.id ??
        (matchFile ? fileClusterId(matchFile.filePath) : null);
      if (target && networkRef.current) {
        const foundPath = networkRef.current.findNode(target);
        if (foundPath && foundPath.length > 1) {
          for (let i = 0; i < foundPath.length - 1; i++) {
            const clusterId = foundPath[i];
            if (networkRef.current.isCluster(clusterId)) {
              networkRef.current.openCluster(clusterId);
            }
          }
        }
        networkRef.current.selectNodes([target]);
        networkRef.current.focus(target, {
          scale: 1.5,
          animation: { duration: 600, easingFunction: "easeInOutQuad" },
        });
        if (matchEntity) {
          setSelected(matchEntity);
          setSelectedFile(null);
        } else if (matchFile) {
          setSelectedFile(matchFile);
          setSelected(null);
        }
      }
    },
    [data]
  );

  // ── Export PNG ──────────────────────────────────────────────────────────
  const handleExport = useCallback(() => {
    if (!containerRef.current) return;
    const canvas = containerRef.current.querySelector("canvas");
    if (!canvas) return;
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = canvas.width;
    exportCanvas.height = canvas.height;
    const ctx = exportCanvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(canvas, 0, 0);
    const link = document.createElement("a");
    link.download = "unerr-codebase-map.png";
    link.href = exportCanvas.toDataURL("image/png");
    link.click();
  }, []);

  const nodeCount = data?.data?.nodes.length ?? 0;
  const edgeCount = data?.data?.edges.length ?? 0;
  const meta = data?._meta;
  const fileCount = meta?.file_count ?? 0;
  const fileEdgeCount = meta?.file_edge_count ?? 0;
  const collapsedCount = meta?.collapsed_count ?? 0;
  const totalEntities = meta?.total_entities ?? 0;
  const fileCommunities = data?.data?.fileCommunities ?? [];
  const viewMode = meta?.view_mode ?? "flat";
  const showLoadingOverlay = stage !== "done" && !isError;

  return (
    <div className="flex h-[calc(100vh-73px)] flex-col gap-0 overflow-hidden lg:flex-row">
      {/* Main canvas area */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Toolbar */}
        <div className="flex items-center gap-3 border-b border-border-subtle bg-surface/80 px-4 py-2 backdrop-blur">
          {/* Breadcrumb */}
          <nav className="flex items-center gap-1 text-xs">
            {breadcrumb.map((item, i) => (
              <span
                key={`${item.level}-${item.communityId ?? item.file ?? "root"}`}
                className="flex items-center gap-1"
              >
                {i > 0 && <span className="t-ghost">›</span>}
                {i < breadcrumb.length - 1 ? (
                  <button
                    type="button"
                    onClick={() => navigateTo(item)}
                    className="rounded px-1.5 py-0.5 text-violet-400 transition hover:bg-violet-500/10 hover:text-violet-300"
                  >
                    {item.label}
                  </button>
                ) : (
                  <span className="px-1.5 py-0.5 text-foreground font-medium">
                    {item.label}
                  </span>
                )}
              </span>
            ))}
          </nav>

          <div className="mx-2 h-4 w-px bg-border-subtle" />

          <input
            type="search"
            value={searchQ}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Search files & entities..."
            className="w-48 rounded-lg border border-border bg-background px-3 py-1.5 font-mono text-sm text-foreground outline-none ring-violet-500 placeholder:t-tertiary focus:ring-2 focus:border-violet-500"
          />

          <div className="flex-1" />

          <span className="font-mono text-xs t-tertiary">
            {fileCount} files · {nodeCount} entities
            {viewMode !== "flat" && (
              <span className="ml-2 rounded bg-violet-500/10 px-1.5 py-0.5 text-violet-400">
                {level === "L0"
                  ? "Clusters"
                  : level === "L1"
                    ? "Files"
                    : "Entities"}
              </span>
            )}
          </span>

          {breadcrumb.length > 1 && (
            <button
              type="button"
              onClick={() => navigateTo(breadcrumb[breadcrumb.length - 2])}
              className="rounded-lg border border-border-subtle el-raised px-3 py-1.5 text-xs font-medium text-foreground transition hover:el-overlay hover:border-violet-500"
              title="Zoom out (Esc)"
            >
              ↑ Up
            </button>
          )}
          <button
            type="button"
            onClick={handleExport}
            className="rounded-lg border border-border-subtle el-raised px-3 py-1.5 text-xs font-medium text-foreground transition hover:el-overlay hover:border-violet-500"
          >
            Export PNG
          </button>
          <button
            type="button"
            onClick={() => networkRef.current?.fit({ animation: true })}
            className="rounded-lg border border-border-subtle el-raised px-3 py-1.5 text-xs font-medium text-foreground transition hover:el-overlay hover:border-violet-500"
          >
            Fit
          </button>
        </div>

        {/* Canvas */}
        <div className="relative flex-1 bg-background">
          {/* Loading overlay */}
          {showLoadingOverlay && (
            <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
              <div className="flex flex-col items-center gap-4 rounded-xl border border-border-subtle bg-surface-default/95 px-10 py-8 shadow-2xl backdrop-blur-sm">
                <svg
                  aria-hidden="true"
                  className="h-12 w-12 animate-spin"
                  viewBox="0 0 48 48"
                  fill="none"
                >
                  <circle
                    cx="24"
                    cy="24"
                    r="20"
                    stroke="rgba(255,255,255,0.06)"
                    strokeWidth="5"
                  />
                  <path
                    d="M24 4 A20 20 0 0 1 41.32 34"
                    stroke="#8B5CF6"
                    strokeWidth="5"
                    strokeLinecap="round"
                  />
                  <path
                    d="M41.32 34 A20 20 0 0 1 14 40.64"
                    stroke="#22D3EE"
                    strokeWidth="5"
                    strokeLinecap="round"
                  />
                  <path
                    d="M14 40.64 A20 20 0 0 1 6.06 17.1"
                    stroke="#34D399"
                    strokeWidth="5"
                    strokeLinecap="round"
                  />
                </svg>
                <p className="font-mono text-sm text-foreground font-medium">
                  {STAGE_LABELS[stage]}
                </p>
                {nodeCount > 0 && (
                  <p className="font-mono text-[11px] t-tertiary">
                    {fileCount} files · {nodeCount} entities
                  </p>
                )}
              </div>
            </div>
          )}

          {isError && (
            <div className="absolute inset-0 z-20 flex items-center justify-center">
              <div className="glass-panel rounded-xl p-8 text-center">
                <p className="text-error text-sm font-medium">
                  Graph unavailable
                </p>
                <p className="mt-2 t-secondary text-xs">
                  Intelligence graph not loaded. Run{" "}
                  <code className="rounded el-substrate px-1.5 py-0.5 font-mono">
                    unerr
                  </code>{" "}
                  in your project to index.
                </p>
              </div>
            </div>
          )}

          {!isLoading && !isError && nodeCount === 0 && (
            <div className="absolute inset-0 z-20 flex items-center justify-center">
              <div className="glass-panel rounded-xl p-8 text-center">
                <p className="text-foreground text-sm font-medium">
                  No entities found
                </p>
                <p className="mt-2 t-secondary text-xs">
                  The graph will appear once the project is indexed.
                </p>
              </div>
            </div>
          )}

          <div
            ref={containerRef}
            className="absolute inset-0"
            style={{
              opacity: stage === "done" ? 1 : stage === "building" ? 0.4 : 0.2,
              transition: "opacity 0.8s ease",
            }}
          />

          {/* Minimap */}
          {stage === "done" && (
            <div className="absolute bottom-4 left-4 rounded-lg border border-border-subtle bg-surface-default/90 p-1 backdrop-blur-sm">
              <canvas
                ref={minimapRef}
                width={160}
                height={100}
                className="rounded"
                style={{ background: "rgba(0,0,0,0.3)" }}
              />
            </div>
          )}

          {/* Interaction hint */}
          {stage === "done" &&
            level === "L0" &&
            viewMode === "hierarchical" && (
              <div className="pointer-events-none absolute bottom-4 right-4 rounded-lg border border-border-subtle bg-surface-default/90 px-3 py-2 backdrop-blur-sm">
                <p className="font-mono text-[10px] t-secondary">
                  Double-click a cluster to explore its files
                </p>
              </div>
            )}
        </div>
      </div>

      {/* Sidebar */}
      <aside className="w-full shrink-0 overflow-y-auto border-t border-border-subtle glass-panel lg:w-80 lg:border-t-0 lg:border-l">
        <div className="p-4">
          {/* Selected entity info */}
          {selected ? (
            <div className="space-y-4">
              <div>
                <h3 className="section-label text-violet-500">
                  Selected entity
                </h3>
                <div className="mt-2 rounded-lg el-raised p-3">
                  <div className="font-mono text-live text-sm font-medium">
                    {selected.label}
                  </div>
                  <div className="mt-1 flex items-center gap-2 flex-wrap">
                    <span className="t-tertiary text-xs">{selected.kind}</span>
                    {(selected.members ?? 0) > 0 && (
                      <span className="rounded bg-violet-500/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-violet-400">
                        {selected.members} members
                      </span>
                    )}
                    {selected.isTest && (
                      <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-emerald-400">
                        test
                      </span>
                    )}
                  </div>
                  <div className="mt-1 truncate t-tertiary text-xs">
                    {selected.file}
                  </div>
                  <div className="mt-2 flex gap-3 text-xs">
                    <span>
                      <span className="t-secondary">in</span>{" "}
                      <span className="font-mono text-live">
                        {selected.fanIn}
                      </span>
                    </span>
                    <span>
                      <span className="t-secondary">out</span>{" "}
                      <span className="font-mono text-live">
                        {selected.fanOut}
                      </span>
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${
                        selected.risk === "critical"
                          ? "bg-error/15 text-error"
                          : selected.risk === "high"
                            ? "bg-warning/15 text-warning"
                            : selected.risk === "medium"
                              ? "bg-violet-500/15 text-violet-500"
                              : "bg-success/15 text-success"
                      }`}
                    >
                      {selected.risk}
                    </span>
                  </div>
                </div>
              </div>

              {/* External dependencies */}
              {(selected.externalOut > 0 || selected.externalIn > 0) && (
                <div>
                  <h3 className="section-label t-secondary">Cross-cluster</h3>
                  <div className="mt-2 flex gap-4 text-xs">
                    {selected.externalOut > 0 && (
                      <span className="flex items-center gap-1">
                        <span className="text-warning">↗</span>
                        <span className="font-mono text-live">
                          {selected.externalOut}
                        </span>
                        <span className="t-tertiary">outbound</span>
                      </span>
                    )}
                    {selected.externalIn > 0 && (
                      <span className="flex items-center gap-1">
                        <span className="text-info">↙</span>
                        <span className="font-mono text-live">
                          {selected.externalIn}
                        </span>
                        <span className="t-tertiary">inbound</span>
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Location context */}
              {activeCommunity != null && (
                <div>
                  <h3 className="section-label t-secondary">Location</h3>
                  <div className="mt-2 text-xs">
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{
                          backgroundColor: communityColor(activeCommunity),
                        }}
                      />
                      <span className="text-foreground">
                        {fileCommunities.find((c) => c.id === activeCommunity)
                          ?.label || `Cluster ${activeCommunity}`}
                      </span>
                    </div>
                    {fileCommunities.find((c) => c.id === activeCommunity)
                      ?.cohesion != null && (
                      <div className="mt-1 t-tertiary">
                        Cohesion:{" "}
                        {Math.round(
                          (fileCommunities.find((c) => c.id === activeCommunity)
                            ?.cohesion ?? 0) * 100
                        )}
                        %
                      </div>
                    )}
                  </div>
                </div>
              )}

              {neighbors.length > 0 && (
                <div>
                  <h3 className="section-label t-secondary">
                    Connected ({neighbors.length})
                  </h3>
                  <ul className="mt-2 max-h-48 space-y-1 overflow-auto custom-scrollbar">
                    {neighbors.map((n) => (
                      <li key={n.id}>
                        <button
                          type="button"
                          onClick={() => {
                            if (networkRef.current) {
                              networkRef.current.selectNodes([n.id]);
                              networkRef.current.focus(n.id, {
                                scale: 1.5,
                                animation: {
                                  duration: 400,
                                  easingFunction: "easeInOutQuad",
                                },
                              });
                            }
                            setSelected(n);
                          }}
                          className="w-full rounded px-2 py-1 text-left text-xs transition hover:el-raised"
                        >
                          <span className="font-mono text-live">{n.label}</span>
                          <span className="t-tertiary">
                            {" "}
                            · {fileName(n.file)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : selectedFile ? (
            /* Selected file node info */
            <div className="space-y-4">
              <div>
                <h3 className="section-label text-violet-500">Selected file</h3>
                <div className="mt-2 rounded-lg el-raised p-3">
                  <div className="font-mono text-live text-sm font-medium">
                    {selectedFile.label}
                  </div>
                  <div className="mt-1 truncate t-tertiary text-xs">
                    {selectedFile.filePath}
                  </div>
                  <div className="mt-2 flex gap-3 text-xs flex-wrap">
                    <span>
                      <span className="t-secondary">entities</span>{" "}
                      <span className="font-mono text-live">
                        {selectedFile.entityCount}
                      </span>
                    </span>
                    <span>
                      <span className="t-secondary">fan_in</span>{" "}
                      <span className="font-mono text-live">
                        {selectedFile.totalFanIn}
                      </span>
                    </span>
                    <span>
                      <span className="t-secondary">fan_out</span>{" "}
                      <span className="font-mono text-live">
                        {selectedFile.totalFanOut}
                      </span>
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${
                        selectedFile.maxRisk === "high"
                          ? "bg-warning/15 text-warning"
                          : selectedFile.maxRisk === "medium"
                            ? "bg-violet-500/15 text-violet-500"
                            : "bg-success/15 text-success"
                      }`}
                    >
                      {selectedFile.maxRisk}
                    </span>
                  </div>
                  {/* Entity kinds breakdown */}
                  <div className="mt-2 flex gap-2 flex-wrap">
                    {Object.entries(selectedFile.kinds).map(([kind, count]) => (
                      <span
                        key={kind}
                        className="rounded bg-surface-overlay px-1.5 py-0.5 font-mono text-[10px] t-secondary"
                      >
                        {kind}: {count}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              {(selectedFile.externalOut > 0 ||
                selectedFile.externalIn > 0) && (
                <div>
                  <h3 className="section-label t-secondary">
                    Cross-cluster edges
                  </h3>
                  <div className="mt-2 flex gap-4 text-xs">
                    {selectedFile.externalOut > 0 && (
                      <span className="flex items-center gap-1">
                        <span className="text-warning">↗</span>
                        <span className="font-mono text-live">
                          {selectedFile.externalOut}
                        </span>
                        <span className="t-tertiary">outbound</span>
                      </span>
                    )}
                    {selectedFile.externalIn > 0 && (
                      <span className="flex items-center gap-1">
                        <span className="text-info">↙</span>
                        <span className="font-mono text-live">
                          {selectedFile.externalIn}
                        </span>
                        <span className="t-tertiary">inbound</span>
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div>
              <h3 className="section-label text-violet-500">Inspector</h3>
              <p className="mt-3 t-secondary text-xs leading-relaxed">
                {level === "L0"
                  ? "Double-click a file cluster to explore its files. Click a node for details."
                  : level === "L1"
                    ? "Double-click a file to see its entities. Click a node for details."
                    : "Click a node to inspect its connections, risk level, and dependencies."}
              </p>
            </div>
          )}

          {/* File Communities legend */}
          <div className="mt-6">
            <h3 className="section-label t-secondary">File Clusters</h3>
            <ul className="mt-2 max-h-40 space-y-1 overflow-auto custom-scrollbar">
              {fileCommunities.slice(0, 16).map((c) => (
                <li key={c.id} className="flex items-center gap-2 text-xs">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: communityColor(c.id) }}
                  />
                  <span className="truncate text-foreground">{c.label}</span>
                  <span className="ml-auto tabular-nums t-tertiary">
                    {c.fileCount}f
                  </span>
                  {c.cohesion < 0.3 && (
                    <span
                      className="text-warning text-[10px]"
                      title="Low cohesion"
                    >
                      !
                    </span>
                  )}
                </li>
              ))}
              <li className="flex items-center gap-2 text-xs">
                <span
                  className="inline-block h-2.5 w-2.5 rotate-45 rounded-sm"
                  style={{ backgroundColor: TEST_NODE_COLOR }}
                />
                <span className="text-foreground">Test files</span>
                <span className="ml-auto t-tertiary">◇</span>
              </li>
            </ul>
          </div>

          {/* Stats */}
          <div className="mt-6 rounded-lg border border-border-subtle el-raised p-3">
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <div className="t-secondary">Files</div>
                <div className="font-mono text-live text-lg tabular-nums">
                  {fileCount}
                </div>
              </div>
              <div>
                <div className="t-secondary">File edges</div>
                <div className="font-mono text-live text-lg tabular-nums">
                  {fileEdgeCount}
                </div>
              </div>
              <div>
                <div className="t-secondary">Clusters</div>
                <div className="font-mono text-live text-lg tabular-nums">
                  {fileCommunities.length}
                </div>
              </div>
              <div>
                <div className="t-secondary">Entities</div>
                <div className="font-mono text-live text-lg tabular-nums">
                  {totalEntities}
                </div>
              </div>
            </div>
            {collapsedCount > 0 && (
              <div className="mt-2 pt-2 border-t border-border-subtle t-tertiary text-[10px]">
                {collapsedCount} child entities (methods, types, constructors)
                merged into parent nodes
              </div>
            )}
            {viewMode !== "flat" && (
              <div className="mt-2 pt-2 border-t border-border-subtle t-tertiary text-[10px]">
                View:{" "}
                {viewMode === "hierarchical"
                  ? "Hierarchical (L0→L1→L2)"
                  : "File clusters"}{" "}
                · Level: {level}
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
