import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const outputRoot = path.join(root, "dist");
const assetsRoot = path.join(outputRoot, "assets");
const widgetKinds = ["import", "pretest", "review", "dashboard", "pronunciation", "dictation", "lesson"] as const;
const [siteHtml, siteCss, siteJs, siteManifest, siteHeaders, widgetJs, widgetCss, familyJs, migrationNames] = await Promise.all([
  readFile(path.join(root, "build", "index.html"), "utf8"),
  readFile(path.join(root, "web", "dist", "widget.css"), "utf8"),
  readFile(path.join(root, "web", "dist", "standalone.js"), "utf8"),
  readFile(path.join(root, "build", "manifest.webmanifest"), "utf8"),
  readFile(path.join(root, "build", "_headers"), "utf8"),
  Promise.all(widgetKinds.map((kind) => readFile(path.join(root, "web", "dist", `${kind}.js`), "utf8"))),
  readFile(path.join(root, "web", "dist", "widget.css"), "utf8"),
  readFile(path.join(root, "web", "dist", "family.js"), "utf8"),
  readdir(path.join(root, "supabase", "migrations")),
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
await mkdir(path.join(assetsRoot, "widgets"), { recursive: true });

await Promise.all([
  writeFile(path.join(assetsRoot, "index.html"), versionedSiteHtml),
  writeFile(path.join(assetsRoot, "styles.css"), siteCss),
  writeFile(path.join(assetsRoot, "app.js"), siteJs),
  writeFile(path.join(assetsRoot, "family.js"), familyJs),
  writeFile(path.join(assetsRoot, "manifest.webmanifest"), siteManifest),
  writeFile(path.join(assetsRoot, "_headers"), siteHeaders),
  writeFile(path.join(assetsRoot, "widgets", "widget.css"), widgetCss),
  ...widgetKinds.map((kind, index) => writeFile(path.join(assetsRoot, "widgets", `${kind}.js`), widgetJs[index] ?? "")),
]);

const migrationSql = await Promise.all(migrationNames
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFile(path.join(root, "supabase", "migrations", name), "utf8")));
await writeFile(path.join(assetsRoot, "setup.sql"), `${migrationSql.join("\n\n")}\n`);

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
  define: { "process.env.NODE_ENV": '"production"' },
});
