import { readFileSync, writeFileSync } from "node:fs";

const path = "src/tools.ts";
const lines = readFileSync(path, "utf8").split("\n");
const out = [];
let i = 0;
let merged = 0;

function parseBalanced(linesSlice, startIdx, openChar, closeChar) {
  let depth = 0;
  let started = false;
  const parts = [];
  for (let idx = startIdx; idx < linesSlice.length; idx++) {
    const line = linesSlice[idx];
    parts.push(line);
    for (const ch of line) {
      if (ch === openChar) {
        depth++;
        started = true;
      } else if (ch === closeChar) {
        depth--;
      }
    }
    if (started && depth === 0) {
      return { endIdx: idx, text: parts.join("\n") };
    }
  }
  return null;
}

while (i < lines.length) {
  const line = lines[i];
  if (line.trimStart().startsWith("logToolInvocation({")) {
    const logStart = i;
    const logParsed = parseBalanced(lines, logStart, "{", "}");
    if (!logParsed) {
      out.push(line);
      i++;
      continue;
    }
    const logEnd = logParsed.endIdx + 1;
    let j = logEnd;
    while (j < lines.length && lines[j].trim() === "") j++;
    if (j < lines.length && lines[j].includes("return envelopeContent(")) {
      const returnStart = j;
      const returnParsed = parseBalanced(lines, returnStart, "(", ")");
      if (!returnParsed) {
        out.push(line);
        i++;
        continue;
      }
      const returnBlock = returnParsed.text;
      const expr = returnBlock
        .replace(/^\s*return envelopeContent\(\s*/, "")
        .replace(/\s*\)\s*;?\s*$/, "")
        .trim()
        .replace(/,\s*$/, "");
      if (!expr || expr.startsWith(",")) {
        out.push(line);
        i++;
        continue;
      }
      const logBlock = logParsed.text;
      const toolMatch = logBlock.match(/tool:\s*"([^"]+)"/);
      if (!toolMatch) {
        out.push(line);
        i++;
        continue;
      }
      const indent = lines[logStart].match(/^(\s*)/)[1];
      const logInner = logBlock
        .replace(/^\s*logToolInvocation\(\{\s*/, "")
        .replace(/\s*\}\);\s*$/, "")
        .trimEnd()
        .replace(/,\s*$/, "");
      out.push(`${indent}const __readEnv = ${expr};`);
      out.push(`${indent}logToolInvocation({`);
      out.push(`${indent}  ${logInner}${logInner.endsWith(",") ? "" : ","}`);
      out.push(`${indent}  envelope: __readEnv,`);
      out.push(`${indent}});`);
      out.push(`${indent}return envelopeContent(__readEnv);`);
      i = returnParsed.endIdx + 1;
      merged++;
      continue;
    }
  }
  out.push(line);
  i++;
}

writeFileSync(path, out.join("\n"));
console.error(`merged ${merged} read log blocks`);
