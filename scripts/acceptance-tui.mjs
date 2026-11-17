import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { homedir } from "node:os";
import { artifactDirectory, writeJson } from "./acceptance-control.mjs";

// Python's standard library supplies the PTY without a native npm dependency.
const ptyBridge = String.raw`
import errno, fcntl, os, pty, selectors, signal, struct, subprocess, sys, termios

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 48, 120, 0, 0))
process = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
selector = selectors.DefaultSelector()
selector.register(master, selectors.EVENT_READ)
selector.register(sys.stdin.buffer, selectors.EVENT_READ)

def stop(signum, frame):
    raise SystemExit(128 + signum)

signal.signal(signal.SIGTERM, stop)
try:
    finished = False
    while not finished:
        for key, events in selector.select(timeout=0.2):
            if key.fileobj == master:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    data = b""
                if not data:
                    finished = True
                    break
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
            else:
                data = os.read(sys.stdin.fileno(), 65536)
                if not data:
                    finished = True
                    break
                os.write(master, data)
finally:
    selector.close()
    os.close(master)
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
    process.wait()
sys.exit(process.returncode)
`;

function observation(directory) {
  const path = join(directory, "observation.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

function renderedIncludes(output, text) {
  return stripVTControlCharacters(output).replace(/\s/g, "").includes(text.replace(/\s/g, ""));
}

function cleanupSessions(directory, project) {
  const state = observation(directory);
  const sessions = join(directory, "sessions");
  const files = readdirSync(sessions, { recursive: true }).filter((file) =>
    file.endsWith(".jsonl"),
  );
  const items = files.map((file) => {
    const path = join(sessions, file);
    const header = JSON.parse(readFileSync(path, "utf8").split("\n", 1)[0]);
    return { id: header.id, cwd: header.cwd, path };
  });
  const removed = items.map((item) => {
    assert.equal(item.id, state.sessionId, "Test session identity differs.");
    assert.equal(item.cwd, project, "Test session project differs.");
    const root = realpathSync(sessions);
    const path = realpathSync(item.path);
    assert(!relative(root, path).startsWith(".."), "Test session escaped its isolated store.");
    assert(!lstatSync(item.path).isSymbolicLink());
    assert(lstatSync(path).isFile());
    unlinkSync(path);
    assert(!existsSync(path));
    return { sessionId: item.id, deleted: true };
  });
  assert.equal(
    readdirSync(sessions, { recursive: true }).filter((file) => file.endsWith(".jsonl")).length,
    0,
  );
  if (state.sessionId && removed.length === 0)
    return [{ sessionId: state.sessionId, deleted: true, materialized: false }];
  return removed;
}

export async function tuiAcceptance({ root, frontend, candidate, cli = "dsh" }) {
  assert(
    ["darwin", "linux"].includes(process.platform),
    "TUI PTY acceptance requires macOS or Linux.",
  );
  const directory = artifactDirectory(mkdtempSync(join(root, ".agent-tmp", "tui-")));
  const project = artifactDirectory(join(directory, "project"));
  const data = artifactDirectory(join(directory, "u"));
  writeJson(join(data, "home.json"), { seen: true });
  writeJson(join(data, "onboarding.json"), { completed: true, version: 1 });
  const sessions = artifactDirectory(join(directory, "sessions"));
  const plans = join(directory, "plans");
  const initialized = spawnSync("git", ["init", "--quiet", project], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);

  const originalPaths = join(frontend, "lib/types/utils/paths.js");
  const isolatedPaths = join(directory, "paths.mjs");
  const source = readFileSync(originalPaths, "utf8");
  const declaration = "export const DATA_DIR = join(homeDir(), '.dsh-tui');";
  assert.equal(source.split(declaration).length, 2, "Unsupported TUI data-directory adapter.");
  writeFileSync(
    isolatedPaths,
    source.replace(declaration, `export const DATA_DIR = ${JSON.stringify(data)};`),
  );
  const preload = join(directory, "isolate.mjs");
  writeFileSync(
    preload,
    `import { registerHooks } from 'node:module';\nregisterHooks({ resolve(specifier, context, next) {\n  const result = next(specifier, context);\n  return result.url === ${JSON.stringify(pathToFileURL(originalPaths).href)} ? { ...result, url: ${JSON.stringify(pathToFileURL(isolatedPaths).href)} } : result;\n} });\n`,
  );
  const overlay = join(directory, "profile.patch.yml");
  const module = pathToFileURL(join(dirname(candidate.artifact), "package/index.js")).href;
  const control = pathToFileURL(join(root, "scripts/acceptance-tui-control.mjs")).href;
  const config = {
    cwd: project,
    preset: "standard",
    lang: "en",
    fullscreen: true,
    launchpad: false,
    terminalImages: false,
    taskNotifications: "off",
    whale: false,
    whaleIdle: false,
  };
  try {
    const route = JSON.parse(readFileSync(join(homedir(), ".dsh-tui", "model.json"), "utf8"));
    if (typeof route.provider === "string" && typeof route.model === "string") {
      config.provider = route.provider;
      config.model = route.model;
    }
  } catch {
    // Without a saved TUI route, the native DSH default selects the model.
  }
  writeFileSync(
    overlay,
    `- id: session-persistence-jsonl\n  config:\n    root: ${JSON.stringify(sessions)}\n    compression: none\n- id: storage-json\n  config:\n    root: ${JSON.stringify(join(directory, "storages"))}\n- id: dsh-tui-storage-json\n  config:\n    root: ${JSON.stringify(join(directory, "storages"))}\n- id: dsh-tui\n  inject: [workspaceRegistry, agents, tuiWorkspaces, tuiScenes, tuiPanels, tuiDialogs, tuiStatus, tuiShortcuts, tuiRenderers, tuiThemes, planFilesTuiAcceptance]\n  config: ${JSON.stringify(config)}\n- insert:\n    - id: plan-files-dev-tui-acceptance\n      name: ${JSON.stringify(module)}\n      config:\n        plansDir: ${JSON.stringify(plans)}\n    - id: plan-files-tui-acceptance-dev\n      name: ${JSON.stringify(control)}\n      config:\n        directory: ${JSON.stringify(directory)}\n        project: ${JSON.stringify(project)}\n`,
  );

  const raw = join(directory, "terminal.log");
  let terminal = "";
  let exited = false;
  let exitCode;
  const env = {
    ...process.env,
    DSH_TUI_UPDATE_ENGINE: "0",
    DSH_TUI_SESSION_ROOT: sessions,
    DSH_TUI_PRESET: "standard",
    TERM: "xterm-256color",
    NODE_OPTIONS:
      `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`.trim(),
  };
  const child = spawn(
    "python3",
    ["-u", "-c", ptyBridge, cli, "--profile", "dsh-tui", "--patch", overlay],
    { cwd: project, env },
  );
  const exit = new Promise((resolveExit) =>
    child.on("close", (code) => {
      exited = true;
      exitCode = code;
      resolveExit();
    }),
  );
  child.on("error", (error) => {
    terminal += `\n${error.message}\n`;
  });
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder("utf8");
    stream.on("data", (chunk) => {
      terminal += decoder.write(chunk);
      appendFileSync(raw, chunk);
    });
  }
  const waitFor = async (condition, label, timeout = 90000) => {
    const until = Date.now() + timeout;
    for (;;) {
      const state = observation(directory);
      if (condition(state)) return state;
      const ending = state.turns?.at(-1);
      if (ending?.kind === "error") throw new Error(ending.error.message);
      assert(!exited, `TUI exited during ${label}. Inspect ${raw}.`);
      assert(Date.now() < until, `Timed out during ${label}. Inspect ${raw}.`);
      await setTimeout(100);
    }
  };
  const paste = (text) => child.stdin.write(`\x1b[200~${text}\x1b[201~`);
  const cases = [];
  let failure;
  let cleanup = [];
  try {
    await waitFor(
      (state) =>
        state.sessionId &&
        state.status === "idle" &&
        stripVTControlCharacters(terminal).includes("❯"),
      "interactive composer",
    );
    paste("/plan");
    child.stdin.write("\r");
    await waitFor(
      () => stripVTControlCharacters(terminal).includes("Enter to confirm"),
      "native /plan picker",
      15000,
    );
    const pickerStart = terminal.length;
    child.stdin.write("\x1b[A");
    await waitFor(
      () => stripVTControlCharacters(terminal.slice(pickerStart)).includes("On"),
      "Plan Mode On selection",
      15000,
    );
    child.stdin.write("\r");
    await waitFor(
      (state) =>
        state.sessionId && state.modes.some((mode) => mode.type === "plan/mode" && mode.active),
      "native /plan entry",
      15000,
    );
    let initial = `# TUI acceptance\n\n## Scope\nPreserve ${randomUUID()}.\n\n## Verification\nRun unit tests.\n`;
    let sessionPlanPath;
    for (const [cycle, entry] of ["/plan", "Shift+Tab"].entries()) {
      if (cycle > 0) {
        child.stdin.write("\x1b[Z");
        await waitFor(
          (state) =>
            state.modes.filter((mode) => mode.type === "plan/mode" && mode.active).length ===
            cycle + 1,
          "Shift+Tab plan entry",
        );
        const state = observation(directory);
        assert.equal(
          state.modes.findLast((mode) => mode.type === "sandbox/mode")?.mode,
          "read-only",
        );
      }
      console.log(`TUI ${entry} plan review and feedback`);
      const oldSentence =
        cycle === 0 ? "Run unit tests." : "Run unit and native integration tests.";
      const newSentence =
        cycle === 0
          ? "Run unit and native integration tests."
          : "Run unit, native integration, and TUI tests.";
      const revised = initial.replace(oldSentence, newSentence);
      const feedback = `Please update Verification to say "${newSentence}" Keep the other text unchanged and submit the same file again.`;
      const start = terminal.length;
      const instruction =
        cycle === 0
          ? `Create and save this exact Markdown with plan_file, title tui-acceptance. The Markdown is encoded as this JSON string, decode its escapes before saving. ${JSON.stringify(initial)}`
          : "Read this session's existing plan with plan_file and submit its current content for review.";
      paste(
        `Integration acceptance. ${instruction} Call native exit_plan_mode. After feedback, change only the requested sentence in the same file and submit again. After approval, stop without implementing.`,
      );
      child.stdin.write("\r");
      await waitFor(
        (state) =>
          state.reviews.length === cycle * 2 + 1 &&
          state.reviews.at(-1).open &&
          renderedIncludes(terminal.slice(start), "Keep planning"),
        "first visible Plan Review",
      );
      let state = observation(directory);
      assert.equal(state.reviews.at(-1).detail, initial);
      const saved = state.records.at(-1);
      assert(saved);
      if (cycle === 0) sessionPlanPath = saved.path;
      assert.equal(saved.path, sessionPlanPath, "Plan Mode re-entry allocated a different file.");
      assert.equal(readFileSync(saved.path, "utf8"), initial);
      paste(feedback);
      await waitFor(
        () => renderedIncludes(terminal.slice(start), "Please update Verification"),
        "visible feedback input",
      );
      const secondStart = terminal.length;
      child.stdin.write("\r");
      await waitFor(
        (state) =>
          state.reviews.length === cycle * 2 + 2 &&
          state.reviews.at(-1).open &&
          renderedIncludes(terminal.slice(secondStart), "Keep planning"),
        "revised native Plan Review",
      );
      state = observation(directory);
      assert.equal(state.reviews.at(-2).answer.custom, feedback);
      assert.deepEqual(state.reviews.at(-2).answer.selected, ["Keep planning"]);
      assert.equal(state.reviews.at(-1).detail, revised);
      assert.equal(state.records.at(-1).path, saved.path);
      assert.deepEqual(readFileSync(saved.path), Buffer.from(revised));
      child.stdin.write("1");
      await waitFor(
        (state) =>
          state.status === "idle" &&
          state.reviews.at(-1)?.answer?.selected[0] === "Approve" &&
          state.modes.findLast((mode) => mode.type === "plan/mode")?.active === false,
        "native approval and Plan Mode exit",
      );
      assert.equal(readFileSync(saved.path, "utf8"), revised);
      cases.push({
        entry,
        savedFile: saved.path,
        exactRevision: true,
        nativeApproval: true,
        planRetained: true,
      });
      initial = revised;
    }
    assert.equal(new Set(observation(directory).records.map((record) => record.path)).size, 1);
    const exitStart = terminal.length;
    child.stdin.write("\x04");
    await waitFor(
      () => renderedIncludes(terminal.slice(exitStart), "Press Ctrl+C"),
      "native exit confirmation",
      5000,
    );
    child.stdin.write("\x04");
    await Promise.race([exit, setTimeout(15000)]);
    assert(exited && exitCode === 0, "TUI did not exit cleanly.");
  } catch (error) {
    failure = error;
  } finally {
    if (!exited) {
      child.stdin.write("\x03");
      child.stdin.end();
      await Promise.race([exit, setTimeout(20000)]);
      if (!exited) {
        child.kill("SIGTERM");
        await exit;
      }
    }
    try {
      cleanup = cleanupSessions(directory, project);
      if (observation(directory).sessionId)
        assert(cleanup.length > 0, "Test session cleanup has no persistence artifact.");
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], "TUI acceptance and cleanup failed.")
        : error;
    }
  }
  const report = join(directory, "report.json");
  const result = {
    status: failure ? "failed" : "passed",
    frontend: "dsh-TUI",
    versions: {
      dsh: "0.2.2-rc.3",
      tui: JSON.parse(readFileSync(join(frontend, "package.json"), "utf8")).version,
    },
    package: candidate.name,
    cases,
    cleanup,
    developmentPluginStopped: exited,
    exitCode,
    ...(failure ? { error: { message: failure.message, stack: failure.stack } } : {}),
    report,
  };
  writeJson(report, result);
  console.log(JSON.stringify(result, null, 2));
  if (failure) throw failure;
  return result;
}
