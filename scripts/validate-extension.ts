import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";

const projectRoot = path.join(process.cwd(), "dist/extension");
const manifestPath = path.join(projectRoot, "manifest.json");
const allowedPermissions = new Set(["activeTab", "sidePanel", "storage"]);
const allowedHostPermissions = new Set(["https://github.com/*"]);
const allowedOptionalHostPermissions = new Set(["https://*.workers.dev/*"]);
const allowedContentScriptMatches = new Set(["https://github.com/*"]);
const production = process.argv.slice(2).includes("--production");
const unknownArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== "--production");

interface ExtensionManifest {
  action?: {
    default_icon?: Record<string, string>;
    default_popup?: string;
  };
  background?: { service_worker?: string };
  content_scripts?: Array<{
    css?: string[];
    js?: string[];
    matches?: string[];
  }>;
  host_permissions?: string[];
  optional_host_permissions?: string[];
  icons?: Record<string, string>;
  key?: string;
  manifest_version?: number;
  options_page?: string;
  options_ui?: { page?: string };
  permissions?: string[];
  side_panel?: { default_path?: string };
  version?: string;
}

const errors: string[] = [];

if (unknownArguments.length > 0) {
  errors.push(`unknown validation argument: ${unknownArguments.join(", ")}`);
}

function report(message: string): void {
  errors.push(message);
}

function deriveExtensionId(publicKey: string): string {
  const digest = createHash("sha256")
    .update(Buffer.from(publicKey, "base64"))
    .digest()
    .subarray(0, 16);

  return [...digest]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode("a".charCodeAt(0) + nibble))
    .join("");
}

async function validateExtensionIdentity(
  manifest: ExtensionManifest,
): Promise<void> {
  if (!production) {
    if (manifest.key) {
      report("development package must not contain a fixed extension key");
    }
    return;
  }

  if (!manifest.key || !/^[A-Za-z0-9+/]+={0,2}$/u.test(manifest.key)) {
    report("production manifest key must be a Base64-encoded public key");
    return;
  }

  const extensionId = deriveExtensionId(manifest.key);
  const configuredIds = (process.env.ALLOWED_EXTENSION_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (!configuredIds.includes(extensionId)) {
    report(
      `manifest key derives extension ID ${extensionId}, which is not present in ALLOWED_EXTENSION_IDS`,
    );
  }
}

async function validateEvaluationApiConfiguration(): Promise<void> {
  const source = await readFile(
    path.join(projectRoot, "src/evaluation-config.js"),
    "utf8",
  );
  const context = vm.createContext({ Object, URL });
  vm.runInContext(source, context);
  const config = context.CodeReadingTrainerEvaluationConfig as
    | {
        getEvaluationApiPermissionOrigin(): string | null;
        getEvaluationApiUrl(): string | null;
        getReadingSupportApiUrl(): string | null;
      }
    | undefined;

  if (!config) {
    report("built evaluation configuration is missing");
    return;
  }

  const expectedUrl = production
    ? process.env.EVALUATION_API_URL?.trim()
    : null;
  if (config.getEvaluationApiUrl() !== expectedUrl) {
    report("built evaluation API URL does not match the selected build mode");
  }

  if (production && expectedUrl) {
    const expectedReadingSupportUrl = expectedUrl.replace(
      /\/v1\/evaluations$/u,
      "/v1/reading-support",
    );
    const expectedPermissionOrigin = `${new URL(expectedUrl).origin}/*`;
    if (config.getReadingSupportApiUrl() !== expectedReadingSupportUrl) {
      report("built reading support API URL does not match EVALUATION_API_URL");
    }
    if (
      config.getEvaluationApiPermissionOrigin() !== expectedPermissionOrigin
    ) {
      report("built API permission origin does not match EVALUATION_API_URL");
    }
  } else if (
    config.getReadingSupportApiUrl() !== null ||
    config.getEvaluationApiPermissionOrigin() !== null
  ) {
    report("development package must not expose a production API origin");
  }
}

async function validateRepositoryConfiguration(): Promise<void> {
  const wranglerSource = await readFile(
    path.join(process.cwd(), "wrangler.jsonc"),
    "utf8",
  );
  if (/"ALLOWED_EXTENSION_IDS"\s*:/u.test(wranglerSource)) {
    report("wrangler.jsonc must not contain production extension IDs");
  }
}

async function readManifest(): Promise<ExtensionManifest | null> {
  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report(`manifest.json could not be parsed: ${message}`);
    return null;
  }
}

function collectReferencedFiles(manifest: ExtensionManifest): Set<string> {
  const referencedFiles = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) {
      referencedFiles.add(value);
    }
  };

  add(manifest.background?.service_worker);
  add(manifest.action?.default_popup);
  add(manifest.side_panel?.default_path);
  add(manifest.options_page);
  add(manifest.options_ui?.page);

  for (const contentScript of manifest.content_scripts ?? []) {
    for (const file of contentScript.js ?? []) add(file);
    for (const file of contentScript.css ?? []) add(file);
  }

  for (const iconPath of Object.values(manifest.icons ?? {})) add(iconPath);
  for (const iconPath of Object.values(manifest.action?.default_icon ?? {}))
    add(iconPath);

  return referencedFiles;
}

async function validateReferencedFile(relativePath: string): Promise<void> {
  const absolutePath = path.resolve(projectRoot, relativePath);
  const relativeToRoot = path.relative(projectRoot, absolutePath);

  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    report(`manifest reference escapes the project root: ${relativePath}`);
    return;
  }

  try {
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) {
      report(`manifest reference is not a file: ${relativePath}`);
    }
  } catch {
    report(`manifest references a missing file: ${relativePath}`);
  }
}

async function validateExecutableFile(relativePath: string): Promise<void> {
  if (!relativePath.endsWith(".js") && !relativePath.endsWith(".html")) return;

  const source = await readFile(path.join(projectRoot, relativePath), "utf8");
  const forbiddenPatterns: Array<readonly [RegExp, string]> = [
    [/(?:eval|Function)\s*\(/u, "dynamic code execution"],
    [/importScripts\s*\(\s*["']https?:\/\//u, "remote importScripts call"],
    [/import\s*\(\s*["']https?:\/\//u, "remote dynamic import"],
    [/<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//iu, "remote script source"],
  ];

  for (const [pattern, description] of forbiddenPatterns) {
    if (pattern.test(source)) {
      report(`${relativePath} contains forbidden ${description}`);
    }
  }

  if (relativePath.endsWith(".html")) {
    const scriptTags = source.matchAll(/<script\b([^>]*)>/giu);
    for (const match of scriptTags) {
      const attributes = match[1] ?? "";
      if (!/\bsrc\s*=/iu.test(attributes)) {
        report(`${relativePath} contains an inline script`);
      }
    }
  }
}

async function collectPackageFiles(directoryPath: string): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectPackageFiles(absolutePath)));
    } else if (entry.isFile()) {
      files.push(path.relative(projectRoot, absolutePath));
    }
  }

  return files;
}

const manifest = await readManifest();
await validateRepositoryConfiguration();

if (manifest) {
  if (manifest.manifest_version !== 3) {
    report("manifest_version must be 3");
  }

  if (!/^\d+\.\d+\.\d+$/u.test(manifest.version ?? "")) {
    report("manifest version must use the x.y.z format");
  }

  await validateExtensionIdentity(manifest);
  await validateEvaluationApiConfiguration();

  for (const permission of manifest.permissions ?? []) {
    if (!allowedPermissions.has(permission)) {
      report(`unexpected extension permission: ${permission}`);
    }
  }

  for (const permission of allowedPermissions) {
    if (!(manifest.permissions ?? []).includes(permission)) {
      report(`required extension permission is missing: ${permission}`);
    }
  }

  for (const hostPermission of manifest.host_permissions ?? []) {
    if (!allowedHostPermissions.has(hostPermission)) {
      report(`unexpected host permission: ${hostPermission}`);
    }
  }

  for (const hostPermission of allowedHostPermissions) {
    if (!(manifest.host_permissions ?? []).includes(hostPermission)) {
      report(`required host permission is missing: ${hostPermission}`);
    }
  }

  for (const hostPermission of manifest.optional_host_permissions ?? []) {
    if (!allowedOptionalHostPermissions.has(hostPermission)) {
      report(`unexpected optional host permission: ${hostPermission}`);
    }
  }

  for (const hostPermission of allowedOptionalHostPermissions) {
    if (!(manifest.optional_host_permissions ?? []).includes(hostPermission)) {
      report(`required optional host permission is missing: ${hostPermission}`);
    }
  }

  for (const contentScript of manifest.content_scripts ?? []) {
    for (const matchPattern of contentScript.matches ?? []) {
      if (!allowedContentScriptMatches.has(matchPattern)) {
        report(`unexpected content script match pattern: ${matchPattern}`);
      }
    }
  }

  const referencedFiles = collectReferencedFiles(manifest);
  for (const relativePath of referencedFiles) {
    await validateReferencedFile(relativePath);
  }

  const packageFiles = await collectPackageFiles(path.join(projectRoot, "src"));
  for (const relativePath of packageFiles)
    await validateExecutableFile(relativePath);
}

if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log("Extension package validation passed.");
}
