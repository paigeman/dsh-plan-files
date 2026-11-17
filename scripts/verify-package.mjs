import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { artifactDirectory } from "./acceptance-control.mjs";
import { digest, readPackage, releaseInfo, root } from "./release.mjs";

const pkg = readPackage();
releaseInfo(pkg, { repository: process.env.GITHUB_REPOSITORY });
const temporary = artifactDirectory(join(root, ".agent-tmp"));
const output = artifactDirectory(
  resolve(process.env.PACKAGE_OUTPUT_DIR ?? join(temporary, "package")),
);
const npm = process.env.npm_execpath;
assert.ok(npm, "Run this check with npm run verify:package.");
const packed = JSON.parse(
  execFileSync(
    process.execPath,
    [npm, "pack", "--json", "--ignore-scripts", "--pack-destination", output],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: join(temporary, "npm-cache") },
    },
  ),
)[0];
assert.equal(basename(packed.filename), packed.filename);
const files = packed.files.map((file) => file.path);
for (const file of [
  "package.json",
  "index.js",
  "lib/plan-store.js",
  "lib/exact-edit.js",
  "cordis.patch.yml",
  "locale/en.json",
  "locale/zh.json",
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
])
  assert.ok(files.includes(file), `Missing package file ${file}`);
for (const file of files)
  assert.match(
    file,
    /^(?:package\.json|index\.js|cordis\.patch\.yml|LICENSE|README(?:\.zh-CN)?\.md|lib\/[\w/-]+\.js|locale\/[\w-]+\.json)$/,
  );

const archive = join(output, packed.filename);
const fixture = mkdtempSync(join(temporary, "package-smoke-"));
execFileSync("tar", ["-xzf", archive, "-C", fixture]);
const directory = join(fixture, "package");
const published = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
assert.equal(published.name, "dsh-plan-files");
assert.equal(published.version, pkg.version);
assert.notEqual(published.private, true);
assert.deepEqual(published.engines, pkg.engines);
const patch = readFileSync(join(directory, "cordis.patch.yml"), "utf8");
assert.match(patch, /id: plan-files\s/);
assert.ok(patch.includes(`name: "${pkg.name}"`));
assert.ok(!patch.includes("plan-files-dev"));
const result = execFileSync(
  process.execPath,
  ["--test", "--test-reporter=tap", join(root, "test/native.test.js")],
  {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, DSH_PLAN_FILES_ENTRY: join(directory, "index.js") },
  },
);
assert.match(result, /^# skipped 0$/m, "Packed native tests must run without skipped checks.");

const bytes = readFileSync(archive);
const metadata = {
  name: pkg.name,
  version: pkg.version,
  filename: packed.filename,
  sha256: digest(bytes, "sha256"),
  integrity: `sha512-${digest(bytes, "sha512", "base64")}`,
};
writeFileSync(join(output, "SHA256SUMS"), `${metadata.sha256}  ${metadata.filename}\n`);
writeFileSync(join(output, "release.json"), JSON.stringify(metadata, null, 2) + "\n");
console.log(
  `Verified ${pkg.name}@${pkg.version}: ${files.length} files; packed native plan editing and approval passed.`,
);
