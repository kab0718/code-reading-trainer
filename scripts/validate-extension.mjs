import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const projectRoot = process.cwd();
const manifestPath = path.join(projectRoot, "manifest.json");
const allowedPermissions = new Set(["activeTab", "sidePanel", "storage"]);
const allowedHostPermissions = new Set(["https://github.com/*"]);
const allowedContentScriptMatches = new Set(["https://github.com/*"]);

const errors = [];

function report(message) {
  errors.push(message);
}

async function readManifest() {
  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    report(`manifest.json could not be parsed: ${error.message}`);
    return null;
  }
}

function collectReferencedFiles(manifest) {
  const referencedFiles = new Set();
  const add = (value) => {
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

async function validateReferencedFile(relativePath) {
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

async function validateExecutableFile(relativePath) {
  if (!relativePath.endsWith(".js") && !relativePath.endsWith(".html")) return;

  const source = await readFile(path.join(projectRoot, relativePath), "utf8");
  const forbiddenPatterns = [
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
    const scriptTags = source.matchAll(
      /<script\b([^>]*)>([\s\S]*?)<\/script>/giu,
    );
    for (const match of scriptTags) {
      const attributes = match[1];
      const body = match[2].trim();
      if (!/\bsrc\s*=/iu.test(attributes) && body.length > 0) {
        report(`${relativePath} contains an inline script`);
      }
    }
  }
}

async function collectPackageFiles(directoryPath) {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files = [];

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

if (manifest) {
  if (manifest.manifest_version !== 3) {
    report("manifest_version must be 3");
  }

  if (!/^\d+\.\d+\.\d+$/u.test(manifest.version ?? "")) {
    report("manifest version must use the x.y.z format");
  }

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
