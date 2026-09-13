import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const outDirectory = path.join(root, "web", "dist");
await mkdir(outDirectory, { recursive: true });
await build({
  entryPoints: [path.join(root, "web", "src", "main.tsx")],
  outfile: path.join(outDirectory, "widget.js"),
  bundle: true,
  minify: true,
  sourcemap: false,
  format: "iife",
  target: ["es2022"],
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "none",
});

// esbuild emits CSS beside an outfile using the entry point's basename.
const generatedCss = path.join(outDirectory, "main.css");
const desiredCss = path.join(outDirectory, "widget.css");
try {
  await rename(generatedCss, desiredCss);
} catch {
  // Current esbuild uses the outfile basename and already writes widget.css.
}

