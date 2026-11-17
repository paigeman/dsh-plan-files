import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  cpSync,
  mkdirSync,
  lstatSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout } from "node:timers/promises";
import { artifactDirectory, controlPatch, writeJson, DEV_PACKAGE } from "./acceptance-control.mjs";
import { tuiAcceptance } from "./acceptance-tui.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = artifactDirectory(join(root, ".agent-tmp", "acceptance"));
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function profileDirectory() {
  return join(resolve(process.env.DSH_HOME || join(homedir(), ".dsh")), "profiles", "desktop");
}

function developmentPatch() {
  return `- insert:\n    - id: plan-files-dev\n      name: "${DEV_PACKAGE}"\n      disabled: true\n      config:\n        plansDir: ${JSON.stringify(join(directory, "plans"))}\n`;
}

function candidateCurrent() {
  try {
    const installed = join(profileDirectory(), "node_modules", DEV_PACKAGE);
    const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    const source = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const files = [
      "index.js",
      "README.md",
      "README.zh-CN.md",
      "LICENSE",
      ...readdirSync(join(root, "lib")).map((file) => `lib/${file}`),
    ];
    return (
      pkg.name === DEV_PACKAGE &&
      pkg.version.startsWith(`${source.version}-dev.`) &&
      JSON.stringify(pkg.engines) === JSON.stringify(source.engines) &&
      readFileSync(join(installed, "cordis.patch.yml"), "utf8") === developmentPatch() &&
      files.every((file) => hash(join(installed, file)) === hash(join(root, file))) &&
      ["en", "zh"].every((locale) => {
        const expected = JSON.parse(readFileSync(join(root, "locale", `${locale}.json`), "utf8"));
        expected.meta.title += " [DEV]";
        return (
          JSON.stringify(
            JSON.parse(readFileSync(join(installed, "locale", `${locale}.json`), "utf8")),
          ) === JSON.stringify(expected)
        );
      })
    );
  } catch {
    return false;
  }
}

function readyCurrent(revision = hash(join(root, "scripts/acceptance-control.mjs"))) {
  try {
    const ready = JSON.parse(readFileSync(join(directory, "ready.json"), "utf8"));
    process.kill(ready.pid, 0);
    return ready.revision === revision && !ready.stopped;
  } catch {
    return false;
  }
}

function prepare() {
  const build = artifactDirectory(join(directory, "builds", randomUUID()));
  const source = join(build, "package");
  mkdirSync(source);
  for (const file of ["index.js", "lib", "locale", "README.md", "README.zh-CN.md", "LICENSE"])
    cpSync(join(root, file), join(source, file), { recursive: true });
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  pkg.name = DEV_PACKAGE;
  pkg.version += `-dev.${Date.now()}`;
  pkg.private = true;
  for (const key of ["scripts", "devDependencies"]) delete pkg[key];
  writeJson(join(source, "package.json"), pkg);
  writeFileSync(join(source, "cordis.patch.yml"), developmentPatch());
  for (const locale of ["en", "zh"]) {
    const path = join(source, "locale", `${locale}.json`);
    const value = JSON.parse(readFileSync(path, "utf8"));
    value.meta.title += " [DEV]";
    writeJson(path, value);
  }
  assert.equal(JSON.parse(readFileSync(join(source, "package.json"), "utf8")).name, DEV_PACKAGE);
  assert(process.env.npm_execpath, "Run acceptance through npm.");
  const packed = spawnSync(
    process.execPath,
    [process.env.npm_execpath, "pack", "--ignore-scripts", "--json", "--pack-destination", build],
    {
      cwd: source,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: join(directory, "npm-cache") },
    },
  );
  assert.equal(packed.status, 0, packed.stderr);
  const artifact = join(build, JSON.parse(packed.stdout)[0].filename);
  const candidate = { name: DEV_PACKAGE, version: pkg.version, artifact, sha256: hash(artifact) };
  writeJson(join(directory, "candidate.json"), candidate);
  return candidate;
}

async function request(op) {
  assert(
    readyCurrent(),
    "The acceptance component is stale or unavailable. Run acceptance -- connect.",
  );
  if (op === "test")
    assert(candidateCurrent(), "The installed development package is stale. Run test:desktop.");
  const id = randomUUID();
  const output = join(directory, "reports", `${id}.json`);
  writeJson(join(directory, "requests", `${id}.json`), { id, op });
  const deadline = Date.now() + (op === "test" ? 270000 : 30000);
  let phase;
  while (Date.now() < deadline) {
    if (existsSync(output)) {
      const result = JSON.parse(readFileSync(output, "utf8"));
      if (result.phase !== phase) {
        phase = result.phase;
        if (phase) console.log(phase);
      }
      if (result.status !== "running") {
        console.log(JSON.stringify({ ...result, report: output }, null, 2));
        assert.equal(result.status, "passed", result.error?.message);
        return;
      }
    }
    await setTimeout(500);
  }
  throw new Error(`Acceptance timed out. Inspect ${output} before retrying.`);
}

async function desktop() {
  if (!candidateCurrent()) install();
  if (!readyCurrent()) await connect();
  return runDesktop();
}

async function runDesktop() {
  try {
    return await request("test");
  } finally {
    try {
      await request("off");
    } finally {
      await disconnect();
    }
  }
}

function install() {
  const cli =
    process.env.DSH_DESKTOP_CLI ??
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";
  assert(existsSync(cli), "Set DSH_DESKTOP_CLI to the Desktop bundled CLI.");
  const candidate = prepare();
  const installed = spawnSync(
    cli,
    ["plugin", "--profile", "desktop", "add", `file:${candidate.artifact}`, "--ignore-scripts"],
    { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  writeJson(join(directory, "install.json"), {
    exitCode: installed.status,
    stdout: installed.stdout,
    stderr: installed.stderr,
  });
  assert.equal(installed.status, 0, installed.stderr);
}

function configureControl(disabled) {
  const path = join(profileDirectory(), "cordis.patch.yml");
  assert(!lstatSync(path).isSymbolicLink());
  const previous = readFileSync(path, "utf8");
  artifactDirectory(join(directory, "profile-backups"));
  writeFileSync(join(directory, "profile-backups", `${randomUUID()}.yml`), previous, {
    mode: 0o600,
  });
  const component = join(root, "scripts/acceptance-control.mjs");
  const revision = hash(component);
  const next = controlPatch(
    previous,
    `${pathToFileURL(component).href}?revision=${revision}`,
    directory,
    revision,
    disabled,
  );
  assert.equal(readFileSync(path, "utf8"), previous, "Profile changed while preparing acceptance.");
  if (next !== previous) writeFileSync(path, next);
  return revision;
}

async function connect() {
  const revision = configureControl(false);
  const deadline = Date.now() + 30000;
  for (;;) {
    if (readyCurrent(revision)) break;
    assert(
      Date.now() < deadline,
      "Desktop has not loaded the current acceptance component. Check its plugin diagnostics.",
    );
    await setTimeout(500);
  }
  return request("status");
}

async function disconnect() {
  const revision = configureControl(true);
  const deadline = Date.now() + 15000;
  for (;;) {
    const ready = JSON.parse(readFileSync(join(directory, "ready.json"), "utf8"));
    if (ready.revision === revision && ready.stopped) return;
    assert(Date.now() < deadline, "Development acceptance component did not stop.");
    await setTimeout(100);
  }
}

function tuiConfig() {
  const frontend =
    process.env.DSH_TUI_PACKAGE ??
    join(
      homedir(),
      ".dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/package.json",
    );
  const pkg = JSON.parse(readFileSync(frontend, "utf8"));
  assert.equal(pkg.name, "@deepseek-harness-tui/dsh-tui");
  const candidate = prepare();
  const source = join(dirname(candidate.artifact), "package", "index.js");
  const overlay = join(dirname(candidate.artifact), "tui-compatibility.patch.yml");
  const module = pathToFileURL(source).href;
  writeFileSync(
    overlay,
    `- insert:\n    - id: plan-files-dev-compatibility\n      name: ${JSON.stringify(module)}\n      config:\n        plansDir: ${JSON.stringify(join(directory, "tui-plans"))}\n`,
  );
  const env = { ...process.env, DSH_TUI_UPDATE_ENGINE: "0" };
  const version = spawnSync(process.env.DSH_CLI ?? "dsh", ["--version"], { encoding: "utf8", env });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), "0.2.2-rc.3");
  const composed = spawnSync(
    process.env.DSH_CLI ?? "dsh",
    ["--profile", "dsh-tui", "--patch", overlay, "--dump-config"],
    { encoding: "utf8", env, maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(composed.status, 0, composed.stderr);
  assert(
    composed.stdout.includes(module),
    "Development component is absent from the composed profile.",
  );
  for (const id of ["plan-mode", "system-prompt", "fs-sandbox"]) {
    assert(
      new RegExp(`id: ["']?${id}["']?\\s*$`, "m").test(composed.stdout),
      `${id} is absent from the TUI profile.`,
    );
  }
  const result = {
    passed: true,
    kind: "boot-free profile composition",
    dsh: version.stdout.trim(),
    tui: pkg.version,
    package: candidate.name,
    overlay,
  };
  writeJson(join(directory, "tui-compatibility.json"), result);
  console.log(JSON.stringify(result, null, 2));
  return { frontend: dirname(frontend), candidate };
}

async function tui() {
  return tuiAcceptance({ root, ...tuiConfig(), cli: process.env.DSH_CLI ?? "dsh" });
}

const command = process.argv[2];
try {
  if (command === "prepare") console.log(JSON.stringify(prepare(), null, 2));
  else if (command === "connect") await connect();
  else if (command === "off") {
    if (!readyCurrent()) await connect();
    try {
      await request("off");
    } finally {
      await disconnect();
    }
  } else if (command === "status") await request("status");
  else if (command === "run") await runDesktop();
  else if (command === "desktop") await desktop();
  else if (command === "tui") await tui();
  else if (command === "tui-config") tuiConfig();
  else
    throw new Error(
      "Use npm run acceptance -- prepare | connect | status | off | run | desktop | tui | tui-config.",
    );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
