// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import type { ConfigEnv } from "vite";
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// `vite build --mode demo` is the public demo (see src/lib/demo.ts): no backend
// and no server rendering, so it ships as a static SPA instead of a Worker.
export default (env: ConfigEnv) =>
  defineConfig(
    env.mode === "demo"
      ? { cloudflare: false, tanstackStart: { spa: { enabled: true } } }
      : {},
  )(env);
