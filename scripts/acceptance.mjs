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
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout } from "node:timers/promises";
import { gte, satisfies, valid } from "semver";
import { artifactDirectory, controlPatch, writeJson, DEV_PACKAGE } from "./acceptance-control.mjs";
import { tuiAcceptance } from "./acceptance-tui.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = artifactDirectory(join(root, ".agent-tmp", "acceptance"));
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sourcePackage = () => JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tuiPackage = "@deepseek-harness-tui/dsh-tui";
const tuiEnv = { ...process.env, DSH_TUI_UPDATE_ENGINE: "0" };

function profileDirectory(profile = "desktop") {
  return join(resolve(process.env.DSH_HOME || join(homedir(), ".dsh")), "profiles", profile);
}

function developmentPatch() {
  return `- insert:\n    - id: plan-files-dev\n      name: "${DEV_PACKAGE}"\n      disabled: true\n      config:\n        plansDir: ${JSON.stringify(join(directory, "plans"))}\n`;
}

function developmentClient() {
  const source = readFileSync(join(root, "client.js"), "utf8");
  const id = `id: ${JSON.stringify(sourcePackage().name)},`;
  assert.equal(source.split(id).length, 2, "The client bundle must declare its package ID once.");
  return source.replace(id, `id: ${JSON.stringify(DEV_PACKAGE)},`);
}

function candidateCurrent() {
  try {
    const installed = join(profileDirectory(), "node_modules", DEV_PACKAGE);
    const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    const source = sourcePackage();
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
      JSON.stringify(pkg.dsh) === JSON.stringify(source.dsh) &&
      JSON.stringify(pkg.exports) === JSON.stringify(source.exports) &&
      readFileSync(join(installed, "client.js"), "utf8") === developmentClient() &&
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
  const pkg = sourcePackage();
  pkg.name = DEV_PACKAGE;
  pkg.version += `-dev.${Date.now()}`;
  pkg.private = true;
  for (const key of ["scripts", "devDependencies"]) delete pkg[key];
  writeJson(join(source, "package.json"), pkg);
  writeFileSync(join(source, "client.js"), developmentClient());
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
  const cli =
    process.env.DSH_DESKTOP_CLI ??
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";
  assert(existsSync(cli), "Set DSH_DESKTOP_CLI to the Desktop bundled CLI.");
  const version = spawnSync(cli, ["--version"], { cwd: root, encoding: "utf8" });
  if (version.error) throw version.error;
  assert.equal(version.status, 0, version.stderr);
  const dsh = version.stdout.trim();
  assert(
    satisfies(dsh, sourcePackage().engines.dsh),
    `DSH Desktop ${dsh} is outside the plugin test matrix.`,
  );
  console.log(`Desktop bundled DSH ${dsh}`);
  if (!candidateCurrent()) install(cli);
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

function install(cli) {
  const candidate = prepare();
  assert.equal(hash(candidate.artifact), candidate.sha256);
  const manifest = spawnSync("tar", ["-xOzf", candidate.artifact, "package/package.json"], {
    encoding: "utf8",
  });
  if (manifest.error) throw manifest.error;
  assert.equal(manifest.status, 0, manifest.stderr);
  const pkg = JSON.parse(manifest.stdout);
  assert.equal(pkg.name, DEV_PACKAGE);
  assert.equal(pkg.version, candidate.version);
  assert.equal(pkg.private, true);
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
  if (installed.error) throw installed.error;
  assert.equal(installed.status, 0, installed.stderr);
  assert(candidateCurrent(), "Desktop did not install the verified development package.");
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

function tuiFrontend() {
  const frontend = realpathSync(
    process.env.DSH_TUI_PACKAGE ??
      join(profileDirectory("dsh-tui"), "node_modules", tuiPackage, "package.json"),
  );
  const pkg = JSON.parse(readFileSync(frontend, "utf8"));
  assert.equal(pkg.name, tuiPackage);
  return { frontend: dirname(frontend), pkg };
}

function tuiSupports(pkg, dsh) {
  const range = pkg.peerDependencies?.["@deepseek-ai/dsh-app-boot"];
  assert(range, `TUI ${pkg.version} does not declare a DSH app-boot peer range.`);
  return satisfies(dsh, range);
}

function tuiCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: tuiEnv,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr.trim() || result.stdout.trim());
  return result.stdout.trim();
}

function tuiConfig(cli = process.env.DSH_CLI ?? "dsh", expected) {
  const { frontend, pkg } = tuiFrontend();
  const dsh = tuiCommand(cli, ["--version"]);
  const versions = { dsh, tui: pkg.version };
  if (expected) assert.deepEqual(versions, expected, "TUI upgrade selected unexpected versions.");
  assert(
    satisfies(dsh, sourcePackage().engines.dsh),
    `DSH ${dsh} is outside the plugin test matrix.`,
  );
  assert(tuiSupports(pkg, dsh), `TUI ${pkg.version} does not support DSH ${dsh}.`);
  const candidate = prepare();
  const source = join(dirname(candidate.artifact), "package", "index.js");
  const overlay = join(dirname(candidate.artifact), "tui-compatibility.patch.yml");
  const module = pathToFileURL(source).href;
  writeFileSync(
    overlay,
    `- insert:\n    - id: plan-files-dev-compatibility\n      name: ${JSON.stringify(module)}\n      config:\n        plansDir: ${JSON.stringify(join(directory, "tui-plans"))}\n`,
  );
  const composed = tuiCommand(cli, ["--profile", "dsh-tui", "--patch", overlay, "--dump-config"]);
  assert(composed.includes(module), "Development component is absent from the composed profile.");
  for (const id of ["plan-mode", "system-prompt", "fs-sandbox"]) {
    assert(
      new RegExp(`id: ["']?${id}["']?\\s*$`, "m").test(composed),
      `${id} is absent from the TUI profile.`,
    );
  }
  const result = {
    passed: true,
    kind: "boot-free profile composition",
    ...versions,
    package: candidate.name,
    overlay,
  };
  writeJson(join(directory, "tui-compatibility.json"), result);
  console.log(JSON.stringify(result, null, 2));
  return { cli, frontend, candidate, versions };
}

async function upgradeTui(args) {
  const [dsh, tui] = args;
  assert(
    args.length === 2 && valid(dsh) === dsh && valid(tui) === tui,
    "Specify exact DSH and TUI versions.",
  );
  assert(
    satisfies(dsh, sourcePackage().engines.dsh),
    `DSH ${dsh} is outside the plugin test matrix.`,
  );
  assert(!process.env.DSH_TUI_PACKAGE, "TUI upgrade targets the installed dsh-tui profile.");
  const tool = `npm:@deepseek-ai/dsh@${dsh}`;
  const currentCli = tuiCommand("mise", ["which", "dsh"]);
  const currentDsh = tuiCommand(currentCli, ["--version"]);
  const current = tuiFrontend().pkg;
  assert(
    gte(dsh, currentDsh) && gte(tui, current.version),
    "TUI acceptance upgrades require nondecreasing versions.",
  );
  const target =
    current.version === tui
      ? current
      : JSON.parse(
          tuiCommand(process.execPath, [
            process.env.npm_execpath,
            "view",
            `${tuiPackage}@${tui}`,
            "--json",
            "--registry=https://registry.npmjs.org",
            "--cache",
            join(directory, "npm-cache"),
          ]),
        );
  assert(target.name === tuiPackage && target.version === tui, "Unexpected registry manifest.");
  assert(tuiSupports(target, dsh), `TUI ${tui} does not support target DSH ${dsh}.`);
  const frontendFirst = tuiSupports(target, currentDsh);
  assert(
    frontendFirst || tuiSupports(current, dsh),
    "Neither upgrade order preserves a compatible pair. Select an intermediate TUI and DSH pair.",
  );

  const updateFrontend = (cli) => {
    if (current.version === tui) return;
    console.log(`Updating the dsh-tui profile from ${current.version} to ${tui}`);
    tuiCommand(cli, [
      "plugin",
      "--profile",
      "dsh-tui",
      "add",
      `${tuiPackage}@${tui}`,
      "--ignore-scripts",
    ]);
    assert.equal(tuiFrontend().pkg.version, tui, "The dsh-tui profile did not update.");
  };
  if (frontendFirst) updateFrontend(currentCli);
  if (dsh !== currentDsh) {
    console.log(`Installing DSH ${dsh} with mise (currently ${currentDsh})`);
    tuiCommand("mise", ["install", tool]);
  }
  const cli = tuiCommand("mise", ["which", "dsh", `--tool=${tool}`]);
  assert.equal(tuiCommand(cli, ["--version"]), dsh, "mise selected the wrong DSH binary.");
  if (!frontendFirst) updateFrontend(cli);
  return tuiAcceptance({ root, ...tuiConfig(cli, { dsh, tui }) });
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
  else if (command === "tui") await tuiAcceptance({ root, ...tuiConfig() });
  else if (command === "tui-upgrade") await upgradeTui(process.argv.slice(3));
  else if (command === "tui-config") tuiConfig();
  else
    throw new Error(
      "Use npm run acceptance -- prepare | connect | status | off | run | desktop | tui | tui-upgrade | tui-config.",
    );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
