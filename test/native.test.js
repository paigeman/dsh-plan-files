import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  lstatSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { controlPatch } from "../scripts/acceptance-control.mjs";
import { nativeRuntime } from "./native-runtime.js";

const runtime = nativeRuntime();
const plugin = await import(
  process.env.DSH_PLAN_FILES_ENTRY
    ? pathToFileURL(resolve(process.env.DSH_PLAN_FILES_ENTRY)).href
    : "../index.js"
);
const { Context } = await runtime.load("cordis");
const { default: LocalFileSystem } = await runtime.load("dsh-fs-local");
const { ToolsService, assertSupportedJsonSchema } = await runtime.load("dsh-tools");
const { NativeToolExecutor } = await runtime.load("dsh-tool-executor-native");
const { Session } = await runtime.load("dsh-session");
const { PlanModeController } = await runtime.load("dsh-plan-mode");
const { Loader, Group } = await runtime.load("cordis-plugin-loader");
const fileTools = await runtime.load("dsh-tool-fs");
const stringEditor = await runtime.load("dsh-tool-str-replace-editor");

test("Desktop review actions show and copy a managed plan's path", async () => {
  const entry = process.env.DSH_PLAN_FILES_ENTRY
    ? new URL("./client.js", pathToFileURL(resolve(process.env.DSH_PLAN_FILES_ENTRY)))
    : new URL("../client.js", import.meta.url);
  let module;
  const clipboard = [];
  runInNewContext(readFileSync(entry, "utf8"), {
    __ModuleLoader__: { load: (declared) => (module = declared) },
    navigator: { clipboard: { writeText: (path) => clipboard.push(path) } },
  });
  assert.equal(module.id, "dsh-plan-files");
  const view = module.factory((name) => {
    assert.equal(name, "react");
    return {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useState: () => [undefined, () => {}],
    };
  });
  let render;
  view.apply({
    effect: () => {},
    slots: {
      inject(slot, callback) {
        assert.equal(slot, "conversation.plan-review.actions");
        callback();
      },
      register(_options, component) {
        render = component;
      },
    },
  });
  const question = "Approve this plan?";
  assert.equal(render({ review: { question } }), null);
  for (const path of [
    "/plans/review checklist.md",
    "C:\\Plans\\review.md",
    "/plans/two\nlines.md",
  ]) {
    const display = path.includes("\n") ? JSON.stringify(path) : path;
    const button = render({
      review: { question: `${question}\nPlan file: ${display}` },
      t: (key) => key,
    });
    assert.equal(button.type, "button");
    assert.equal(button.children.map((span) => span.children[0]).join(""), display);
    await button.props.onClick();
    assert.equal(clipboard.at(-1), path);
  }
});

test("Desktop controller revisions replace their loader entry without restarting the Host", async (t) => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Loader);
  const loader = ctx.get("loader");
  const activated = [];
  loader.builtins.first = { apply: () => activated.push("first") };
  loader.builtins.second = { apply: () => activated.push("second") };
  const first = controlPatch("# Existing profile\n", "cordis:first", "/test", "1".repeat(64));
  assert.throws(
    () =>
      controlPatch(
        "# END dsh-plan-files development acceptance\n# BEGIN dsh-plan-files development acceptance",
        "cordis:first",
        "/test",
        "1".repeat(64),
      ),
    /Malformed/,
  );
  const firstId = first.match(/id: (\S+)/)[1];
  await loader.root.update([{ id: firstId, name: "cordis:first" }]);
  await loader.await();
  assert.deepEqual(activated, ["first"]);
  // A URL-only update leaves the first module running in rc.3.
  await loader.root.update([{ id: firstId, name: "cordis:second" }]);
  await loader.await();
  assert.deepEqual(activated, ["first"]);
  const second = controlPatch(first, "cordis:second", "/test", "2".repeat(64));
  const secondId = second.match(/id: (\S+)/)[1];
  assert.notEqual(secondId, firstId);
  assert.equal((second.match(/# BEGIN/g) ?? []).length, 1);
  assert(second.startsWith("# Existing profile\n"));
  await loader.root.update([{ id: secondId, name: "cordis:second" }]);
  await loader.await();
  assert.deepEqual(activated, ["first", "second"]);
  const disabled = controlPatch(second, "cordis:second", "/test", "2".repeat(64), true);
  assert.match(disabled, /disabled: true/);
  await loader.root.update([{ id: secondId, name: "cordis:second", disabled: true }]);
  await loader.await();
  assert.equal(loader.resolve(secondId).fiber.uid, null);
});

async function setup(t) {
  const temporary = resolve(".agent-tmp");
  mkdirSync(temporary, { recursive: true });
  assert(!lstatSync(temporary).isSymbolicLink());
  assert(realpathSync(temporary).startsWith(realpathSync(process.cwd())));
  const directory = mkdtempSync(join(temporary, "native-plan-files-"));
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  ctx.provide("systemPrompt", {
    section() {},
    tools() {},
    getSectionOrder() {
      return 900;
    },
  });
  const agents = {
    list() {
      return [];
    },
    turnBoundaryOf() {
      return { openTurnStartSeq: null };
    },
  };
  ctx.provide("agents", agents);
  ctx.provide("sessionProjections", {
    async register(definition) {
      return {
        stateOf(session) {
          return session
            .snapshotEvents()
            .reduce((state, event) => definition.apply(state, event), definition.init());
        },
      };
    },
  });
  new LocalFileSystem(ctx, { cwd: directory, diffBasisMaxBytes: 1024 * 1024 });
  new ToolsService(ctx);
  const executor = new NativeToolExecutor(ctx);
  ctx.tools.setExecutor(executor);
  await ctx.plugin(Loader);
  const loader = ctx.get("loader");
  loader.builtins.group = Group;
  loader.builtins.plan = PlanModeController;
  await loader.root.update([
    {
      id: "planning",
      name: "cordis:group",
      group: true,
      isolate: { planMode: true },
      config: [
        { id: "plan-mode", name: "cordis:plan", config: { section: "Use native Plan Mode." } },
      ],
    },
  ]);
  await loader.await();
  const plan = loader.resolve("plan-mode").ctx.get("planMode");
  assert(plan, "The isolated native planning service did not start.");
  assert.equal(ctx.get("planMode"), undefined);
  ctx.provide("userQuestions", {
    ask: (request) =>
      ctx.waterfall("user-questions/request", request, async () => {
        throw new Error("No test answerer.");
      }),
  });
  let answer = async () => ({ answers: [{ id: "plan-review", selected: ["Approve"] }] });
  // An already-mounted UI answerer must still be wrapped by the plugin's revalidation.
  ctx.on("user-questions/request", (request) => answer(request));
  const session = Session.create(`session-${randomUUID()}`, undefined, undefined);
  const agent = { id: session.id, session, ctx, status: "idle", inject() {} };
  agents.list = () => [agent];
  const pluginFiber = await ctx.plugin(plugin, { plansDir: join(directory, "plans") });
  plan.set(agent, true);
  const signal = new AbortController().signal;
  const call = async (name, args, lineage = {}) => {
    const toolSet = await ctx.tools.resolve({
      agent,
      signal,
      modelSelection: { provider: "offline", model: "offline" },
    });
    try {
      const prepared = await executor.pipeline.prepare({
        callId: randomUUID(),
        name,
        arguments: args,
        agent,
        signal,
        toolSet,
        ...lineage,
      });
      const outcome =
        prepared.kind === "dispatch" ? await executor.pipeline.dispatch(prepared.exec) : prepared;
      return await executor.pipeline.complete(prepared.exec, outcome);
    } finally {
      toolSet.dispose?.();
    }
  };
  return {
    ctx,
    agent,
    plan,
    call,
    directory,
    pluginFiber,
    answer: (handler) => {
      answer = handler;
    },
  };
}

test("native schema, precise edits, feedback, and approval across Plan Mode re-entry", async (t) => {
  const f = await setup(t);
  const schema = f.ctx.tools.schemas(f.agent).find((schema) => schema.name === "plan_file");
  assert(schema);
  assertSupportedJsonSchema(schema.parameters);
  const created = await f.call("plan_file", {
    action: "create",
    title: "native",
    content: "\ufeff# Native\r\nFirst\nKeep this",
  });
  assert.equal(created.isError, false, JSON.stringify(created));
  const first = created.value;
  assert.deepEqual(readFileSync(first.path), Buffer.from(first.content));
  const mismatch = await f.call("exit_plan_mode", { plan: "# Another" });
  assert.equal(mismatch.isError, true);
  f.answer(async ({ questions: [review] }) => {
    assert.equal(review.detail, first.content);
    assert.ok(review.question.endsWith(`\nPlan file: ${first.path}`));
    return {
      answers: [
        { id: "plan-review", selected: ["Keep planning"], custom: "Change First to Revised" },
      ],
    };
  });
  const feedback = await f.call("exit_plan_mode", { plan: first.content });
  assert.equal(feedback.isError, true);
  assert.match(JSON.stringify(feedback), /Change First to Revised/);
  assert.equal(f.plan.get(f.agent).active, true);
  const edited = await f.call("plan_file", {
    action: "edit",
    version: first.version,
    edits: [{ old_text: "First", new_text: "Revised" }],
  });
  assert.equal(edited.isError, false, JSON.stringify(edited));
  assert.equal(edited.value.path, first.path);
  assert.equal(edited.value.content, "\ufeff# Native\r\nRevised\nKeep this");
  f.answer(async ({ questions: [review] }) => {
    assert.equal(review.detail, edited.value.content);
    assert.ok(review.question.endsWith(`\nPlan file: ${first.path}`));
    return { answers: [{ id: "plan-review", selected: ["Approve"] }] };
  });
  const approved = await f.call("exit_plan_mode", { plan: edited.value.content });
  assert.equal(approved.isError, false, JSON.stringify(approved));
  assert.equal(f.plan.get(f.agent).pending, false);
  f.plan.onBoundary(f.agent.session);
  assert.equal(f.plan.get(f.agent).active, false);
  assert.deepEqual(readFileSync(first.path), Buffer.from(edited.value.content));
  f.plan.set(f.agent, true);
  const reopened = await f.call("plan_file", { action: "read" });
  assert.equal(reopened.isError, false, JSON.stringify(reopened));
  assert.equal(reopened.value.path, first.path);
  assert.equal(reopened.value.content, edited.value.content);
  const continued = await f.call("plan_file", {
    action: "edit",
    version: reopened.value.version,
    edits: [{ old_text: "Revised", new_text: "Revised again" }],
  });
  assert.equal(continued.isError, false, JSON.stringify(continued));
  assert.equal(continued.value.path, first.path);
  assert.equal(continued.value.content, "\ufeff# Native\r\nRevised again\nKeep this");
  f.answer(async ({ questions: [review] }) => {
    assert.equal(review.detail, continued.value.content);
    assert.ok(review.question.endsWith(`\nPlan file: ${first.path}`));
    return { answers: [{ id: "plan-review", selected: ["Approve"] }] };
  });
  const reapproved = await f.call("exit_plan_mode", { plan: continued.value.content });
  assert.equal(reapproved.isError, false, JSON.stringify(reapproved));
  f.plan.onBoundary(f.agent.session);
  assert.equal(f.plan.get(f.agent).active, false);
});

test("an external edit during the question fails before native pending exit is set", async (t) => {
  const f = await setup(t);
  const created = await f.call("plan_file", {
    action: "create",
    title: "concurrency",
    content: "# Review\nOriginal",
  });
  assert.equal(created.isError, false, JSON.stringify(created));
  const saved = created.value;
  f.answer(async () => {
    const target = await f.ctx.fs.resolve(saved.path);
    await f.ctx.fs.writeText(target, "# Review\nExternal");
    return { answers: [{ id: "plan-review", selected: ["Approve"] }] };
  });
  const result = await f.call("exit_plan_mode", { plan: saved.content });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /changed during review/);
  assert.deepEqual(f.plan.get(f.agent), { active: true });
});

test("native and nested dispatch enforce managed-file denials while other paths retain access", async (t) => {
  const f = await setup(t);
  f.ctx.provide("workingDirectory", { ensure: async () => f.directory });
  await f.ctx.plugin(fileTools, {
    read: false,
    readImage: false,
    write: true,
    edit: true,
    applyPatch: true,
  });
  f.ctx.on("tools/pre-execute", async () => ({ kind: "allow" }));
  const path = join(f.directory, "plans", "any.md");
  const denied = await f.call("write", { file_path: path, content: "# Overwrite" });
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied), /plan_file/);
  assert.equal(existsSync(path), false);
  const ordinary = join(f.directory, "ordinary.md");
  const allowed = await f.call("write", { file_path: ordinary, content: "Ordinary text" });
  assert.equal(allowed.isError, false, JSON.stringify(allowed));
  assert.equal(readFileSync(ordinary, "utf8"), "Ordinary text");
  f.ctx.tools.register({
    name: "nested_write_probe",
    parameters: { type: "object", properties: {} },
    output: { schema: { type: "boolean" }, render: () => [] },
    async execute(_args, exec) {
      const result = await f.call(
        "write",
        { file_path: path, content: "# Nested overwrite" },
        { parent: exec.token, rootCallId: exec.rootCallId },
      );
      return result.isError;
    },
  });
  const nested = await f.call("nested_write_probe", {});
  assert.equal(nested.value, true);
  assert.equal(existsSync(path), false);
  const patch = await f.call("apply_patch", {
    input: `*** Begin Patch\n*** Add File: ${path}\n+# Patch overwrite\n*** End Patch`,
  });
  assert.equal(patch.isError, true);
  assert.match(JSON.stringify(patch), /plan_file/);
  assert.equal(existsSync(path), false);
  const saved = (
    await f.call("plan_file", { action: "create", title: "guarded", content: "# Guarded\nBody" })
  ).value;
  const alias = join(f.directory, "alias.md");
  symlinkSync(saved.path, alias);
  const edited = await f.call("edit", {
    file_path: alias,
    old_string: "Body",
    new_string: "Changed",
  });
  assert.equal(edited.isError, true);
  assert.match(JSON.stringify(edited), /plan_file/);
  assert.equal(readFileSync(saved.path, "utf8"), saved.content);
  await f.ctx.plugin(stringEditor);
  const viewed = await f.call("str_replace_editor", { command: "view", path: saved.path });
  assert.equal(viewed.isError, false, JSON.stringify(viewed));
  const replaced = await f.call("str_replace_editor", {
    command: "str_replace",
    path: saved.path,
    old_str: "Body",
    new_str: "Changed",
  });
  assert.equal(replaced.isError, true);
  assert.match(JSON.stringify(replaced), /plan_file/);
  assert.equal(readFileSync(saved.path, "utf8"), saved.content);
  const target = await f.ctx.fs.resolve(join(f.directory, "plans", "direct.md"));
  await assert.rejects(
    f.ctx.waterfall("fs/write-intent", target, {}, async () => undefined),
    /plan_file/,
  );
});

test("a change between submission and opening the review never reaches the answerer", async (t) => {
  const f = await setup(t);
  const saved = (
    await f.call("plan_file", {
      action: "create",
      title: "opening",
      content: "# Opening\nOriginal",
    })
  ).value;
  let asked = false;
  f.answer(async () => {
    asked = true;
    return { answers: [{ id: "plan-review", selected: ["Approve"] }] };
  });
  f.ctx.on("tools/execute", async (exec, next) => {
    if (exec.name === "exit_plan_mode")
      await f.ctx.fs.writeText(await f.ctx.fs.resolve(saved.path), "# Opening\nExternal");
    return next();
  });
  const result = await f.call("exit_plan_mode", { plan: saved.content });
  assert.equal(result.isError, true);
  assert.equal(asked, false);
  assert.deepEqual(f.plan.get(f.agent), { active: true });
});

test("plugin reload restores the same file through fresh scoped capabilities", async (t) => {
  const f = await setup(t);
  const saved = (
    await f.call("plan_file", { action: "create", title: "reload", content: "# Reload\nBody" })
  ).value;
  await f.pluginFiber.restart();
  const read = await f.call("plan_file", { action: "read" });
  assert.equal(read.isError, false, JSON.stringify(read));
  assert.equal(read.value.path, saved.path);
  assert.equal(read.value.content, saved.content);
});
