/**
 * Verification script for multi-level graph structure.
 * Uses sqlite engine to open a copy of the rocksdb snapshot.
 * Run with: pnpm exec tsx scripts/verify-graph.ts
 */

async function main() {
  const { CozoDb } = await import("cozo-node");

  // Open as mem engine, import from rocksdb backup
  // Actually, rocksdb can't be opened concurrently. Instead,
  // we use the sqlite engine on a backup.
  // Simplest: just open rocksdb directly since unerr isn't running
  const db = new CozoDb("sqlite", ".unerr/graph.db");

  async function q(query: string): Promise<{ rows: unknown[][] }> {
    return db.run(query, {});
  }

  console.log("=== MULTI-LEVEL GRAPH VERIFICATION ===\n");

  // ── L0: Raw entities and edges ──
  const entities = await q("?[count(key)] := *entities{key}");
  console.log(`L0 entities: ${entities.rows[0]?.[0]}`);

  const entityKinds = await q("?[kind, count(key)] := *entities{key, kind}");
  console.log("  By kind:", entityKinds.rows.map(r => `${r[0]}(${r[1]})`).join(", "));

  const edgeCounts = await q("?[type, count(from_key)] := *edges{from_key, to_key, type}");
  console.log(`\nL0 edges by type:`);
  let totalEdges = 0;
  for (const row of edgeCounts.rows) {
    console.log(`  ${row[0]}: ${row[1]}`);
    totalEdges += row[1] as number;
  }
  console.log(`  TOTAL: ${totalEdges}`);

  // ── Cross-layer: containment edges ──
  console.log("\n=== CROSS-LAYER: CONTAINMENT EDGES ===");

  const moduleContains = await q(`
    ?[count(from_key)] :=
      *edges{from_key, to_key, type: "contains"},
      *entities{key: from_key, kind: "module"}
  `);
  console.log(`Module→entity containment: ${moduleContains.rows[0]?.[0]}`);

  const classContains = await q(`
    ?[count(from_key)] :=
      *edges{from_key, to_key, type: "contains"},
      *entities{key: from_key, kind: "class"}
  `);
  console.log(`Class→method containment: ${classContains.rows[0]?.[0]}`);

  if ((classContains.rows[0]?.[0] as number) > 0) {
    const examples = await q(`
      ?[class_name, method_name, method_kind] :=
        *edges{from_key, to_key, type: "contains"},
        *entities{key: from_key, kind: "class", name: class_name},
        *entities{key: to_key, name: method_name, kind: method_kind}
      :limit 15
    `);
    console.log("  Examples:");
    for (const row of examples.rows) {
      console.log(`    ${row[0]}.${row[1]} (${row[2]})`);
    }
  } else {
    console.log("  ⚠ NO class→method containment edges found!");
    // Check: how many entities have parent_class set? (via the entity data)
    const classes = await q("?[key, name, file_path] := *entities{key, name, kind: \"class\", file_path} :limit 10");
    console.log(`  Classes in DB: ${classes.rows.length}`);
    for (const row of classes.rows.slice(0, 5)) {
      console.log(`    ${row[1]} @ ${row[2]}`);
    }
    // Check methods
    const methods = await q("?[key, name, file_path] := *entities{key, name, kind: \"method\", file_path} :limit 10");
    console.log(`  Methods in DB: ${methods.rows.length}`);
    for (const row of methods.rows.slice(0, 5)) {
      console.log(`    ${row[1]} @ ${row[2]}`);
      // Check if this method's key includes a class name hint
    }
  }

  // ── L1: Materialized file edges ──
  console.log("\n=== L1: MATERIALIZED FILE EDGES ===");
  const fileEdgesByType = await q("?[edge_type, count(from_file)] := *file_edges{from_file, to_file, edge_type}");
  let totalFileEdges = 0;
  for (const row of fileEdgesByType.rows) {
    console.log(`  ${row[0]}: ${row[1]}`);
    totalFileEdges += row[1] as number;
  }
  console.log(`  TOTAL: ${totalFileEdges}`);

  const heavyPairs = await q(`
    ?[from_file, to_file, weight] :=
      *file_edges{from_file, to_file, edge_type: "calls", weight}
    :order -weight
    :limit 10
  `);
  console.log("\n  Heaviest call edges:");
  for (const row of heavyPairs.rows) {
    console.log(`    ${row[0]} → ${row[1]} (weight: ${row[2]})`);
  }

  // ── L1: Class edges ──
  console.log("\n=== L1: MATERIALIZED CLASS EDGES ===");
  const classEdges = await q("?[count(from_class)] := *class_edges{from_class, to_class}");
  console.log(`Total class edges: ${classEdges.rows[0]?.[0]}`);

  // ── File Communities ──
  console.log("\n=== FILE COMMUNITIES ===");
  const fileCommunities = await q("?[community, label, count(file_path)] := *file_communities{file_path, community, label}");
  console.log(`Macro-communities: ${fileCommunities.rows.length}`);

  const sorted = fileCommunities.rows.sort((a: unknown[], b: unknown[]) => (b[2] as number) - (a[2] as number));
  for (const row of sorted) {
    console.log(`  Community ${row[0]} "${row[1]}": ${row[2]} files`);
  }

  // Show files in top 5 communities
  for (const row of sorted.slice(0, 5)) {
    const cid = row[0];
    const files = await q(`
      ?[file_path] := *file_communities{file_path, community: ${cid}}
      :order file_path
    `);
    console.log(`\n  Community ${cid} "${row[1]}" (${files.rows.length} files):`);
    for (const f of files.rows) {
      console.log(`    ${f[0]}`);
    }
  }

  // ── Intra-community edges ──
  console.log("\n=== INTRA-COMMUNITY FILE EDGES ===");
  const intraCom = await q(`
    ?[community, label, count(from_file)] :=
      *file_edges{from_file, to_file, edge_type},
      *file_communities{file_path: from_file, community, label},
      *file_communities{file_path: to_file, community: comm2},
      community = comm2
  `);
  let totalIntra = 0;
  for (const row of intraCom.rows.sort((a: unknown[], b: unknown[]) => (b[2] as number) - (a[2] as number))) {
    console.log(`  Community ${row[0]} "${row[1]}": ${row[2]} intra-community edges`);
    totalIntra += row[2] as number;
  }
  console.log(`  TOTAL intra: ${totalIntra} / ${totalFileEdges} (${totalFileEdges > 0 ? Math.round(totalIntra / totalFileEdges * 100) : 0}%)`);

  const interCom = await q(`
    ?[from_comm, to_comm, count(from_file)] :=
      *file_edges{from_file, to_file},
      *file_communities{file_path: from_file, community: from_comm},
      *file_communities{file_path: to_file, community: to_comm},
      from_comm != to_comm
    :order -count(from_file)
    :limit 10
  `);
  console.log("\n  Top inter-community edges:");
  for (const row of interCom.rows) {
    console.log(`  Community ${row[0]} ↔ ${row[1]}: ${row[2]} edges`);
  }

  // ── Hierarchical consistency ──
  console.log("\n=== HIERARCHICAL COMMUNITY CONSISTENCY ===");
  const entityComms = await q("?[key, community, file_path] := *entities{key, community, file_path}");
  const fcResult = await q("?[file_path, community] := *file_communities{file_path, community}");
  const fileCommMap = new Map<string, number>();
  for (const row of fcResult.rows) {
    fileCommMap.set(row[0] as string, row[1] as number);
  }

  let consistent = 0, inconsistent = 0, noFileCommunity = 0;
  for (const row of entityComms.rows) {
    const entityCommunity = row[1] as number;
    const filePath = row[2] as string;
    const macroFromEntity = Math.floor(entityCommunity / 1000);
    const fileMacroCommunity = fileCommMap.get(filePath);
    if (fileMacroCommunity === undefined) { noFileCommunity++; }
    else if (macroFromEntity === fileMacroCommunity) { consistent++; }
    else {
      inconsistent++;
      if (inconsistent <= 5) console.log(`  MISMATCH: entity macro=${macroFromEntity}, file=${fileMacroCommunity}, path=${filePath}`);
    }
  }
  console.log(`Consistent: ${consistent}, Inconsistent: ${inconsistent}, No file community: ${noFileCommunity}`);

  // Sub-communities per macro
  const subCommsByMacro = new Map<number, Set<number>>();
  for (const row of entityComms.rows) {
    const cid = row[1] as number;
    const macro = Math.floor(cid / 1000);
    const local = cid % 1000;
    if (!subCommsByMacro.has(macro)) subCommsByMacro.set(macro, new Set());
    subCommsByMacro.get(macro)!.add(local);
  }
  console.log("\nSub-communities per macro:");
  for (const [macro, subs] of [...subCommsByMacro.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  Macro ${macro}: ${subs.size} sub-communities`);
  }

  // ── Isolated files ──
  console.log("\n=== FILE ISOLATION ===");
  const allEntityFiles = await q("?[file_path] := *entities{file_path}");
  const allFP = new Set(allEntityFiles.rows.map(r => r[0] as string));
  const filesWithEdges = await q("?[fp] := *file_edges{from_file: fp}\n?[fp] := *file_edges{to_file: fp}");
  const connectedFiles = new Set(filesWithEdges.rows.map(r => r[0] as string));
  let iso = 0;
  const isoExamples: string[] = [];
  for (const fp of allFP) {
    if (!connectedFiles.has(fp)) { iso++; if (isoExamples.length < 10) isoExamples.push(fp); }
  }
  console.log(`Total: ${allFP.size} files, Connected: ${connectedFiles.size}, Isolated: ${iso}`);
  if (isoExamples.length > 0) {
    console.log("  Isolated examples:", isoExamples.join(", "));
  }

  console.log("\n=== DONE ===");
}

main().catch(console.error);
