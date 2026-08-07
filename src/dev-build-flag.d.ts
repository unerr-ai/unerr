declare const __UNERR_DEV_BUILD__: boolean;
/**
 * The cloud control-plane address baked in at build time (see
 * tsup.config.ts / scripts/build-binary.ts, overridable at build time only
 * via UNERR_BUILD_API_URL). Undefined outside a built bundle (tsx dev,
 * vitest) — src/cloud/config.ts typeof-guards every read.
 */
declare const __UNERR_API_URL__: string;
