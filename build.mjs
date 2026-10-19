// Same options as plugins/build-plugin.mjs (host shares react and @tauri-apps/api).
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["index.tsx"],
  outfile: "dist/index.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  sourcemap: true,
  external: ["react", "react-dom", "react-dom/*", "react/*", "@tauri-apps/api/*"],
  logLevel: "info",
});
