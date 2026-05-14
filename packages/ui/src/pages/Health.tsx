import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const MOCK_DATA = {
  grade: "B" as const,
  entityCount: 847,
  edgeCount: 2_134,
  fileCount: 156,
  conventionCount: 12,
  communityCount: 8,
  riskEntities: [
    { key: "src/proxy/proxy.ts::startProxy", name: "startProxy", kind: "function", fanIn: 14, riskLevel: "high" },
    { key: "src/intelligence/local-graph.ts::CozoGraphStore", name: "CozoGraphStore", kind: "class", fanIn: 23, riskLevel: "high" },
    { key: "src/tracking/drift-tracker.ts::DriftTracker", name: "DriftTracker", kind: "class", fanIn: 11, riskLevel: "high" },
    { key: "src/core/query-engine.ts::executeQuery", name: "executeQuery", kind: "function", fanIn: 8, riskLevel: "medium" },
    { key: "src/tracking/shadow-ledger.ts::ShadowLedger", name: "ShadowLedger", kind: "class", fanIn: 7, riskLevel: "medium" },
  ],
};

const GRADE_COLORS: Record<string, string> = {
  A: "bg-emerald-600",
  B: "bg-blue-600",
  C: "bg-amber-600",
  D: "bg-orange-600",
  F: "bg-red-600",
};

export function HealthPage() {
  const { grade, entityCount, edgeCount, fileCount, conventionCount, communityCount, riskEntities } = MOCK_DATA;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Codebase Health</h1>
        <p className="text-sm text-muted-foreground">Graph intelligence overview for your project</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Health Grade</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3">
              <span className={`inline-flex h-12 w-12 items-center justify-center rounded-lg text-2xl font-bold text-white ${GRADE_COLORS[grade] ?? "bg-zinc-600"}`}>
                {grade}
              </span>
              <span className="text-sm text-muted-foreground">Based on {entityCount} entities</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardDescription>Entities</CardDescription></CardHeader>
          <CardContent><div className="text-2xl font-bold">{entityCount.toLocaleString()}</div></CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardDescription>Edges</CardDescription></CardHeader>
          <CardContent><div className="text-2xl font-bold">{edgeCount.toLocaleString()}</div></CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardDescription>Files</CardDescription></CardHeader>
          <CardContent><div className="text-2xl font-bold">{fileCount}</div></CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardDescription>Conventions</CardDescription></CardHeader>
          <CardContent><div className="text-2xl font-bold">{conventionCount}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>Communities</CardDescription></CardHeader>
          <CardContent><div className="text-2xl font-bold">{communityCount}</div></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Top Risk Entities</CardTitle>
          <CardDescription>Entities with highest blast radius (fan_in)</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Entity</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Fan-in</TableHead>
                <TableHead>Risk</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {riskEntities.map((e) => (
                <TableRow key={e.key}>
                  <TableCell className="font-mono text-xs">{e.name}</TableCell>
                  <TableCell>{e.kind}</TableCell>
                  <TableCell>{e.fanIn}</TableCell>
                  <TableCell>
                    <Badge variant={e.riskLevel === "high" ? "destructive" : "warning"}>
                      {e.riskLevel}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
