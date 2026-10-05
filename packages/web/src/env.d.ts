/// <reference types="vite/client" />

/** Build-time environment variables the web app reads. */
interface ImportMetaEnv {
  /** `1` to use the dev fake feed instead of `/ws/ui` (dev builds only). */
  readonly VITE_ORCHVIS_FAKE?: string;
}
