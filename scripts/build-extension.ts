import { execFileSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const projectRoot = process.cwd();
const outputRoot = path.join(projectRoot, "dist/extension");
const compilerPath = path.join(projectRoot, "node_modules/typescript/bin/tsc");
const evaluationApiUrlMarker = "__BUILD_EVALUATION_API_URL__";
const production = process.argv.slice(2).includes("--production");
const unknownArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== "--production");

if (unknownArguments.length > 0) {
  throw new Error(`Unknown build argument: ${unknownArguments.join(", ")}`);
}

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for a production extension build.`);
  }
  return value;
}

function validatePublicKey(publicKey: string): void {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(publicKey)) {
    throw new Error("EXTENSION_PUBLIC_KEY must be Base64-encoded SPKI data.");
  }

  try {
    createPublicKey({
      key: Buffer.from(publicKey, "base64"),
      format: "der",
      type: "spki",
    });
  } catch {
    throw new Error("EXTENSION_PUBLIC_KEY must be a valid SPKI public key.");
  }
}

function validateEvaluationApiUrl(value: string): void {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".workers.dev") ||
    url.pathname !== "/v1/evaluations" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "EVALUATION_API_URL must be an HTTPS workers.dev /v1/evaluations URL without credentials, query, or fragment.",
    );
  }
}

const extensionPublicKey = production
  ? requiredEnvironmentVariable("EXTENSION_PUBLIC_KEY")
  : null;
const evaluationApiUrl = production
  ? requiredEnvironmentVariable("EVALUATION_API_URL")
  : null;

if (extensionPublicKey) validatePublicKey(extensionPublicKey);
if (evaluationApiUrl) validateEvaluationApiUrl(evaluationApiUrl);

await rm(outputRoot, { force: true, recursive: true });

execFileSync(
  process.execPath,
  [compilerPath, "-p", "tsconfig.extension.json"],
  {
    cwd: projectRoot,
    stdio: "inherit",
  },
);

await rm(path.join(outputRoot, "src/python-candidates.js"), { force: true });

execFileSync(
  path.join(projectRoot, "node_modules/.bin/esbuild"),
  [
    "src/background.ts",
    "--bundle",
    "--format=iife",
    "--platform=browser",
    `--outfile=${path.join(outputRoot, "src/background.js")}`,
  ],
  { cwd: projectRoot, stdio: "inherit" },
);

await mkdir(path.join(outputRoot, "src"), { recursive: true });
await mkdir(path.join(outputRoot, "assets/icons"), { recursive: true });
await Promise.all([
  cp(
    path.join(projectRoot, "src/sidepanel.css"),
    path.join(outputRoot, "src/sidepanel.css"),
  ),
  cp(
    path.join(projectRoot, "src/sidepanel.html"),
    path.join(outputRoot, "src/sidepanel.html"),
  ),
  cp(
    path.join(projectRoot, "assets/icons/code-reading-trainer-128.png"),
    path.join(outputRoot, "assets/icons/code-reading-trainer-128.png"),
  ),
]);

const sourceManifest = JSON.parse(
  await readFile(path.join(projectRoot, "manifest.json"), "utf8"),
) as Record<string, unknown>;
if (Object.hasOwn(sourceManifest, "key")) {
  throw new Error(
    "manifest.json must not contain a fixed key; use EXTENSION_PUBLIC_KEY for a production build.",
  );
}
if (extensionPublicKey) sourceManifest.key = extensionPublicKey;
await writeFile(
  path.join(outputRoot, "manifest.json"),
  `${JSON.stringify(sourceManifest, null, 2)}\n`,
);

const evaluationConfigPath = path.join(outputRoot, "src/evaluation-config.js");
const evaluationConfigSource = await readFile(evaluationConfigPath, "utf8");
const marker = JSON.stringify(evaluationApiUrlMarker);
if (evaluationConfigSource.split(marker).length !== 2) {
  throw new Error("Evaluation API build marker was not found exactly once.");
}
await writeFile(
  evaluationConfigPath,
  evaluationConfigSource.replace(marker, JSON.stringify(evaluationApiUrl)),
);

console.log(
  `${production ? "Production extension" : "Extension"} built at ${path.relative(projectRoot, outputRoot)}.`,
);
