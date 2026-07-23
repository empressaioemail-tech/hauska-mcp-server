#!/usr/bin/env node
// Patch @hauska-sdk/* published dist for Node native ESM.
// Upstream packages omit .js extensions on relative imports; Node 20
// fails dynamic import. Consumer-side fix until SDK republishes.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SDK_ROOT = join(ROOT, "node_modules", "@hauska-sdk");

const IMPORT_RE =
  /(from\s+|import\s*\(\s*)(["'])(\.[^"']+?)\2/g;

function walkJs(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkJs(p, out);
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}

function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  if (/\.(js|json|node|mjs|cjs)$/.test(spec)) return null;
  const base = resolve(dirname(fromFile), spec);
  if (existsSync(base + ".js")) return spec + ".js";
  if (existsSync(join(base, "index.js"))) {
    return spec.endsWith("/") ? `${spec}index.js` : `${spec}/index.js`;
  }
  return null;
}

function patchFile(file) {
  const src = readFileSync(file, "utf8");
  let changed = false;
  const next = src.replace(IMPORT_RE, (full, prefix, quote, spec) => {
    const fixed = resolveSpecifier(file, spec);
    if (!fixed) return full;
    changed = true;
    return `${prefix}${quote}${fixed}${quote}`;
  });
  if (changed) writeFileSync(file, next);
  return changed;
}

function main() {
  if (!existsSync(SDK_ROOT)) {
    console.error("[patch-hauska-sdk-esm] no @hauska-sdk packages; skip");
    return;
  }
  let patched = 0;
  for (const pkg of readdirSync(SDK_ROOT)) {
    const dist = join(SDK_ROOT, pkg, "dist");
    for (const file of walkJs(dist)) {
      if (patchFile(file)) {
        patched += 1;
        console.error(`[patch-hauska-sdk-esm] ${file}`);
      }
    }
  }
  console.error(`[patch-hauska-sdk-esm] patched ${patched} file(s)`);
}

main();
