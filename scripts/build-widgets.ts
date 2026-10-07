import { mkdir, rm, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const outDirectory = path.join(root, "web", "dist");
await mkdir(outDirectory, { recursive: true });

const widgetEntries = {
  family: path.join(root, "web", "src", "family", "familyEngine.ts"),
  review: path.join(root, "web", "src", "entries", "review.tsx"),
  pretest: path.join(root, "web", "src", "entries", "pretest.tsx"),
  lesson: path.join(root, "web", "src", "entries", "lesson.tsx"),
  dashboard: path.join(root, "web", "src", "entries", "dashboard.tsx"),
  pronunciation: path.join(root, "web", "src", "entries", "pronunciation.tsx"),
  dictation: path.join(root, "web", "src", "entries", "dictation.tsx"),
  import: path.join(root, "web", "src", "entries", "import.tsx"),
  standalone: path.join(root, "web", "src", "standalone", "main.tsx"),
} as const;

await rm(path.join(outDirectory, "widget.js"), { force: true });

for (const [kind, entryPoint] of Object.entries(widgetEntries)) {
  const familyVersion = kind === "standalone" ? createHash("sha256").update(await readFile(path.join(outDirectory, "family.js"))).digest("hex").slice(0, 12) : "dev";
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
    define: { "process.env.NODE_ENV": '"production"', __FAMILY_ASSET_VERSION__: JSON.stringify(familyVersion) },
    ...(kind === "family" ? { banner: { js: `/*\n${await readFile(path.join(root, "server", "data", "licenses", "Cytoscape-MIT.txt"), "utf8")}\n*/` } } : {}),
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

