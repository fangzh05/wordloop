import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const outputRoot = path.join(root, "dist");
const widgetKinds = ["import", "pretest", "review", "dashboard", "pronunciation", "dictation", "lesson"] as const;
const [siteHtml, siteCss, siteJs, siteManifest, widgetJs, widgetCss, ...migrationSql] = await Promise.all([
  readFile(path.join(root, "build", "index.html"), "utf8"),
  readFile(path.join(root, "web", "dist", "widget.css"), "utf8"),
  readFile(path.join(root, "web", "dist", "standalone.js"), "utf8"),
  readFile(path.join(root, "build", "manifest.webmanifest"), "utf8"),
  Promise.all(widgetKinds.map((kind) => readFile(path.join(root, "web", "dist", `${kind}.js`), "utf8"))),
  readFile(path.join(root, "web", "dist", "widget.css"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "202609130001_initial_wordloop.sql"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "202609130002_fsrs_shanbay.sql"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "202609140003_daily_queue_ui_fix.sql"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "202609150004_study_session_state.sql"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "202609150005_integrity_guards.sql"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "202609160006_performance_queries.sql"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "202609160007_review_session.sql"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "20260927143358_exact_cloze_activity_type.sql"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "202609290001_capture_notes.sql"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "20260929021548_formal_lesson_history.sql"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "20260929120641_captured_notes.sql"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "20260929172617_captured_notes_canonical_adapter.sql"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "20260929172621_analytics_read_models.sql"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "20260929184221_progress_scheduled_stability_mean.sql"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "20260930043404_balanced_exercise_plans.sql"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "20260930043648_exercise_plan_fk_indexes.sql"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "20260930141500_consolidation_target_attribution.sql"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "202610020001_note_review_states.sql"), "utf8"),
  readFile(path.join(root, "supabase", "migrations", "20261002024106_evidence_budget.sql"), "utf8"),
]);

const assetHash = (asset: string): string => createHash("sha256").update(asset).digest("hex").slice(0, 12);
if (!siteHtml.includes('href="/styles.css"') || !siteHtml.includes('src="/app.js"')) {
  throw new Error("Site HTML is missing the expected stylesheet or app script reference.");
}
const versionedSiteHtml = siteHtml
  .replace('href="/styles.css"', `href="/styles.css?v=${assetHash(siteCss)}"`)
  .replace('src="/app.js"', `src="/app.js?v=${assetHash(siteJs)}"`);

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
  external: ["node:async_hooks"],
  target: ["es2022"],
  conditions: ["worker", "browser", "import"],
  legalComments: "none",
  define: {
    __SITE_HTML__: JSON.stringify(versionedSiteHtml),
    __SITE_CSS__: JSON.stringify(siteCss),
    __SITE_JS__: JSON.stringify(siteJs),
    __SITE_MANIFEST__: JSON.stringify(siteManifest),
    __WIDGET_JS__: JSON.stringify(Object.fromEntries(widgetKinds.map((kind, index) => [kind, widgetJs[index] ?? ""]))),
    __WIDGET_CSS__: JSON.stringify(widgetCss),
    __MIGRATION_SQL__: JSON.stringify(migrationSql.join("\n\n")),
    "process.env.NODE_ENV": '"production"',
  },
});

const manifest = JSON.parse(await readFile(path.join(root, ".openai", "hosting.json"), "utf8")) as Record<string, unknown>;
delete manifest.static;
await writeFile(path.join(outputRoot, ".openai", "hosting.json"), `${JSON.stringify(manifest, null, 2)}\n`);
