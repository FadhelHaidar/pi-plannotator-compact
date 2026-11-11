// Minimal Vite ambient types for this package's standalone typecheck.
// The app builds through Vite, which injects these; `vite/client` cannot be
// referenced here because the isolated Bun linker does not hoist `vite`.
interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly VITE_PIERRE_VALIDATE_HEIGHTS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
