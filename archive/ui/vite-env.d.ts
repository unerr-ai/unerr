/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly UNERR_DASHBOARD_PORT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
