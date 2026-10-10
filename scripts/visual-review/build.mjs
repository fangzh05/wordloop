
import { build } from "esbuild";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
const dest=path.join(process.cwd(),"scripts/visual-review/dist");
await mkdir(dest,{recursive:true});
await build({
 entryPoints:["scripts/visual-review/fixture.tsx"],outfile:path.join(dest,"app.js"),
 bundle:true,format:"iife",platform:"browser",target:["es2022"],jsx:"automatic",
 define:{"process.env.NODE_ENV":'"production"',__FAMILY_ASSET_VERSION__:'"preview"'},
 legalComments:"none"
});
await build({
 entryPoints:["web/src/family/familyEngine.ts"],outfile:path.join(dest,"family.js"),
 bundle:true,format:"iife",platform:"browser",target:["es2022"],
 define:{"process.env.NODE_ENV":'"production"'}
});
await copyFile("web/src/styles.css",path.join(dest,"styles.css"));
await writeFile(path.join(dest,"index.html"),
 '<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><style>.visual-fixture-stamp{display:block;position:static;width:max-content;max-width:calc(100% - 20px);margin:24px 10px 8px auto;padding:5px 9px;font:10px/1.3 monospace;background:#0c2a40;color:#fff;opacity:.86;pointer-events:none}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
console.log("Built actual-source React component fixture:",dest);
