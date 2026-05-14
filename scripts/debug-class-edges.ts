/**
 * Diagnostic script: why are class_edges empty?
 * Traces the full join chain that the class_edges materialization query requires.
 * Run with: pnpm exec tsx scripts/debug-class-edges.ts
 */

async function main() {
  const { CozoDb } = await import("cozo-node");
  const db = new CozoDb("sqlite", ".unerr/graph.db");

  async function q(query: string, params: Record<string, unknown> = {}): Promise<{ rows: unknown[][] }> {
    return db.run(query, params);
  }

  console.log("=== CLASS EDGES DIAGNOSTIC ===\n");

  // ── Step 1: All class entities and their containment edges ──
  console.log("── STEP 1: Class entities and their containment edges ──");

  const classes = await q(`
    ?[key, name, file_path] := *entities{key, name, kind: "class", file_path}
    :order name
  `);
  console.log(`Total class entities: ${classes.rows.length}`);

  for (const [key, name, fp] of classes.rows) {
    const contained = await q(`
      ?[child_key, child_name, child_kind] :=
        *edges{from_key: $cls, to_key: child_key, type: "contains"},
        *entities{key: child_key, name: child_name, kind: child_kind}
    `, { cls: key });
    console.log(`\n  Class: ${name} (${fp})`);
    console.log(`    key: ${key}`);
    console.log(`    contains ${contained.rows.length} members:`);
    for (const [ck, cn, ckind] of contained.rows.slice(0, 10)) {
      console.log(`      ${ckind} "${cn}" → ${ck}`);
    }
    if (contained.rows.length > 10) console.log(`      ... and ${contained.rows.length - 10} more`);
  }

  // ── Step 2: Containment edge direction check ──
  console.log("\n── STEP 2: Containment edge direction check ──");
  console.log("  The query expects: class --contains--> method (from_key=class, to_key=method)");

  const containsFromClass = await q(`
    ?[count(from_key)] :=
      *edges{from_key, to_key, type: "contains"},
      *entities{key: from_key, kind: "class"}
  `);
  console.log(`  Edges where from_key is a class (class→child): ${containsFromClass.rows[0]?.[0]}`);

  const containsToClass = await q(`
    ?[count(to_key)] :=
      *edges{from_key, to_key, type: "contains"},
      *entities{key: to_key, kind: "class"}
  `);
  console.log(`  Edges where to_key is a class (parent→class): ${containsToClass.rows[0]?.[0]}`);

  // Check if containment is reversed (method→class instead of class→method)
  const reverseContains = await q(`
    ?[count(from_key)] :=
      *edges{from_key, to_key, type: "contains"},
      *entities{key: from_key, kind: "method"},
      *entities{key: to_key, kind: "class"}
  `);
  console.log(`  REVERSED? method→class contains edges: ${reverseContains.rows[0]?.[0]}`);

  // ── Step 3: For each class, what do its methods call? ──
  console.log("\n── STEP 3: Outgoing call edges from class-contained methods ──");

  const methodCalls = await q(`
    ?[class_name, method_name, called_key, call_count] :=
      *edges{from_key: cls, to_key: method_key, type: "contains"},
      *entities{key: cls, kind: "class", name: class_name},
      *entities{key: method_key, name: method_name},
      *edges{from_key: method_key, to_key: called_key, type: "calls"},
      call_count = 1
    :order class_name, method_name
    :limit 30
  `);
  console.log(`  Methods in classes with outgoing "calls" edges (first 30):`);
  if (methodCalls.rows.length === 0) {
    console.log("  *** NONE! This is likely the problem. ***");

    // Dig deeper: do methods have ANY outgoing edges?
    const methodAnyOutgoing = await q(`
      ?[method_name, edge_type, count(to_key)] :=
        *edges{from_key: cls, to_key: method_key, type: "contains"},
        *entities{key: cls, kind: "class"},
        *entities{key: method_key, name: method_name},
        *edges{from_key: method_key, to_key, type: edge_type},
        edge_type != "contains"
    `);
    console.log(`\n  Methods in classes with ANY outgoing edges (non-contains):`);
    for (const row of methodAnyOutgoing.rows.slice(0, 20)) {
      console.log(`    ${row[0]} → ${row[1]} (${row[2]})`);
    }
    if (methodAnyOutgoing.rows.length === 0) {
      console.log("    *** NONE! Methods in classes have zero outgoing edges. ***");
    }
  } else {
    for (const [cn, mn, ck, _] of methodCalls.rows) {
      console.log(`    ${cn}.${mn} → calls → ${ck}`);
    }
  }

  // ── Step 4: Are called targets contained by any class? ──
  console.log("\n── STEP 4: Are called targets contained by other classes? ──");

  const calledFromClassMethods = await q(`
    ?[called_key] :=
      *edges{from_key: cls, to_key: method_key, type: "contains"},
      *entities{key: cls, kind: "class"},
      *edges{from_key: method_key, to_key: called_key, type: "calls"}
  `);
  console.log(`  Unique targets called by class methods: ${calledFromClassMethods.rows.length}`);

  if (calledFromClassMethods.rows.length > 0) {
    const calledAndContained = await q(`
      ?[called_key, containing_class_name] :=
        *edges{from_key: cls, to_key: method_key, type: "contains"},
        *entities{key: cls, kind: "class"},
        *edges{from_key: method_key, to_key: called_key, type: "calls"},
        *edges{from_key: tc, to_key: called_key, type: "contains"},
        *entities{key: tc, kind: "class", name: containing_class_name}
      :limit 20
    `);
    console.log(`  Called targets that ARE contained by a class: ${calledAndContained.rows.length}`);
    for (const [ck, cn] of calledAndContained.rows.slice(0, 10)) {
      console.log(`    ${ck} ∈ class ${cn}`);
    }
  }

  // ── Step 5: Check call edges globally ──
  console.log("\n── STEP 5: Global edge sanity check ──");

  const callEdges = await q(`?[count(from_key)] := *edges{from_key, to_key, type: "calls"}`);
  console.log(`  Total "calls" edges: ${callEdges.rows[0]?.[0]}`);

  const callsFromMethods = await q(`
    ?[count(from_key)] :=
      *edges{from_key, to_key, type: "calls"},
      *entities{key: from_key, kind: "method"}
  `);
  console.log(`  "calls" edges where from_key is a method: ${callsFromMethods.rows[0]?.[0]}`);

  const callsFromFunctions = await q(`
    ?[count(from_key)] :=
      *edges{from_key, to_key, type: "calls"},
      *entities{key: from_key, kind: "function"}
  `);
  console.log(`  "calls" edges where from_key is a function: ${callsFromFunctions.rows[0]?.[0]}`);

  // What kinds of entities are calling?
  const callerKinds = await q(`
    ?[kind, count(from_key)] :=
      *edges{from_key, to_key, type: "calls"},
      *entities{key: from_key, kind}
  `);
  console.log(`  Caller entity kinds for "calls" edges:`);
  for (const [kind, cnt] of callerKinds.rows) {
    console.log(`    ${kind}: ${cnt}`);
  }

  // What kinds of entities are being called?
  const calleeKinds = await q(`
    ?[kind, count(to_key)] :=
      *edges{from_key, to_key, type: "calls"},
      *entities{key: to_key, kind}
  `);
  console.log(`  Callee entity kinds for "calls" edges:`);
  for (const [kind, cnt] of calleeKinds.rows) {
    console.log(`    ${kind}: ${cnt}`);
  }

  // ── Step 6: Are callers of "calls" edges contained by classes? ──
  console.log("\n── STEP 6: Are callers of 'calls' edges contained by classes? ──");

  const callersContainedByClass = await q(`
    ?[count(caller)] :=
      *edges{from_key: caller, to_key, type: "calls"},
      *edges{from_key: cls, to_key: caller, type: "contains"},
      *entities{key: cls, kind: "class"}
  `);
  console.log(`  Callers that are contained by a class: ${callersContainedByClass.rows[0]?.[0]}`);

  const calleesContainedByClass = await q(`
    ?[count(callee)] :=
      *edges{from_key, to_key: callee, type: "calls"},
      *edges{from_key: cls, to_key: callee, type: "contains"},
      *entities{key: cls, kind: "class"}
  `);
  console.log(`  Callees that are contained by a class: ${calleesContainedByClass.rows[0]?.[0]}`);

  // ── Step 7: Sample some class members and check their edges ──
  console.log("\n── STEP 7: Sample class members and their edge connectivity ──");

  const sampleMembers = await q(`
    ?[class_name, member_key, member_name, member_kind] :=
      *edges{from_key: cls, to_key: member_key, type: "contains"},
      *entities{key: cls, kind: "class", name: class_name},
      *entities{key: member_key, name: member_name, kind: member_kind}
    :limit 10
  `);

  for (const [cn, mk, mn, mkind] of sampleMembers.rows) {
    const outgoing = await q(`
      ?[type, to_key] := *edges{from_key: $mk, to_key, type}, type != "contains"
    `, { mk });
    const incoming = await q(`
      ?[type, from_key] := *edges{from_key, to_key: $mk, type}, type != "contains"
    `, { mk });
    console.log(`  ${cn}.${mn} (${mkind}) key=${mk}`);
    console.log(`    outgoing (non-contains): ${outgoing.rows.length}`);
    for (const [t, tk] of outgoing.rows.slice(0, 5)) {
      console.log(`      → ${t} → ${tk}`);
    }
    console.log(`    incoming (non-contains): ${incoming.rows.length}`);
    for (const [t, fk] of incoming.rows.slice(0, 5)) {
      console.log(`      ← ${t} ← ${fk}`);
    }
  }

  // ── Step 8: Try the exact materialization query ──
  console.log("\n── STEP 8: Run the exact materialization query ──");
  try {
    const result = await q(`
      ?[from_class, to_class, edge_type, count(from_key)] :=
        *edges{from_key, to_key, type: edge_type},
        edge_type != "contains",
        *edges{from_key: fc, to_key: from_key, type: "contains"},
        *entities{key: fc, kind: "class"},
        *edges{from_key: tc, to_key: to_key, type: "contains"},
        *entities{key: tc, kind: "class"},
        from_class = fc, to_class = tc,
        from_class != to_class
    `);
    console.log(`  Result rows: ${result.rows.length}`);
    for (const row of result.rows.slice(0, 20)) {
      console.log(`    ${row[0]} → ${row[1]} (${row[2]}, weight=${row[3]})`);
    }
  } catch (err) {
    console.log(`  Query failed: ${err instanceof Error ? err.message : err}`);
  }

  console.log("\n=== DIAGNOSTIC COMPLETE ===");
}

main().catch(console.error);
