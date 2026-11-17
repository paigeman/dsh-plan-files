import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  realpathSync,
  unlinkSync,
  watch,
  renameSync,
} from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "plan-files-acceptance-control-dev";
export const inject = [
  "pluginManager",
  "sessionController",
  "agents",
  "tools",
  "llm",
  "loader",
  "sessionPersistence",
  "commands",
];
export const DEV_PACKAGE = "dsh-plan-files-dev";
export const STABLE_PACKAGE = "dsh-plan-files";

export function controlPatch(previous, component, directory, revision, disabled = false) {
  assert.equal(previous.split(begin).length, previous.split(end).length);
  assert(previous.split(begin).length <= 2, "Duplicate owned acceptance block.");
  // rc.3 retains the running module when only an entry's name changes.
  // A new revision therefore needs a new entry identity as well as a new URL.
  const block = `${begin}\n- insert:\n    - id: plan-files-acceptance-control-dev-${revision.slice(0, 12)}\n      name: ${JSON.stringify(component)}\n${disabled ? "      disabled: true\n" : ""}      config:\n        directory: ${JSON.stringify(directory)}\n${end}`;
  const start = previous.indexOf(begin);
  if (start < 0) return `${previous}${previous.endsWith("\n") ? "" : "\n"}${block}\n`;
  const finish = previous.indexOf(end, start);
  assert(finish > start, "Malformed owned acceptance block.");
  return previous.slice(0, start) + block + previous.slice(finish + end.length);
}

const begin = "# BEGIN dsh-plan-files development acceptance";
const end = "# END dsh-plan-files development acceptance";

export function artifactDirectory(path) {
  const absolute = resolve(path);
  const temporary = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".agent-tmp");
  assert(!existsSync(temporary) || !lstatSync(temporary).isSymbolicLink());
  const nested = relative(temporary, absolute);
  assert(
    !isAbsolute(nested) && !nested.startsWith(".."),
    "Acceptance output must stay under .agent-tmp.",
  );
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  assert(!lstatSync(absolute).isSymbolicLink(), "Refusing symlink acceptance directory.");
  const canonical = relative(realpathSync(temporary), realpathSync(absolute));
  assert(!isAbsolute(canonical) && !canonical.startsWith(".."));
  return absolute;
}

export function writeJson(path, value) {
  assert(!existsSync(path) || !lstatSync(path).isSymbolicLink(), "Refusing symlink output.");
  const pending = join(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(pending, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(pending, path);
}

function assertIdle(ctx, owned = new Set()) {
  assert(
    !ctx.agents.list().some((agent) => !owned.has(agent.id) && agent.status !== "idle"),
    "Other DSH conversations are running. Retry when they are idle.",
  );
}

async function entries(ctx) {
  return (await ctx.pluginManager.listPlugins())
    .filter((row) => [DEV_PACKAGE, STABLE_PACKAGE].includes(row.moduleName))
    .map(({ entryId, moduleName, enabled, fiberPhase, readOnlyReason }) => ({
      entryId,
      moduleName,
      enabled,
      fiberPhase,
      readOnlyReason,
    }));
}

async function setEnabled(ctx, entry, enabled) {
  const result = await ctx.pluginManager.setPluginEnabled(entry.entryId, enabled);
  assert.equal(result.application, "applied", "Plugin activation did not apply.");
}

async function restoreEntries(ctx, previous) {
  for (const entry of await entries(ctx)) {
    const wanted =
      entry.moduleName !== DEV_PACKAGE &&
      previous.some((prior) => prior.entryId === entry.entryId && prior.enabled);
    if (entry.enabled !== wanted) await setEnabled(ctx, entry, wanted);
  }
}

async function developmentOff(ctx) {
  const development = (await entries(ctx)).find((entry) => entry.moduleName === DEV_PACKAGE);
  if (development?.enabled) await setEnabled(ctx, development, false);
  const result = await ctx.pluginManager.setBundleEnabled(DEV_PACKAGE, false);
  assert.equal(result.application, "applied", "Development bundle did not stop.");
  const bundle = (await ctx.pluginManager.listBundles()).find(
    (entry) => entry.name === DEV_PACKAGE,
  );
  assert.equal(bundle?.enabled, false, "Development bundle remains enabled.");
  return { bundleEnabled: false, componentEnabled: false };
}

// The current DSH API has no deletion method. This adapter owns the AgentHandle,
// releases its writer, then removes only that exact test session's JSONL artifact.
export async function disposeTestSession(ctx, owned) {
  const persistence =
    owned.handle.agent.ctx.get("sessionPersistence") ?? ctx.get("sessionPersistence");
  await owned.handle.dispose();
  assert.equal(ctx.agents.get(owned.id), undefined, "Test Agent did not stop.");
  const snapshot = await persistence.stat(owned.id);
  if (snapshot) {
    assert.equal(snapshot.header.id, owned.id);
    assert.equal(snapshot.header.cwd, owned.project);
    assert.equal(snapshot.location?.kind, "jsonl", "Unsupported acceptance cleanup backend.");
    const path = snapshot.location.path;
    assert.equal(lstatSync(path).isSymbolicLink(), false);
    assert.equal(lstatSync(path).isFile(), true);
    assert.equal(ctx.agents.get(owned.id), undefined);
    unlinkSync(path);
    assert.equal(
      await persistence.stat(owned.id),
      undefined,
      "Test session remains in persistence.",
    );
  }
  ctx.emit("api-session/removed", owned.id);
  const listed = await ctx.sessionController.list({}, AbortSignal.timeout(15000));
  assert(
    !JSON.stringify(listed).includes(owned.id),
    "Test session remains in the DSH conversation list.",
  );
  return { sessionId: owned.id, deleted: true };
}

async function acceptance(ctx, directory, signal, progress, ownedSessions, reviewed) {
  assertIdle(ctx);
  const before = await entries(ctx);
  const cases = [];
  const cleanup = [];
  const errors = [];
  let failed;
  try {
    const selectedBundle = await ctx.pluginManager.setBundleEnabled(DEV_PACKAGE, true);
    assert.equal(selectedBundle.application, "applied", "Development bundle did not activate.");
    const development = (await entries(ctx)).find((entry) => entry.moduleName === DEV_PACKAGE);
    assert(development && !development.readOnlyReason, "Install the development package first.");
    for (const entry of before.filter((entry) => entry.enabled))
      await setEnabled(ctx, entry, false);
    await setEnabled(ctx, development, true);
    const selected = await entries(ctx);
    assert.equal(selected.filter((entry) => entry.enabled).length, 1);
    assert.equal(selected.find((entry) => entry.enabled).moduleName, DEV_PACKAGE);
    const component = [...ctx.loader.entries()].find((entry) => entry.options.name === DEV_PACKAGE);
    assert(component, "Development component is missing.");
    assert.equal(component.options.id, "plan-files-dev");

    // Use the serving Host's own preset/model composition and retain the returned
    // lifecycle capability. These rc.3 adapter methods are checked before use.
    const composer = ctx.sessionController.agents;
    assert.equal(typeof composer?.composeAgent, "function", "Unsupported DSH acceptance adapter.");
    assert.equal(typeof composer.agentOptions, "function", "Unsupported DSH model adapter.");
    const project = artifactDirectory(join(directory, "project"));
    execFileSync("git", ["init", "--quiet", project], { stdio: "pipe" });
    for (const preset of ["standard", "ptc"]) {
      const composition = await composer.composeAgent(preset);
      const id = `session-${randomUUID()}`;
      const handle = await ctx.agents.create({
        sessionId: id,
        meta: {
          cwd: project,
          ...(composition.agentPreset ? { agentPreset: composition.agentPreset } : {}),
        },
        agentOptions: composer.agentOptions(),
        setup: composition.setup,
        signal,
      });
      const owned = { id, project, handle };
      ownedSessions.set(id, owned);
      writeJson(
        join(directory, "sessions.json"),
        [...ownedSessions.values()].map(({ id, project }) => ({ id, project })),
      );
      const agent = handle.agent;
      agent.ctx.tools.restrict({ allow: ["plan_file", "exit_plan_mode"] });
      await ctx.sessionController.rename({
        sessionId: id,
        title: `[DEV] Plan Files integration acceptance (${preset})`,
      });
      const entered = await ctx.commands.execute(agent, "/plan", [], signal);
      assert.equal(entered?.result.kind, "success", "Native /plan failed.");
      const probe = randomUUID();
      const initial = `# Acceptance plan\n\n## Scope\nPreserve ${probe}.\n\n## Verification\nRun unit tests.\n`;
      const revised = initial.replace("Run unit tests.", "Run unit and native integration tests.");
      const review = { initial, revised, phase: 0, paths: new Set() };
      reviewed.set(id, review);
      const stop = ctx.on("session/event", (session, event) => {
        if (session.id !== id) return;
        const message =
          event.type === "tool/ptc-dispatch" && event.data.name === "plan_file"
            ? event.data
            : event.type === "tool/result"
              ? event.data.message
              : undefined;
        if (!message || message.isError) return;
        for (const block of message.content ?? []) {
          if (block.type !== "text") continue;
          try {
            const value = JSON.parse(block.text);
            if (value.protocol === "dsh-plan-files/1") review.paths.add(value.path);
          } catch {
            /* Native review receipts are ordinary text. */
          }
        }
      });
      try {
        progress({ phase: `${preset} native review and natural-language revision`, sessionId: id });
        const prompt = async (text) => {
          await ctx.sessionController.prompt(
            {
              requestId: randomUUID(),
              sessionId: id,
              mode: "queue",
              content: [{ type: "text", text }],
              clientTimeZone: "Asia/Shanghai",
            },
            signal,
          );
          for (;;) {
            const state = await ctx.sessionController.wait(
              { sessionId: id, timeoutMs: 10000, maxMessages: 5 },
              signal,
            );
            assert.notEqual(
              state.reason,
              "input-required",
              "Unexpected manual input during acceptance.",
            );
            if (state.reason === "idle") break;
          }
          const ending = agent.session
            .snapshotEvents()
            .findLast((event) => event.type === "turn/end");
          assert.notEqual(ending?.data.reason?.kind, "error", ending?.data.reason?.error?.message);
        };
        await prompt(
          `自动集成验收。用 plan_file 创建以下计划，逐字保存，title 为 acceptance。然后通过原生 exit_plan_mode 提交。收到用户反馈后只修改对应句子，保留其他字符。批准后只回复 DONE 并结束，不执行计划。\n\n${initial}`,
        );
        assert.equal(review.phase, 2, "The real model did not complete feedback and re-review.");
        assert.equal(review.paths.size, 1, "Feedback created a different plan file.");
        const path = [...review.paths][0];
        assert.equal(readFileSync(path, "utf8"), revised);
        const modes = agent.session.snapshotEvents().filter((event) => event.type === "plan/mode");
        assert.equal(modes.at(-1)?.data.active, false);
        cases.push({
          name: "real model creates a saved plan, revises it locally, and exits through native approval",
          preset,
          passed: true,
        });
        cases.push({
          name: "all text outside the requested revision is byte-identical",
          preset,
          passed: true,
        });
        cases.push({ name: "approved plan remains on disk", preset, passed: true, path });
        progress({ phase: `${preset} Plan Mode re-entry reuses the session plan`, cases });
        const reentered = await ctx.commands.execute(agent, "/plan", [], signal);
        assert.equal(reentered?.result.kind, "success", "Native /plan re-entry failed.");
        review.revised = revised.replace(
          "Run unit and native integration tests.",
          "Run unit, native integration, and Desktop tests.",
        );
        await prompt(
          '继续验收同一会话。先用 plan_file 读取已有计划，只把 Verification 中的句子改成 "Run unit, native integration, and Desktop tests."，其他字符保持原样，再通过原生 exit_plan_mode 提交。批准后只回复 DONE 并结束，不执行计划。',
        );
        assert.equal(review.phase, 3, "Re-entered planning did not reach native approval.");
        assert.equal(review.paths.size, 1, "Plan Mode re-entry allocated a different file.");
        assert.deepEqual(readFileSync(path), Buffer.from(review.revised));
        assert.equal(
          agent.session.snapshotEvents().findLast((event) => event.type === "plan/mode")?.data
            .active,
          false,
        );
        cases.push({
          name: "Plan Mode re-entry locally revises and approves the same session file",
          preset,
          passed: true,
          path,
        });
        progress({ cases });
      } finally {
        stop();
      }
    }
  } catch (error) {
    failed = error;
    progress({
      diagnostic: [...ownedSessions.values()].map(({ handle }) => ({
        status: handle.agent.status,
        events: handle.agent.session.snapshotEvents().map((event) => ({
          type: event.type,
          ...(event.type === "tool/call" ? { name: event.data.name } : {}),
          ...(["assistant/message", "tool/result"].includes(event.type) &&
          event.data.message?.content
            ? {
                text: event.data.message.content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("\n"),
              }
            : {}),
          ...(event.data.error ? { error: event.data.error } : {}),
          ...(event.type === "turn/end" ? { reason: event.data.reason } : {}),
        })),
      })),
    });
  } finally {
    reviewed.clear();
    for (const owned of ownedSessions.values()) {
      try {
        cleanup.push(await disposeTestSession(ctx, owned));
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      assertIdle(ctx);
      await restoreEntries(ctx, before);
      await developmentOff(ctx);
    } catch (error) {
      errors.push(error);
    }
    progress({ cleanup, restored: errors.length === 0, cases });
  }
  if (errors.length)
    throw new AggregateError(
      [...(failed ? [failed] : []), ...errors],
      "Acceptance cleanup or restoration failed.",
    );
  if (failed) throw failed;
  return { cases, cleanup, restored: true };
}

export function apply(ctx, config) {
  const directory = artifactDirectory(config.directory);
  const requests = artifactDirectory(join(directory, "requests"));
  const reports = artifactDirectory(join(directory, "reports"));
  const lifetime = new AbortController();
  const ownedSessions = new Map();
  const reviewed = new Map();
  let busy = false;
  let pending = false;
  ctx.on(
    "user-questions/request",
    (request, next) => {
      const spec = reviewed.get(request.agent?.id);
      if (!spec) return next();
      const question = request.questions.find(
        (question) => question.intent?.kind === "plan-review",
      );
      if (!question) return next();
      if (spec.phase === 0) {
        assert.equal(question.detail, spec.initial);
        spec.phase++;
        return {
          answers: [
            {
              id: question.id,
              selected: ["Keep planning"],
              custom:
                "只把 Verification 中的 Run unit tests. 改成 Run unit and native integration tests.，其他内容保持原样。请继续使用同一文件并再次提交原生审批。",
            },
          ],
        };
      }
      assert.equal(question.detail, spec.revised);
      spec.phase++;
      return { answers: [{ id: question.id, selected: [question.intent.approve] }] };
    },
    { prepend: true },
  );
  const scan = async () => {
    if (lifetime.signal.aborted) return;
    if (busy) {
      pending = true;
      return;
    }
    busy = true;
    try {
      for (const file of readdirSync(requests)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(file) || existsSync(join(reports, file))) continue;
        const path = join(requests, file);
        if (lstatSync(path).isSymbolicLink() || lstatSync(path).size > 4096) continue;
        const request = JSON.parse(readFileSync(path, "utf8"));
        assert.equal(`${request.id}.json`, file);
        const output = join(reports, file);
        const initial = { id: request.id, status: "running", startedAt: new Date().toISOString() };
        writeJson(output, initial);
        try {
          let value;
          if (request.op === "status")
            value = {
              entries: await entries(ctx),
              agents: ctx.agents.list().map(({ id, status }) => ({ id, status })),
            };
          else if (request.op === "test") {
            ownedSessions.clear();
            value = await acceptance(
              ctx,
              artifactDirectory(join(directory, "runs", request.id)),
              AbortSignal.any([lifetime.signal, AbortSignal.timeout(240000)]),
              (progress) =>
                writeJson(output, { ...JSON.parse(readFileSync(output, "utf8")), ...progress }),
              ownedSessions,
              reviewed,
            );
          } else if (request.op === "off") {
            if (
              (await entries(ctx)).some(
                (entry) => entry.moduleName === DEV_PACKAGE && entry.enabled,
              )
            )
              assertIdle(ctx);
            value = await developmentOff(ctx);
          } else throw new Error("Unknown acceptance operation.");
          writeJson(output, {
            ...JSON.parse(readFileSync(output, "utf8")),
            status: "passed",
            value,
            finishedAt: new Date().toISOString(),
          });
        } catch (error) {
          writeJson(output, {
            ...JSON.parse(readFileSync(output, "utf8")),
            status: "failed",
            error: {
              message: error.message,
              stack: error.stack,
              causes: error.errors?.map((error) => error.message),
            },
            finishedAt: new Date().toISOString(),
          });
        }
      }
    } finally {
      busy = false;
      if (pending) {
        pending = false;
        void scan().catch((error) => ctx.logger(name).warn(error.message));
      }
    }
  };
  const start = () => {
    const revision = new URL(import.meta.url).searchParams.get("revision");
    const watcher = watch(
      requests,
      () => void scan().catch((error) => ctx.logger(name).warn(error.message)),
    );
    ctx.effect(() => () => {
      lifetime.abort();
      watcher.close();
      const ready = JSON.parse(readFileSync(join(directory, "ready.json"), "utf8"));
      if (ready.pid === process.pid && ready.revision === revision)
        writeJson(join(directory, "ready.json"), { ...ready, stopped: true });
    });
    writeJson(join(directory, "ready.json"), {
      pid: process.pid,
      revision,
    });
    void scan();
  };
  const hmr = ctx.get("hmr");
  if (hmr?.executing?.exit) hmr.executing.exit(start);
  else start();
}
