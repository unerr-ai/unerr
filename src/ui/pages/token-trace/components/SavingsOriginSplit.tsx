/**
 * SavingsOriginSplit — the differentiation centerpiece of Token Trace.
 *
 * Splits every saved token into its two origins and contrasts them so the
 * 80/20 reality is the first thing the user reads:
 *
 *   • Understanding your code (graph + graph-guided reads) — structurally
 *     unique to unerr, and on real installs the dominant tier.
 *   • Compressing output (shell / fetch / format / dedup / truncation) —
 *     the table-stakes tier every token tool already competes in.
 *
 * Category-design framing (Lochhead, Dunford; NN/g anchoring): we never
 * name a competitor. We name the *category* ("output compression") as the
 * frame of reference, then show the capability no text-only optimizer can
 * have without a code graph. Proof rides on real event counts; turns are
 * labelled estimated (`~`) because they're derived from headroom share.
 *
 * Storytelling-sequence rule (one finding per scroll): this block IS the
 * finding. KPIs, mechanism detail, and the session table are the context
 * and investigation tiers below it.
 */

import { fetchJson } from "@/lib/api";
import { useRepoApi } from "@/lib/repo-context";
import { useQuery } from "@tanstack/react-query";
import {
  type MechanismSummary,
  type MechanismTier,
  fmt,
  mc,
  mechLabel,
  splitMechanismsByTier,
} from "../shared";

interface HeadroomLite {
  data: {
    since_install?: { headroom_turns: number; total_tokens_saved: number };
  };
}

function InfoDot({ text }: { text: string }) {
  return (
    <span
      title={text}
      className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-border-subtle text-[9px] font-semibold t-tertiary cursor-help select-none"
      aria-label={text}
    >
      i
    </span>
  );
}

function MechRow({
  mech,
  data,
  tierMax,
}: {
  mech: string;
  data: MechanismSummary;
  tierMax: number;
}) {
  const colors = mc(mech);
  const w = Math.max(2, (data.tokens_saved / (tierMax || 1)) * 100);
  return (
    <div className="flex items-center gap-2.5 text-xs">
      <span
        className={`size-2 shrink-0 rounded-sm ${colors.bar}`}
        aria-hidden
      />
      <span className={`${colors.text} w-28 shrink-0 truncate font-medium`}>
        {mechLabel(mech)}
      </span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className={`h-full rounded-full ${colors.bar} opacity-80`}
          style={{ width: `${w}%` }}
        />
      </div>
      <span className="w-14 shrink-0 text-right font-mono tabular-nums t-secondary">
        {fmt(data.tokens_saved)}
      </span>
      <span className="w-9 shrink-0 text-right font-mono tabular-nums t-tertiary">
        {data.event_count}×
      </span>
    </div>
  );
}

function TierBlock({
  tier,
  pct,
  perTurn,
  primary,
  title,
  caption,
  proof,
}: {
  tier: MechanismTier;
  pct: number;
  perTurn: number;
  primary: boolean;
  title: string;
  caption: string;
  proof?: string;
}) {
  const tierMax = tier.entries[0]?.[1].tokens_saved ?? 1;
  const turns = perTurn > 0 ? tier.tokens * perTurn : 0;

  return (
    <div
      className={
        primary
          ? "rounded-lg border border-emerald-500/25 bg-emerald-500/[0.04] p-4"
          : "rounded-lg border border-border-subtle/60 p-4"
      }
    >
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h4
              className={`text-base font-semibold ${
                primary ? "text-foreground-emphasis" : "text-foreground"
              }`}
            >
              {title}
            </h4>
            {primary && (
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
                only unerr
              </span>
            )}
          </div>
          <p className="t-tertiary mt-0.5 text-xs leading-tight">{caption}</p>
        </div>
        <div className="shrink-0 text-right">
          <div
            className={`font-mono text-2xl font-bold tabular-nums ${
              primary ? "text-emerald-300" : "t-secondary"
            }`}
          >
            {pct}%
          </div>
          <div className="font-mono text-[11px] tabular-nums t-tertiary">
            {fmt(tier.tokens)} tok
            {turns > 0 ? ` · ~${fmt(turns)} turns` : ""}
          </div>
        </div>
      </div>

      {/* Headline proportion bar — both tiers scale to the same 100% track,
       *  so the dominant tier visibly towers over the table-stakes one. */}
      <div
        className={`mt-3 overflow-hidden rounded-full bg-white/[0.06] ${
          primary ? "h-3" : "h-2"
        }`}
      >
        <div
          className={`h-full rounded-full ${
            primary
              ? "bg-gradient-to-r from-violet-500 to-emerald-400"
              : "bg-zinc-500/70"
          }`}
          style={{ width: `${Math.max(2, pct)}%` }}
        />
      </div>

      {tier.entries.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {tier.entries.map(([mech, data]) => (
            <MechRow key={mech} mech={mech} data={data} tierMax={tierMax} />
          ))}
        </div>
      )}

      {proof && (
        <p className="mt-3 border-t border-border-subtle/50 pt-2 text-[11px] leading-snug t-tertiary">
          {proof}
        </p>
      )}
    </div>
  );
}

export function SavingsOriginSplit({
  byMechanism,
  totalSaved,
}: {
  byMechanism: Record<string, MechanismSummary>;
  totalSaved: number;
}) {
  const { url, queryKey } = useRepoApi();

  // Same query key as HeadroomStrip → react-query dedupes, no extra request.
  const headroomQ = useQuery({
    queryKey: queryKey(["token-flow", "headroom"]),
    queryFn: () => fetchJson<HeadroomLite>(url("/api/token-flow/headroom")),
    refetchInterval: 30_000,
  });
  const si = headroomQ.data?.data?.since_install;
  const perTurn =
    si && si.total_tokens_saved > 0
      ? si.headroom_turns / si.total_tokens_saved
      : 0;

  const { intelligence, compression, total } =
    splitMechanismsByTier(byMechanism);
  const denom = total || totalSaved || 1;
  const intelPct = Math.round((intelligence.tokens / denom) * 100);
  const compPct = Math.max(0, 100 - intelPct);

  const graphEvents = byMechanism.graph_query?.event_count ?? 0;
  const readEvents = byMechanism.file_read?.event_count ?? 0;
  const proof =
    graphEvents + readEvents > 0
      ? `Earned across ${fmt(graphEvents)} graph lookup${
          graphEvents === 1 ? "" : "s"
        } served and ${fmt(readEvents)} targeted read${
          readEvents === 1 ? "" : "s"
        } — payloads a text-only optimizer would have pulled in full.`
      : undefined;

  return (
    <div className="el-raised rounded-lg p-5">
      <div className="mb-1 flex items-center gap-1.5">
        <h3 className="t-secondary text-sm font-medium">
          Where your savings come from
        </h3>
        <InfoDot text="Every saved token is attributed to one of two origins. Understanding-your-code = graph queries and graph-guided reads (file_outline / get_entity served a slice instead of a full file). Compressing-output = trimming the bytes of tool output. The split is exhaustive: the two tiers sum to your total. Turns are estimated from each tier's share of compounded headroom." />
      </div>
      <p className="t-tertiary mb-4 max-w-2xl text-xs leading-snug">
        Trimming tool output saves tokens — every token tool does it. unerr also{" "}
        <span className="text-foreground">understands your code</span>, so it
        serves the right slice instead of raw bytes. On this install, that's
        where most of your savings come from.
      </p>

      <div className="space-y-3">
        <TierBlock
          tier={intelligence}
          pct={intelPct}
          perTurn={perTurn}
          primary
          title="Understanding your code"
          caption="graph queries + graph-guided reads — needs a live map of the repo"
          proof={proof}
        />
        <TierBlock
          tier={compression}
          pct={compPct}
          perTurn={perTurn}
          primary={false}
          title="Compressing output"
          caption="trimming tool output — table-stakes for any token tool"
        />
      </div>

      <div className="mt-4 border-t border-border-subtle pt-3">
        <p className="text-sm leading-snug t-secondary">
          <span className="font-semibold text-emerald-300">{intelPct}%</span> of
          every token unerr saves comes from{" "}
          <span className="text-foreground-emphasis">
            understanding your code
          </span>{" "}
          — work that output compression alone can't reach.
        </p>
      </div>
    </div>
  );
}
