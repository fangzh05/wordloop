import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const outputRoot = path.join(root, "dist");
const widgetKinds = ["import", "pretest", "review", "dashboard", "pronunciation", "dictation", "lesson"] as const;
const [siteHtml, siteCss, siteJs, widgetJs, widgetCss, ...migrationSql] = await Promise.all([
  readFile(path.join(root, "build", "index.html"), "utf8"),
  readFile(path.join(root, "build", "styles.css"), "utf8"),
  readFile(path.join(root, "build", "app.js"), "utf8"),
  Promise.all(widgetKinds.map((kind) => readFile(path.join(root, "web", "dist", `${kind}.js`), "utf8"))),
  readFile(path.join(root, "web", "dist", "widget.css"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "202609130001_initial_wordloop.sql"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "202609130002_fsrs_shanbay.sql"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "202609140003_daily_queue_ui_fix.sql"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "202609150004_study_session_state.sql"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "202609150005_integrity_guards.sql"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "202609160006_performance_queries.sql"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "202609160007_review_session.sql"), "utf8"),
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
    __SITE_HTML__: JSON.stringify(siteHtml),
    __SITE_CSS__: JSON.stringify(siteCss),
    __SITE_JS__: JSON.stringify(siteJs),
    __WIDGET_JS__: JSON.stringify(Object.fromEntries(widgetKinds.map((kind, index) => [kind, widgetJs[index] ?? ""]))),
    __WIDGET_CSS__: JSON.stringify(widgetCss),
    __MIGRATION_SQL__: JSON.stringify(migrationSql.join("\n\n")),
    "process.env.NODE_ENV": '"production"',
  },
});

const manifest = JSON.parse(await readFile(path.join(root, ".openai", "hosting.json"), "utf8")) as Record<string, unknown>;
delete manifest.static;
await writeFile(path.join(outputRoot, ".openai", "hosting.json"), `${JSON.stringify(manifest, null, 2)}\n`);
