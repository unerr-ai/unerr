/**
 * R4 — Cloud parsers (AWS, kubectl, docker).
 *
 * Cloud CLI output is JSON-heavy and noise-heavy: timestamps, RequestIds,
 * ETags, ARN suffixes, paging tokens. A coding agent rarely needs any of
 * those; it needs the shape (count, IDs, statuses).
 *
 * This module specializes common AWS / kubectl / docker outputs and emits
 * compact summaries. It's invoked from shell-compressor for matching
 * commands BEFORE the generic `structured` / `tabular` strategies.
 *
 * Each parser is conservative: if shape doesn't match, returns null and the
 * caller falls back to the generic strategy.
 */

interface JsonObj {
  [key: string]: unknown;
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function compactArn(arn: string): string {
  // arn:aws:iam::123456789012:role/MyRole → arn:…:role/MyRole
  return arn.replace(/^arn:[^:]*:[^:]*:[^:]*:[^:]*:/, "arn:…:");
}

function fmtCount(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}

// ─── aws ec2 describe-instances ────────────────────────────────────────────

function parseAwsEc2(raw: string): string | null {
  const data = tryParseJson(raw) as JsonObj | null;
  if (!data || !Array.isArray(data.Reservations)) return null;
  const rows: string[] = [];
  let count = 0;
  for (const r of data.Reservations as JsonObj[]) {
    const instances = (r.Instances as JsonObj[] | undefined) ?? [];
    for (const inst of instances) {
      count++;
      const id = inst.InstanceId ?? "?";
      const state =
        ((inst.State as JsonObj | undefined)?.Name as string | undefined) ??
        "?";
      const type = inst.InstanceType ?? "?";
      const ip = inst.PrivateIpAddress ?? "—";
      const az =
        ((inst.Placement as JsonObj | undefined)?.AvailabilityZone as
          | string
          | undefined) ?? "?";
      const tags = (inst.Tags as JsonObj[] | undefined) ?? [];
      const name = tags.find((t) => t.Key === "Name")?.Value ?? "";
      rows.push(
        `${id}  ${state.padEnd(10)} ${type.toString().padEnd(12)} ${ip.toString().padEnd(15)} ${az}  ${name}`
      );
    }
  }
  if (count === 0) return "0 instances";
  return `${fmtCount(count, "instance")}\nid                   state      type         ip              az  name\n${rows.join("\n")}`;
}

// ─── aws s3 ls (bucket listing) ────────────────────────────────────────────

function parseAwsS3Ls(raw: string): string | null {
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return null;
  // s3 ls bucket listing: "2024-01-15 10:23:45         1234 file.txt"
  // bucket listing:       "2024-01-15 10:23:45 my-bucket"
  let files = 0;
  let bytes = 0;
  const samples: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*\S+\s+\S+\s+(\d+)\s+(.+)$/);
    if (m?.[1] && m[2]) {
      files++;
      bytes += Number.parseInt(m[1], 10);
      if (samples.length < 5) samples.push(m[2]);
    } else if (/^\s*\S+\s+\S+\s+\S+$/.test(line)) {
      // bucket listing — not the size form
      files++;
      if (samples.length < 5)
        samples.push(line.trim().split(/\s+/).pop() ?? "");
    }
  }
  if (files === 0) return null;
  const sizeStr =
    bytes > 1024 * 1024 * 1024
      ? `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
      : bytes > 1024 * 1024
        ? `${(bytes / 1024 / 1024).toFixed(2)} MB`
        : `${(bytes / 1024).toFixed(1)} KB`;
  return `${fmtCount(files, "object")}${bytes > 0 ? `, ${sizeStr}` : ""}\nsamples: ${samples.join(", ")}`;
}

// ─── aws iam list-users / list-roles ───────────────────────────────────────

function parseAwsIam(raw: string): string | null {
  const data = tryParseJson(raw) as JsonObj | null;
  if (!data) return null;
  for (const key of ["Users", "Roles", "Policies", "Groups"]) {
    const arr = data[key];
    if (Array.isArray(arr)) {
      const rows = arr.slice(0, 25).map((item: JsonObj) => {
        const name =
          item[`${key.slice(0, -1)}Name`] ??
          item.Name ??
          item.PolicyName ??
          "?";
        const arn = item.Arn ?? item[`${key.slice(0, -1)}Arn`] ?? "";
        return `${name}  ${typeof arn === "string" ? compactArn(arn) : ""}`;
      });
      const more = arr.length > 25 ? `\n… ${arr.length - 25} more` : "";
      return `${fmtCount(arr.length, key.slice(0, -1).toLowerCase())}\n${rows.join("\n")}${more}`;
    }
  }
  return null;
}

// ─── aws lambda list-functions / invoke ────────────────────────────────────

function parseAwsLambda(raw: string): string | null {
  const data = tryParseJson(raw) as JsonObj | null;
  if (!data) return null;
  if (Array.isArray(data.Functions)) {
    const fns = data.Functions as JsonObj[];
    const rows = fns
      .slice(0, 20)
      .map((f) => `${f.FunctionName}  ${f.Runtime}  ${f.LastModified ?? ""}`);
    const more = fns.length > 20 ? `\n… ${fns.length - 20} more` : "";
    return `${fmtCount(fns.length, "function")}\n${rows.join("\n")}${more}`;
  }
  if (data.StatusCode !== undefined) {
    return `status=${data.StatusCode}${data.FunctionError ? ` error=${data.FunctionError}` : " ok"}`;
  }
  return null;
}

// ─── aws cloudformation describe-stacks ────────────────────────────────────

function parseAwsCfn(raw: string): string | null {
  const data = tryParseJson(raw) as JsonObj | null;
  if (!data || !Array.isArray(data.Stacks)) return null;
  const stacks = data.Stacks as JsonObj[];
  const rows = stacks.map(
    (s) =>
      `${s.StackName}  ${s.StackStatus}  ${s.LastUpdatedTime ?? s.CreationTime ?? ""}`
  );
  return `${fmtCount(stacks.length, "stack")}\n${rows.join("\n")}`;
}

// ─── kubectl get / describe / logs ─────────────────────────────────────────

function parseKubectlGet(raw: string, command: string): string | null {
  // JSON form
  const data = tryParseJson(raw) as JsonObj | null;
  if (data && Array.isArray(data.items)) {
    const items = data.items as JsonObj[];
    const kind = (data.kind as string) ?? "items";
    const rows = items.slice(0, 30).map((it) => {
      const meta = (it.metadata as JsonObj | undefined) ?? {};
      const status = (it.status as JsonObj | undefined) ?? {};
      return `${meta.namespace ?? "—"}/${meta.name}  ${(status.phase ?? status.conditions) ? "ok" : "?"}`;
    });
    const more = items.length > 30 ? `\n… ${items.length - 30} more` : "";
    return `${fmtCount(items.length, "resource")} (${kind})\n${rows.join("\n")}${more}`;
  }
  // Table form (default kubectl output)
  const lines = raw.split("\n").filter((l) => l.trim());
  const header = lines[0];
  if (header && /^\s*NAME\b/i.test(header)) {
    const dataLines = lines.slice(1);
    if (dataLines.length > 40) {
      void command;
      return `${fmtCount(dataLines.length, "row")}\n${header}\n${dataLines.slice(0, 30).join("\n")}\n… ${dataLines.length - 30} more`;
    }
  }
  return null;
}

function parseKubectlDescribe(raw: string): string | null {
  // describe is a nested K:V mash. Strip Events: section (verbose) and managed-fields.
  if (!/^\s*(Name:|Namespace:|Kind:)/m.test(raw)) return null;
  const stripped = raw
    .replace(/^Events:[\s\S]*$/m, "Events: (suppressed)")
    .replace(/^\s+manager:.+$/gm, "")
    .replace(/^\s+managedFields:[\s\S]*?(?=^\S)/gm, "")
    .replace(/^\s+resourceVersion:.+$/gm, "")
    .replace(/^\s+uid:.+$/gm, "")
    .replace(/^\s+creationTimestamp:.+$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
  return stripped.trim();
}

// ─── docker inspect / ps ───────────────────────────────────────────────────

function parseDockerInspect(raw: string): string | null {
  const data = tryParseJson(raw);
  if (!Array.isArray(data) || data.length === 0) return null;
  const rows = (data as JsonObj[]).map((c) => {
    const id =
      typeof c.Id === "string"
        ? c.Id.slice(0, 12)
        : ((c.Id as string | undefined) ?? "?");
    const state = (c.State as JsonObj | undefined) ?? {};
    const cfg = (c.Config as JsonObj | undefined) ?? {};
    return `${id}  ${state.Status ?? "?"}  ${cfg.Image ?? "?"}  ${c.Name ?? ""}`;
  });
  return `${fmtCount(rows.length, "container")}\n${rows.join("\n")}`;
}

// ─── dispatch ───────────────────────────────────────────────────────────────

export function tryCompressCloud(raw: string, command: string): string | null {
  const cmd = command.trim();
  if (cmd.startsWith("aws ec2")) return parseAwsEc2(raw);
  if (cmd.startsWith("aws s3")) return parseAwsS3Ls(raw);
  if (cmd.startsWith("aws iam")) return parseAwsIam(raw);
  if (cmd.startsWith("aws lambda")) return parseAwsLambda(raw);
  if (cmd.startsWith("aws cloudformation")) return parseAwsCfn(raw);
  if (/^kubectl\s+get\b/.test(cmd)) return parseKubectlGet(raw, cmd);
  if (/^kubectl\s+describe\b/.test(cmd)) return parseKubectlDescribe(raw);
  if (/^docker\s+inspect\b/.test(cmd)) return parseDockerInspect(raw);
  return null;
}
