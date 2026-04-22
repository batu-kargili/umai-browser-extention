import { copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import * as esbuild from "esbuild";

const watchEnabled = process.argv.includes("--watch");
const rootDir = resolve(process.cwd());
const distDir = resolve(rootDir, "dist");

const buildEntries = [
  {
    entry: "src/background/service_worker.ts",
    outfile: "service_worker.js",
    format: "esm"
  },
  {
    entry: "src/popup/popup.ts",
    outfile: "popup.js",
    format: "iife"
  },
  {
    entry: "src/content/sites/chatgpt.ts",
    outfile: "content_chatgpt.js",
    format: "iife"
  },
  {
    entry: "src/content/sites/gemini.ts",
    outfile: "content_gemini.js",
    format: "iife"
  },
  {
    entry: "src/content/sites/claude.ts",
    outfile: "content_claude.js",
    format: "iife"
  }
];

async function buildOnce() {
  await Promise.all(
    buildEntries.map((item) =>
      esbuild.build({
        entryPoints: [resolve(rootDir, item.entry)],
        outfile: resolve(distDir, item.outfile),
        bundle: true,
        format: item.format,
        platform: "browser",
        target: "chrome120",
        sourcemap: true,
        logLevel: "info"
      })
    )
  );
}

async function copyStaticFiles() {
  await copyFile(resolve(rootDir, "manifest.json"), resolve(distDir, "manifest.json"));
  await copyFile(resolve(rootDir, "schema.json"), resolve(distDir, "schema.json"));
  await copyFile(resolve(rootDir, "src/popup/popup.html"), resolve(distDir, "popup.html"));
}

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

if (!watchEnabled) {
  await buildOnce();
  await copyStaticFiles();
} else {
  const contexts = await Promise.all(
    buildEntries.map((item) =>
      esbuild.context({
        entryPoints: [resolve(rootDir, item.entry)],
        outfile: resolve(distDir, item.outfile),
        bundle: true,
        format: item.format,
        platform: "browser",
        target: "chrome120",
        sourcemap: true,
        logLevel: "info"
      })
    )
  );

  await Promise.all(contexts.map((ctx) => ctx.watch()));
  await copyStaticFiles();
  process.stdout.write("Watching extension sources...\n");
  process.stdin.resume();
}
