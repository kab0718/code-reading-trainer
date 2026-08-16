import { cp, mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const projectRoot = process.cwd();
const outputRoot = path.join(projectRoot, "dist/extension");
const compilerPath = path.join(projectRoot, "node_modules/typescript/bin/tsc");

await rm(outputRoot, { force: true, recursive: true });

execFileSync(
  process.execPath,
  [compilerPath, "-p", "tsconfig.extension.json"],
  {
    cwd: projectRoot,
    stdio: "inherit",
  },
);

await mkdir(path.join(outputRoot, "src"), { recursive: true });
await Promise.all([
  cp(
    path.join(projectRoot, "manifest.json"),
    path.join(outputRoot, "manifest.json"),
  ),
  cp(
    path.join(projectRoot, "src/sidepanel.css"),
    path.join(outputRoot, "src/sidepanel.css"),
  ),
  cp(
    path.join(projectRoot, "src/sidepanel.html"),
    path.join(outputRoot, "src/sidepanel.html"),
  ),
]);

console.log(`Extension built at ${path.relative(projectRoot, outputRoot)}.`);
