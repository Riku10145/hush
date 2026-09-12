import { readFileSync } from "node:fs";

const allowed = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
  "MIT-0",
  "MPL-2.0",
  "CC-BY-4.0",
  "OFL-1.1",
  "Python-2.0",
  "WTFPL",
]);

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const packages = lock.packages ?? {};
const offenders = [];

for (const [name, meta] of Object.entries(packages)) {
  const license = meta.license;
  if (!license || name === "") {
    continue;
  }
  const tokens = String(license)
    .replace(/[()]/g, " ")
    .split(/\s+(?:OR|AND)\s+|\s+/i)
    .map((token) => token.trim())
    .filter(Boolean);
  const ok = tokens.some((token) => allowed.has(token));
  const gpl = /GPL/i.test(String(license)) && !/MIT/i.test(String(license));
  if (!ok || gpl) {
    offenders.push(`${name || "root"}: ${license}`);
  }
}

if (offenders.length > 0) {
  console.error("Disallowed licenses:");
  for (const line of offenders) {
    console.error(`  ${line}`);
  }
  process.exit(1);
}

console.log(`Checked ${Object.keys(packages).length} lockfile entries.`);
