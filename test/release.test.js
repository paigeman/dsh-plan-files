import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { artifactDirectory } from "../scripts/acceptance-control.mjs";
import { digest, publishedState, releaseInfo, verifyArtifact } from "../scripts/release.mjs";

const pkg = {
  name: "dsh-plan-files",
  version: "0.1.0",
  repository: { url: "git+https://github.com/paigeman/dsh-plan-files.git" },
};

test("publishing requires matching immutable tag and repository identities", () => {
  const input = {
    tag: "v0.1.0",
    ref: "refs/tags/v0.1.0",
    dryRun: false,
    repository: "paigeman/dsh-plan-files",
  };
  assert.equal(releaseInfo(pkg, input).distTag, "latest");
  assert.throws(() => releaseInfo(pkg, { ...input, tag: "v0.1.1" }), /tag/);
  assert.throws(
    () => releaseInfo(pkg, { ...input, ref: "refs/heads/main" }),
    /existing version tag/,
  );
  assert.throws(() => releaseInfo(pkg, { ...input, repository: "other/project" }), /identity/);
  assert.throws(() => releaseInfo({ ...pkg, private: true }, input), /local\/private/);
});

test("prereleases use next while branch dry runs cannot authorize publication", () => {
  assert.equal(releaseInfo({ ...pkg, version: "0.2.0-rc.1" }).distTag, "next");
  assert.equal(releaseInfo(pkg, { ref: "refs/heads/main", dryRun: true }).dryRun, true);
  assert.throws(() => releaseInfo({ ...pkg, version: "0.1.0+build" }), /version/);
  assert.throws(() => releaseInfo({ ...pkg, version: "v0.1.0" }), /version/);
});

test("registry errors and conflicting published versions fail instead of publishing again", () => {
  const artifact = { name: pkg.name, version: pkg.version, integrity: "sha512-fixture" };
  assert.equal(publishedState(404, {}, artifact), "missing");
  assert.equal(
    publishedState(200, { ...pkg, dist: { integrity: artifact.integrity } }, artifact),
    "identical",
  );
  assert.throws(() => publishedState(503, {}, artifact), /503/);
  assert.throws(
    () => publishedState(200, { ...pkg, dist: { integrity: "other" } }, artifact),
    /different content/,
  );
});

test("downloaded release artifacts reject identity and checksum mismatches", () => {
  const directory = mkdtempSync(join(artifactDirectory(resolve(".agent-tmp")), "release-test-"));
  const bytes = Buffer.from("synthetic archive bytes");
  const filename = "dsh-plan-files-0.1.0.tgz";
  const record = {
    name: pkg.name,
    version: pkg.version,
    filename,
    sha256: digest(bytes, "sha256"),
    integrity: `sha512-${digest(bytes, "sha512", "base64")}`,
  };
  writeFileSync(join(directory, filename), bytes);
  writeFileSync(join(directory, "release.json"), JSON.stringify(record));
  writeFileSync(join(directory, "SHA256SUMS"), `${record.sha256}  ${filename}\n`);
  assert.equal(verifyArtifact(directory, pkg).filename, filename);
  assert.throws(() => verifyArtifact(directory, { ...pkg, version: "9.9.9" }), /identity/);
  writeFileSync(join(directory, filename), "tampered");
  assert.throws(() => verifyArtifact(directory, pkg), /checksum/);
});
