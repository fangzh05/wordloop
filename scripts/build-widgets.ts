import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const outDirectory = path.join(root, "web", "dist");
await mkdir(outDirectory, { recursive: true });

const widgetEntries = {
  review: path.join(root, "web", "src", "entries", "review.tsx"),
  pretest: path.join(root, "web", "src", "entries", "pretest.tsx"),
  lesson: path.join(root, "web", "src", "entries", "lesson.tsx"),
  dashboard: path.join(root, "web", "src", "entries", "dashboard.tsx"),
  pronunciation: path.join(root, "web", "src", "entries", "pronunciation.tsx"),
  dictation: path.join(root, "web", "src", "entries", "dictation.tsx"),
  import: path.join(root, "web", "src", "entries", "import.tsx"),
} as const;

await rm(path.join(outDirectory, "widget.js"), { force: true });

for (const [kind, entryPoint] of Object.entries(widgetEntries)) {
  await build({
    entryPoints: [entryPoint],
    outfile: path.join(outDirectory, `${kind}.js`),
    bundle: true,
    minify: true,
    sourcemap: false,
    format: "iife",
    target: ["es2022"],
    jsx: "automatic",
    splitting: false,
    define: { "process.env.NODE_ENV": '"production"' },
    legalComments: "none",
  });
}

await build({
  entryPoints: [path.join(root, "web", "src", "styles.css")],
  outfile: path.join(outDirectory, "widget.css"),
  bundle: true,
  minify: true,
  sourcemap: false,
});

