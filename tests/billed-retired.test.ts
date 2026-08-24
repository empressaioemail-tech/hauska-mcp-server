import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string, acc: string[] = []): string[] {
  for (const ent of readdirSync(dir)) {
    if (ent === "node_modules" || ent === "dist") continue;
    const p = join(dir, ent);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|js|mjs|sql)$/.test(ent)) acc.push(p);
  }
  return acc;
}

test("live src has no billed column reader; only retirement comments remain", () => {
  const hits: string[] = [];
  for (const file of walk(join(ROOT, "src"))) {
    const text = readFileSync(file, "utf8");
    if (/\bbilled\b/.test(text)) hits.push(file.replace(ROOT, ""));
  }
  assert.deepEqual(hits, [], `live billed hits: ${hits.join(", ")}`);
});
