import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { satisfies } from "semver";
import { nativeRuntimes } from "../scripts/test-native.mjs";
import { nativeRuntime } from "./native-runtime.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const unverifiedVersions = ["0.2.2", "0.2.2-rc.4", "0.2.3-rc.1", "0.3.0"];

test("DSH engines and README tables match the tested matrix and exclude unverified releases", () => {
  const versions = nativeRuntimes().map((runtime) => runtime.version);
  assert.ok(versions.length > 0);
  assert.equal(pkg.engines.dsh, versions.join(" || "));
  for (const name of ["README.md", "README.zh-CN.md"]) {
    const row = readFileSync(new URL(`../${name}`, import.meta.url), "utf8")
      .split("\n")
      .find((line) => line.split("|")[1]?.trim().startsWith(pkg.version));
    assert.ok(row, `${name} is missing the current plugin's support row.`);
    const documented = row.split("|")[2].match(/\d+\.\d+\.\d+(?:-[\w.-]+)?/g) ?? [];
    assert.deepEqual(documented, versions, `${name} differs from the tested runtime matrix.`);
  }
  for (const version of versions) {
    assert.equal(satisfies(version, pkg.engines.dsh), true, version);
    assert.equal(satisfies(version, pkg.engines.dsh, { includePrerelease: true }), true, version);
  }
  for (const version of unverifiedVersions)
    assert.equal(satisfies(version, pkg.engines.dsh, { includePrerelease: true }), false, version);
});

test("native DSH compatibility admits the plugin without exemptions and rejects untested releases", async () => {
  const { evaluatePluginCompatibility } = await nativeRuntime().load("dsh-app-boot");
  assert.equal(evaluatePluginCompatibility(pkg), undefined);
  for (const runtime of nativeRuntimes())
    assert.equal(evaluatePluginCompatibility(pkg, {}, runtime.version), undefined);
  for (const version of unverifiedVersions) {
    const issue = evaluatePluginCompatibility(pkg, {}, version);
    assert.deepEqual(issue.requirements, { "engines.dsh": pkg.engines.dsh });
    assert.equal(issue.exempted, false);
  }
});
