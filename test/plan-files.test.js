import assert from "node:assert/strict";
import { resolve, relative } from "node:path";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  lstatSync,
} from "node:fs";
import { disposeTestSession } from "../scripts/acceptance-control.mjs";
import { applyExactEdits } from "../lib/exact-edit.js";
import { PlanStore, PROTOCOL } from "../lib/plan-store.js";

function fixture() {
  const directory = resolve("/plans");
  const files = new Map();
  let counter = 0;
  const fs = {
    async resolve(path, options) {
      return { targetKey: resolve(options?.cwd ?? "/project", path), displayPath: path };
    },
    contains(parent, child) {
      const path = relative(parent.targetKey, child.targetKey);
      return path === "" || (!path.startsWith("..") && !path.startsWith("/"));
    },
    async lstat(path) {
      return files.get(path) ? { type: "file" } : undefined;
    },
    async stat(target) {
      const item = files.get(target.targetKey);
      return item ? { type: "file", version: item.version } : undefined;
    },
    async readBytes(target, signal) {
      signal?.throwIfAborted();
      return Buffer.from(files.get(target.targetKey).content);
    },
    async writeText(target, content, expected, signal, policy) {
      signal?.throwIfAborted();
      const prior = files.get(target.targetKey);
      if (expected.kind === "createIfAbsent" && prior) throw new Error("Already exists");
      if (expected.kind === "replaceIfVersion" && prior?.version !== expected.version)
        throw new Error("Stale version");
      assert.equal(policy.mode, "workspace-write");
      assert.equal(policy.workspaceRoot, directory);
      const value = { content, version: String(++counter) };
      files.set(target.targetKey, value);
      return { version: value.version };
    },
  };
  const ctx = { fs };
  const store = new PlanStore(ctx, directory);
  const agent = (
    id = "session-a",
    events = [{ type: "plan/mode", seq: 0, data: { active: true } }],
  ) => ({
    session: {
      id,
      header: { cwd: "/project" },
      snapshotEvents: (start = 0, end = events.length) => events.slice(start, end),
      inheritedEventCount: 0,
    },
    events,
  });
  const exec = (agent) => ({ agent, signal: new AbortController().signal });
  return { files, store, agent, exec, ctx, directory };
}

test("exact edits preserve BOM, mixed newlines, Unicode, and the absent final newline", () => {
  const original = "\ufeff# 计划\r\n\r\n第一节\n\n第二节\r\n尾部";
  const edited = applyExactEdits(original, [{ old_text: "第一节", new_text: "第一节修改" }]);
  assert.deepEqual(Buffer.from(edited), Buffer.from(original.replace("第一节", "第一节修改")));
});

test("replacements are matched against the original and reject ambiguity, overlap, and full overwrite", () => {
  for (const [content, edits] of [
    ["# A\nabc abc", [{ old_text: "abc", new_text: "x" }]],
    [
      "# A\nabc",
      [
        { old_text: "abc", new_text: "x" },
        { old_text: "bc", new_text: "y" },
      ],
    ],
    ["# A\nabc", [{ old_text: "# A\nabc", new_text: "# B" }]],
    ["# A\nabc", [{ old_text: "missing", new_text: "x" }]],
  ])
    assert.throws(() => applyExactEdits(content, edits));
});

test("feedback edits reuse one file, preserve unrelated bytes, and reject create-overwrite", async () => {
  const f = fixture();
  const agent = f.agent();
  const exec = f.exec(agent);
  const first = await f.store.tool(
    { action: "create", title: "𠀀".repeat(49), content: "# Plan\r\nA\r\nB" },
    exec,
  );
  assert.equal(Buffer.from(first.path).toString(), first.path);
  const next = await f.store.tool(
    { action: "edit", version: first.version, edits: [{ old_text: "A", new_text: "A2" }] },
    exec,
  );
  assert.equal(next.path, first.path);
  assert.equal(next.content, "# Plan\r\nA2\r\nB");
  await assert.rejects(
    f.store.tool({ action: "create", title: "Another", content: "# Another" }, exec),
    /already exists/,
  );
  assert.equal(f.files.get(first.path).content, next.content);
});

test("resume and Plan Mode re-entry reuse the session's file while parallel sessions stay independent", async () => {
  const f = fixture();
  const agent = f.agent();
  const first = await f.store.tool(
    { action: "create", title: "A", content: "# A\nBody" },
    f.exec(agent),
  );
  const resumed = new PlanStore(f.ctx, f.directory);
  assert.equal((await resumed.tool({ action: "read" }, f.exec(agent))).path, first.path);
  const other = await f.store.tool(
    { action: "create", title: "A", content: "# A\nBody" },
    f.exec(f.agent("session-b")),
  );
  assert.notEqual(other.path, first.path);
  agent.events.push(
    { type: "plan/mode", seq: 1, data: { active: false } },
    { type: "plan/mode", seq: 2, data: { active: true } },
  );
  const read = await resumed.tool({ action: "read" }, f.exec(agent));
  assert.equal(read.path, first.path);
  assert.equal(read.content, first.content);
  const later = await resumed.tool(
    { action: "edit", version: read.version, edits: [{ old_text: "Body", new_text: "Revised" }] },
    f.exec(agent),
  );
  assert.equal(later.path, first.path);
  assert.equal(later.content, "# A\nRevised");
  await assert.rejects(
    resumed.tool({ action: "create", title: "B", content: "# B\nBody" }, f.exec(agent)),
    /already exists/,
  );
  assert.equal([...f.files.keys()].filter((path) => path.endsWith(".md")).length, 2);
});

test("concurrent edits with the same version permit one writer", async () => {
  const f = fixture();
  const agent = f.agent();
  const exec = f.exec(agent);
  const first = await f.store.tool({ action: "create", title: "A", content: "# A\nBody" }, exec);
  const outcomes = await Promise.allSettled(
    ["B", "C"].map((text) =>
      f.store.tool(
        { action: "edit", version: first.version, edits: [{ old_text: "Body", new_text: text }] },
        exec,
      ),
    ),
  );
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
});

test("external changes reject stale edits and cancellation leaves the file intact", async () => {
  const f = fixture();
  const agent = f.agent();
  const exec = f.exec(agent);
  const first = await f.store.tool({ action: "create", title: "A", content: "# A\nBody" }, exec);
  f.files.set(first.path, { content: "# A\nExternal", version: "external" });
  await assert.rejects(
    f.store.tool(
      {
        action: "edit",
        version: first.version,
        edits: [{ old_text: "Body", new_text: "Changed" }],
      },
      exec,
    ),
    /changed/,
  );
  const signal = AbortSignal.abort();
  await assert.rejects(f.store.tool({ action: "read" }, { agent, signal }));
  assert.equal(f.files.get(first.path).content, "# A\nExternal");
});

test("an interrupted first write retries the reserved identity", async () => {
  const f = fixture();
  const agent = f.agent();
  const exec = f.exec(agent);
  const current = await f.store.current(agent, exec.signal, { create: true, title: "Initial" });
  const created = await f.store.tool(
    { action: "create", title: "Retry", content: "# Retry\nBody" },
    exec,
  );
  assert.equal(created.path, current.path);
});

test("fork copies the inherited tool receipt instead of the parent's later file", async () => {
  const f = fixture();
  const events = [
    { type: "plan/mode", seq: 0, data: { active: true } },
    { type: "tool/call", seq: 1, data: { name: "plan_file", callId: "call-a" } },
    {
      type: "tool/result",
      seq: 2,
      data: {
        message: {
          toolCallId: "call-a",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                protocol: PROTOCOL,
                episode: "0",
                content: "# Fork\nOriginal",
              }),
            },
          ],
        },
      },
    },
  ];
  const child = f.agent("child", events);
  child.session.header.isSeeded = true;
  child.session.inheritedEventCount = 3;
  child.events.push(
    { type: "plan/mode", seq: 3, data: { active: false } },
    { type: "plan/mode", seq: 4, data: { active: true } },
  );
  const copy = await f.store.tool({ action: "read" }, f.exec(child));
  assert.equal(copy.content, "# Fork\nOriginal");
  assert.match(copy.path, /Fork/);
});

test("fork restores a plan recorded by a PTC nested dispatch", async () => {
  const f = fixture();
  const events = [
    { type: "plan/mode", seq: 0, data: { active: true } },
    {
      type: "tool/ptc-dispatch",
      seq: 1,
      data: {
        name: "plan_file",
        isError: false,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              protocol: PROTOCOL,
              episode: "0",
              content: "# PTC fork\nOriginal",
            }),
          },
        ],
      },
    },
  ];
  const child = f.agent("ptc-child", events);
  child.session.header.isSeeded = true;
  child.session.inheritedEventCount = events.length;
  const write = f.ctx.fs.writeText;
  let interrupted = false;
  f.ctx.fs.writeText = async (...args) => {
    if (!interrupted && args[0].targetKey.endsWith(".md")) {
      interrupted = true;
      throw new Error("Interrupted fork write");
    }
    return write(...args);
  };
  await assert.rejects(f.store.tool({ action: "read" }, f.exec(child)), /Interrupted fork write/);
  const reserved = await f.store.state(child.session);
  const reservedPath = f.store.path(reserved.value.plan);
  const copy = await f.store.tool({ action: "read" }, f.exec(child));
  assert.equal(copy.path, reservedPath);
  assert.equal(copy.content, "# PTC fork\nOriginal");
  f.files.delete(copy.path);
  await assert.rejects(f.store.tool({ action: "read" }, f.exec(child)), /missing/);
});

test("operations require an ordinary planning agent", async () => {
  const f = fixture();
  const agent = f.agent();
  agent.events.push({ type: "plan/mode", seq: 1, data: { active: false } });
  await assert.rejects(f.store.tool({ action: "read" }, f.exec(agent)), /Plan Mode/);
  agent.events.push({ type: "plan/mode", seq: 2, data: { active: true } });
  agent.session.header.origin = "subagent";
  await assert.rejects(f.store.tool({ action: "read" }, f.exec(agent)), /Plan Mode/);
});

function cleanupFixture() {
  const temporary = resolve(".agent-tmp");
  mkdirSync(temporary, { recursive: true });
  assert(!lstatSync(temporary).isSymbolicLink());
  const directory = mkdtempSync(resolve(temporary, "session-cleanup-"));
  const path = resolve(directory, "owned.jsonl");
  const other = resolve(directory, "other.jsonl");
  writeFileSync(path, "owned test session\n");
  writeFileSync(other, "other session\n");
  let disposed = false;
  const snapshot = {
    header: { id: "owned-session", cwd: directory },
    location: { kind: "jsonl", path },
  };
  const persistence = {
    async stat() {
      return existsSync(path) ? snapshot : undefined;
    },
  };
  const removed = [];
  const ctx = {
    emit(event, id) {
      assert.equal(event, "api-session/removed");
      assert.equal(existsSync(path), false);
      removed.push(id);
    },
    agents: { get: () => (disposed ? undefined : {}) },
    sessionController: {
      async list() {
        return existsSync(path) ? [{ id: "owned-session" }] : [];
      },
    },
    get: () => persistence,
  };
  const owned = {
    id: "owned-session",
    project: directory,
    handle: {
      agent: { ctx: { get: () => persistence } },
      async dispose() {
        disposed = true;
      },
    },
  };
  return { ctx, owned, path, other, snapshot, removed };
}

test("acceptance cleanup deletes only its owned session and checks the visible list", async () => {
  const f = cleanupFixture();
  assert.deepEqual(await disposeTestSession(f.ctx, f.owned), {
    sessionId: "owned-session",
    deleted: true,
  });
  assert.equal(existsSync(f.path), false);
  assert.deepEqual(f.removed, [f.owned.id]);
  assert.equal(readFileSync(f.other, "utf8"), "other session\n");
});

test("acceptance cleanup rejects a backend artifact whose ownership metadata differs", async () => {
  const f = cleanupFixture();
  f.snapshot.header.cwd = "/another-project";
  await assert.rejects(disposeTestSession(f.ctx, f.owned));
  assert.equal(existsSync(f.path), true);
  assert.equal(readFileSync(f.other, "utf8"), "other session\n");
});

test("acceptance cleanup retains the record when the owned Agent cannot stop", async () => {
  const f = cleanupFixture();
  f.owned.handle.dispose = async () => {
    throw new Error("Agent still running");
  };
  await assert.rejects(disposeTestSession(f.ctx, f.owned), /still running/);
  assert.equal(existsSync(f.path), true);
});
