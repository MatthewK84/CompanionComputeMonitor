/**
 * Air-gap verification: fail the build if the dist/ bundle references any
 * external origin. Run after `npm run build`; wired into CI.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST_DIR = "dist";
const ORIGIN_PATTERN = /https?:\/\/[a-z0-9.-]+/gi;
// Origins acceptable inside the bundle because they are never fetched:
// license/comment links and XML namespace identifiers (w3.org is the SVG
// namespace URI React embeds as a string constant).
const ALLOWED = Object.freeze([
  "reactjs.org",
  "react.dev",
  "github.com/facebook",
  "www.w3.org",
]);

/** @returns {string[]} */
function listFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) {
      continue;
    }
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        stack.push(full);
        continue;
      }
      out.push(full);
    }
  }
  return out;
}

function main() {
  let violations = 0;
  for (const file of listFiles(DIST_DIR)) {
    if (!/\.(js|css|html|json|svg)$/.test(file)) {
      continue;
    }
    const text = readFileSync(file, "utf-8");
    const matches = text.match(ORIGIN_PATTERN) ?? [];
    for (const match of matches) {
      const allowed = ALLOWED.some((a) => match.includes(a));
      if (allowed) {
        continue;
      }
      console.error(`EXTERNAL ORIGIN in ${file}: ${match}`);
      violations += 1;
    }
  }
  if (violations > 0) {
    console.error(`\nAir-gap check FAILED: ${violations} external reference(s).`);
    process.exit(1);
  }
  console.log("Air-gap check passed: no external origins in dist/.");
}

main();
