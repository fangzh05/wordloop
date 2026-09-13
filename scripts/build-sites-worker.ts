import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const outputRoot = path.join(root, "dist");
const values = await Promise.all([
  readFile(path.join(root, "build", "index.html"), "utf8"),
  readFile(path.join(root, "build", "styles.css"), "utf8"),
  readFile(path.join(root, "build", "app.js"), "utf8"),
  readFile(path.join(root, "web", "dist", "widget.js"), "utf8"),
  readFile(path.join(root, "web", "dist", "widget.css"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "202609130001_initial_wordloop.sql"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "202609130002_fsrs_shanbay.sql"), "utf8"),
]);

await rm(outputRoot, { recursive: true, force: true });
await mkdir(path.join(outputRoot, "server"), { recursive: true });
await mkdir(path.join(outputRoot, ".openai"), { recursive: true });

await build({
  entryPoints: [path.join(root, "server", "worker.ts")],
  outfile: path.join(outputRoot, "server", "index.js"),
  bundle: true,
  minify: true,
  sourcemap: false,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  conditions: ["worker", "browser", "import"],
  legalComments: "none",
  define: {
    __SITE_HTML__: JSON.stringify(values[0]),
    __SITE_CSS__: JSON.stringify(values[1]),
    __SITE_JS__: JSON.stringify(values[2]),
    __WIDGET_JS__: JSON.stringify(values[3]),
    __WIDGET_CSS__: JSON.stringify(values[4]),
    __MIGRATION_SQL__: JSON.stringify(`${values[5]}\n\n${values[6]}`),
    "process.env.NODE_ENV": '"production"',
  },
});

const manifest = JSON.parse(await readFile(path.join(root, ".openai", "hosting.json"), "utf8")) as Record<string, unknown>;
delete manifest.static;
await writeFile(path.join(outputRoot, ".openai", "hosting.json"), `${JSON.stringify(manifest, null, 2)}\n`);
