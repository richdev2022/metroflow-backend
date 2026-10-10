#!/usr/bin/env node
/**
 * Static 42P18 guard: scans all .ts files under server/ for
 * `query("sql" / template, [params])` calls and reports placeholder/param
 * mismatches:
 *  - max placeholder index > param count (missing params -> runtime 42P24)
 *  - gaps in placeholder numbering (1..k with a hole -> 42P18)
 *  - literal param arrays where an early index is never referenced (42P18)
 * Dynamic param expressions (variables, spreads) are only checked for gaps.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const ROOT = new URL("../server", import.meta.url).pathname;

function walk(dir) {
  let out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
let issues = 0;

for (const file of files) {
  const src = readFileSync(file, "utf8");
  let idx = 0;
  while ((idx = src.indexOf("query(", idx)) !== -1) {
    let i = idx + 6;
    while (/\s/.test(src[i])) i++;
    let sql = "";
    if (src[i] === "`" || src[i] === '"' || src[i] === "'") {
      const q = src[i];
      // template literals may contain ${} with nested backticks — handle simple nesting
      let depth = 0;
      let j = i + 1;
      for (; j < src.length; j++) {
        const c = src[j];
        if (q === "`") {
          if (c === "{" && src[j - 1] === "$") depth++;
          else if (c === "}" && depth > 0) depth--;
          else if (c === "`" && depth === 0) break;
        } else if (c === q && src[j - 1] !== "\\") {
          break;
        }
      }
      sql = src.slice(i + 1, j);
      i = j + 1;
    } else {
      idx += 6;
      continue; // non-literal SQL, skip
    }
    // skip to params
    while (/\s/.test(src[i])) i++;
    let paramDesc = "?";
    let paramCount = null;
    if (src[i] === ",") {
      i++;
      while (/\s/.test(src[i])) i++;
      if (src[i] === "[") {
        // balanced bracket
        let d = 0, j = i, strQ = null;
        for (; j < src.length; j++) {
          const c = src[j];
          if (strQ) {
            if (c === "\\") j++;
            else if (c === strQ) strQ = null;
            continue;
          }
          if (c === "'" || c === '"' || c === "`") strQ = c;
          else if (c === "[") d++;
          else if (c === "]") { d--; if (d === 0) break; }
        }
        const inner = src.slice(i + 1, j);
        paramDesc = inner.replace(/\s+/g, " ").trim().slice(0, 60);
        // literal count: split top-level commas, ignore trailing comma
        let dd = 0, sq = null, parts = 1, empty = inner.trim() === "";
        let lastCommaEnd = -1;
        for (let k = 0; k < inner.length; k++) {
          const c = inner[k];
          if (sq) { if (c === "\\") k++; else if (c === sq) sq = null; continue; }
          if (c === "'" || c === '"' || c === "`") sq = c;
          else if ("([{".includes(c)) dd++;
          else if (")]}".includes(c)) dd--;
          else if (c === "," && dd === 0) { parts++; lastCommaEnd = k; }
        }
        if (!empty && inner.slice(lastCommaEnd + 1).trim() === "") parts--; // trailing comma
        paramCount = empty ? 0 : parts;
        i = j + 1;
      } else {
        // variable expression — read until )
        let j = i, d = 0;
        for (; j < src.length; j++) {
          if (src[j] === "(") d++;
          else if (src[j] === ")") { if (d === 0) break; d--; }
        }
        paramDesc = src.slice(i, j).replace(/\s+/g, " ").trim().slice(0, 60);
        i = j;
      }
    }
    const refs = [...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => +m[1]))].sort((a, b) => a - b);
    if (!refs.length) { idx += 6; continue; }
    const max = refs[refs.length - 1];
    const gaps = [];
    for (let k = 1; k <= max; k++) if (!refs.includes(k)) gaps.push(k);
    const line = src.slice(0, idx).split("\n").length;
    if (max > (paramCount ?? Infinity)) {
      console.log(`MISSING-PARAM ${file.replace(ROOT, "server")}:${line} refs $${refs} but ${paramCount} params (${paramDesc})`);
      issues++;
    } else if (gaps.length) {
      console.log(`GAP ${file.replace(ROOT, "server")}:${line} refs $${refs} — holes at ${gaps.map((g) => "$" + g)}`);
      issues++;
    } else if (paramCount !== null && refs[0] > 1) {
      console.log(`UNUSED-EARLY ${file.replace(ROOT, "server")}:${line} refs $${refs} but has ${paramCount} literal params (${paramDesc}) — $1..$${refs[0]-1} unused (42P18)`);
      issues++;
    } else if (paramCount !== null && !refs.includes(paramCount) && refs.every((r) => r < paramCount)) {
      if (/\$\$\{/.test(sql)) {
        // LIMIT $${n} style: placeholders injected at runtime — trailing refs
        // continue past the last literal $N. Not an error; just informational.
        console.log(`INFO-interp ${file.replace(ROOT, "server")}:${line} trailing params beyond $${refs[refs.length-1]} but template has $\\\${} interpolated placeholders (${paramDesc})`);
      } else {
        console.log(`UNUSED-LATE ${file.replace(ROOT, "server")}:${line} refs $${refs} but has ${paramCount} literal params (${paramDesc}) — trailing unused (42P18 if untyped)`);
        issues++;
      }
    }
    idx += 6;
  }
}
console.log(issues ? `\n${issues} potential issue(s)` : "\nAll query( calls consistent");
