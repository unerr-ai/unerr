import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

const MOCK_SESSIONS = [
  { id: "s1", date: "2026-04-30", duration: "42m", toolCalls: 87, tokensSaved: 23_400, efficiency: 67 },
  { id: "s2", date: "2026-04-29", duration: "1h 15m", toolCalls: 142, tokensSaved: 38_200, efficiency: 72 },
  { id: "s3", date: "2026-04-28", duration: "28m", toolCalls: 56, tokensSaved: 14_800, efficiency: 61 },
  { id: "s4", date: "2026-04-27", duration: "55m", toolCalls: 103, tokensSaved: 29_100, efficiency: 69 },
  { id: "s5", date: "2026-04-26", duration: "1h 3m", toolCalls: 128, tokensSaved: 34_600, efficiency: 71 },
  { id: "s6", date: "2026-04-25", duration: "35m", toolCalls: 71, tokensSaved: 18_900, efficiency: 64 },
];

const CHART_DATA = MOCK_SESSIONS.map((s) => ({
  date: s.date.slice(5),
  tokens: Math.round(s.tokensSaved / 1000),
})).reverse();

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function SessionsPage() {
  const totalSaved = MOCK_SESSIONS.reduce((sum, s) => sum + s.tokensSaved, 0);
  const avgEfficiency = Math.round(
    MOCK_SESSIONS.reduce((sum, s) => sum + s.efficiency, 0) / MOCK_SESSIONS.length,
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Session History</h1>
        <p className="text-sm text-muted-foreground">Token savings and tool usage across sessions</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2"><CardDescription>Total Tokens Saved</CardDescription></CardHeader>
          <CardContent><div className="text-2xl font-bold text-emerald-400">{formatTokens(totalSaved)}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>Sessions</CardDescription></CardHeader>
          <CardContent><div className="text-2xl font-bold">{MOCK_SESSIONS.length}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>Avg Efficiency</CardDescription></CardHeader>
          <CardContent><div className="text-2xl font-bold">{avgEfficiency}%</div></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Tokens Saved Over Time</CardTitle>
          <CardDescription>Thousands of tokens saved per session</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={CHART_DATA}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis dataKey="date" stroke="#71717a" fontSize={12} />
                <YAxis stroke="#71717a" fontSize={12} unit="K" />
                <Tooltip
                  contentStyle={{ background: "#18181b", border: "1px solid #27272a", borderRadius: "8px" }}
                  labelStyle={{ color: "#a1a1aa" }}
                  itemStyle={{ color: "#3b82f6" }}
                />
                <Line type="monotone" dataKey="tokens" stroke="#3b82f6" strokeWidth={2} dot={{ r: 4, fill: "#3b82f6" }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent Sessions</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Tool Calls</TableHead>
                <TableHead>Tokens Saved</TableHead>
                <TableHead>Efficiency</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {MOCK_SESSIONS.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>{s.date}</TableCell>
                  <TableCell>{s.duration}</TableCell>
                  <TableCell>{s.toolCalls}</TableCell>
                  <TableCell className="font-mono">{formatTokens(s.tokensSaved)}</TableCell>
                  <TableCell>
                    <Badge variant={s.efficiency >= 70 ? "success" : s.efficiency >= 60 ? "warning" : "secondary"}>
                      {s.efficiency}%
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
