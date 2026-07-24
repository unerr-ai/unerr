/**
 * Resolves the CozoDb constructor, choosing the load path by build kind. A
 * normal Node build dynamically imports the `cozo-node` package (its
 * node-pre-gyp loader finds the prebuilt addon on disk). A compiled Bun binary
 * cannot use that package — node-pre-gyp's index statically `require`s
 * install-only AWS deps that break Bun's bundler — so we bypass it: the addon
 * is embedded directly (`embedded-natives.cozoNative`) and we re-wrap the raw
 * N-API binding with a class identical to cozo-node's own `index.js`.
 *
 */

// Build-time flag injected by tsup (`false`) and by `script/build-binary.ts`
// (`true`). Declared loosely so an un-defined runtime (tsx dev, uncompiled
// `bun run`) is treated as a Node build via the `typeof` guard below.
declare const __UNERR_BINARY__: boolean;

import type { CozoDb } from "./cozo-schema.js";

type CozoDbCtor = new (
  engine?: string,
  path?: string,
  options?: object
) => CozoDb;

/**
 * Returns the CozoDb constructor for the current build. Embedded addon in a
 * compiled binary; the `cozo-node` package otherwise.
 */
export async function getCozoDbCtor(): Promise<CozoDbCtor> {
  if (typeof __UNERR_BINARY__ !== "undefined" && __UNERR_BINARY__) {
    const { cozoNative } = await import("./embedded-natives.js");
    return makeCozoDbClass(cozoNative);
  }
  const mod = (await import("cozo-node")) as {
    default?: { CozoDb: CozoDbCtor };
    CozoDb?: CozoDbCtor;
  };
  const Ctor = mod.default ? mod.default.CozoDb : mod.CozoDb;
  if (!Ctor) throw new Error("cozo-node loaded but exposes no CozoDb export");
  return Ctor;
}

/**
 * Rebuilds cozo-node's `CozoDb` / `CozoTx` JS wrapper over an embedded N-API
 * binding. A line-for-line port of `cozo-node@0.7.6/index.js` (which is pure JS
 * over the same `native.*` calls) so the compiled binary behaves identically to
 * the package — only the addon-resolution step differs.
 *
 */
function makeCozoDbClass(native: any): CozoDbCtor {
  class CozoTx {
    tx_id: number;
    constructor(id: number) {
      this.tx_id = id;
    }
    run(script: string, params?: object): Promise<any> {
      return new Promise((resolve, reject) => {
        native.query_tx(
          this.tx_id,
          script,
          params || {},
          (err: any, result: any) => {
            if (err) reject(JSON.parse(err));
            else resolve(result);
          }
        );
      });
    }
    abort() {
      return native.abort_tx(this.tx_id);
    }
    commit() {
      return native.commit_tx(this.tx_id);
    }
  }

  class CozoDb {
    db_id: number;
    constructor(engine?: string, path?: string, options?: object) {
      this.db_id = native.open_db(
        engine || "mem",
        path || "data.db",
        JSON.stringify(options || {})
      );
    }
    close() {
      native.close_db(this.db_id);
    }
    multiTransact(write?: boolean) {
      return new CozoTx(native.multi_transact(this.db_id, !!write));
    }
    run(script: string, params?: object, immutable?: boolean): Promise<any> {
      return new Promise((resolve, reject) => {
        native.query_db(
          this.db_id,
          script,
          params || {},
          (err: any, result: any) => {
            if (err) reject(JSON.parse(err));
            else resolve(result);
          },
          !!immutable
        );
      });
    }
    exportRelations(relations: any, as_objects?: boolean): Promise<any> {
      // cozo-node@0.7.6 passes `relations` to the addon raw and ignores
      // as_objects; the kept parameter just mirrors the package signature.
      void as_objects;
      return new Promise((resolve, reject) => {
        native.export_relations(
          this.db_id,
          relations,
          (err: any, data: any) => {
            if (err) reject(JSON.parse(err));
            else resolve(data);
          }
        );
      });
    }
    importRelations(data: any): Promise<void> {
      return new Promise((resolve, reject) => {
        native.import_relations(this.db_id, data, (err: any) => {
          if (err) reject(JSON.parse(err));
          else resolve();
        });
      });
    }
    importRelationsFromBackup(path: string, relations: any): Promise<void> {
      return new Promise((resolve, reject) => {
        native.import_from_backup(this.db_id, path, relations, (err: any) => {
          if (err) reject(JSON.parse(err));
          else resolve();
        });
      });
    }
    backup(path: string): Promise<void> {
      return new Promise((resolve, reject) => {
        native.backup_db(this.db_id, path, (err: any) => {
          if (err) reject(JSON.parse(err));
          else resolve();
        });
      });
    }
    restore(path: string): Promise<void> {
      return new Promise((resolve, reject) => {
        native.restore_db(this.db_id, path, (err: any) => {
          if (err) reject(JSON.parse(err));
          else resolve();
        });
      });
    }
    registerCallback(relation: string, cb: any, capacity = -1) {
      return native.register_callback(this.db_id, relation, cb, capacity);
    }
    unregisterCallback(cb_id: number) {
      return native.unregister_callback(this.db_id, cb_id);
    }
    registerNamedRule(name: string, arity: number, cb: any) {
      return native.register_named_rule(
        this.db_id,
        name,
        arity,
        async (ret_id: number, inputs: any, options: any) => {
          let ret: any;
          try {
            ret = await cb(inputs, options);
          } catch (e) {
            native.respond_to_named_rule_invocation(ret_id, `${e}`);
            return;
          }
          try {
            native.respond_to_named_rule_invocation(ret_id, ret);
          } catch {
            /* swallow — matches cozo-node */
          }
        }
      );
    }
    unregisterNamedRule(name: string) {
      return native.unregister_named_rule(this.db_id, name);
    }
  }

  return CozoDb as unknown as CozoDbCtor;
}
