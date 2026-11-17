import { createHash, randomUUID } from "node:crypto";
import { basename, isAbsolute, join } from "node:path";
import { applyExactEdits, validateText } from "./exact-edit.js";

const MAX_BYTES = 4 * 1024 * 1024;
export const PROTOCOL = "dsh-plan-files/1";

export function planEpisode(session) {
  let episode;
  for (const event of session.snapshotEvents()) {
    if (event.type === "plan/mode" && event.data.active) episode = event.seq;
  }
  if (episode === undefined) throw new Error("Enter native Plan Mode with /plan first.");
  return String(episode);
}

export function planning(agent) {
  if (!agent || agent.session.header.origin === "subagent") return false;
  let active = false;
  for (const event of agent.session.snapshotEvents()) {
    if (event.type === "plan/mode") active = event.data.active;
  }
  return active;
}

function slug(title) {
  const summary = title
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
  return Array.from(summary).slice(0, 48).join("") || "plan";
}

export class PlanStore {
  constructor(ctx, directory) {
    if (!isAbsolute(directory)) throw new Error("plansDir must be an absolute path.");
    this.ctx = ctx;
    this.directory = directory;
    this.locks = new Map();
  }

  async exclusive(key, operation) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.locks.set(key, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }

  async target(path, signal) {
    const fs = this.ctx.fs;
    for (const checked of [this.directory, join(this.directory, ".state"), path]) {
      if ((await fs.lstat(checked, undefined, signal))?.type === "symlink") {
        throw new Error("Managed plan paths must not be symbolic links.");
      }
    }
    const root = await fs.resolve(this.directory, { signal });
    const target = await fs.resolve(path, { signal });
    if (!fs.contains(root, target)) throw new Error("Plan path escapes plansDir.");
    return target;
  }

  async snapshot(path, signal, optional = false) {
    const target = await this.target(path, signal);
    const before = await this.ctx.fs.stat(target, signal);
    if (!before && optional) return { target };
    if (before?.type !== "file")
      throw new Error("The plan file is missing or is not a regular file.");
    const bytes = await this.ctx.fs.readBytes(target, signal, MAX_BYTES);
    const after = await this.ctx.fs.stat(target, signal);
    if (before.version !== after?.version)
      throw new Error("The file changed during reading. Retry.");
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    validateText(content);
    return { target, version: before.version, content };
  }

  policy() {
    return { mode: "workspace-write", workspaceRoot: this.directory };
  }

  async write(path, content, prior, signal) {
    validateText(content);
    if (Buffer.byteLength(content) > MAX_BYTES) throw new Error("Plan data exceeds 4 MiB.");
    const target = await this.target(path, signal);
    return this.ctx.fs.writeText(
      target,
      content,
      prior?.version
        ? { kind: "replaceIfVersion", version: prior.version }
        : { kind: "createIfAbsent" },
      signal,
      this.policy(),
    );
  }

  statePath(session) {
    const key = createHash("sha256").update(session.id).digest("hex");
    return join(this.directory, ".state", `${key}.json`);
  }

  async state(session, signal) {
    const path = this.statePath(session);
    const prior = await this.snapshot(path, signal, true);
    const value =
      prior.content === undefined
        ? { version: 1, sessionId: session.id, plan: null }
        : JSON.parse(prior.content);
    if (
      value.version !== 1 ||
      value.sessionId !== session.id ||
      (value.plan !== null && (typeof value.plan !== "object" || Array.isArray(value.plan)))
    )
      throw new Error("Invalid plan association record.");
    return { path, prior, value };
  }

  path(record) {
    if (
      !record ||
      typeof record.file !== "string" ||
      basename(record.file) !== record.file ||
      !/^[a-f0-9-]{36}$/.test(record.id) ||
      !record.file.endsWith(`-${record.id.slice(0, 8)}.md`)
    )
      throw new Error("Invalid plan file identity.");
    return join(this.directory, record.file);
  }

  async saveState(state, signal) {
    const written = await this.write(
      state.path,
      JSON.stringify(state.value, null, 2) + "\n",
      state.prior,
      signal,
    );
    state.prior = { version: written.version };
  }

  inheritedPlan(session) {
    if (!session.header.isSeeded) return;
    const calls = new Set();
    let inherited;
    for (const event of session.snapshotEvents(0, session.inheritedEventCount)) {
      if (event.type === "tool/call" && event.data.name === "plan_file")
        calls.add(event.data.callId);
      const message =
        event.type === "tool/ptc-dispatch" && event.data.name === "plan_file"
          ? event.data
          : event.type === "tool/result" && calls.has(event.data.message.toolCallId)
            ? event.data.message
            : undefined;
      if (!message || message.isError) continue;
      for (const block of message.content ?? []) {
        if (block.type !== "text") continue;
        let value;
        try {
          value = JSON.parse(block.text);
        } catch {
          continue;
        }
        if (value.protocol === PROTOCOL && typeof value.content === "string") {
          inherited = value.content;
        }
      }
    }
    return inherited;
  }

  async reserve(title, state, signal, forkPending = false) {
    const id = randomUUID();
    const date = new Date().toISOString().slice(0, 10);
    const record = {
      id,
      file: `${date}-${slug(title)}-${id.slice(0, 8)}.md`,
      ...(forkPending ? { forkPending: true } : {}),
    };
    state.value.plan = record;
    // Persist identity first so an interrupted initial file write can retry the same path.
    await this.saveState(state, signal);
    return record;
  }

  async current(agent, signal, { title, create = false } = {}) {
    const session = agent.session;
    const episode = planEpisode(session);
    const state = await this.state(session, signal);
    let record = state.value.plan;
    if (!record) {
      const inherited = this.inheritedPlan(session);
      if (inherited !== undefined) {
        record = await this.reserve(inherited.split("\n")[0], state, signal, true);
      } else if (create) {
        record = await this.reserve(title, state, signal);
      } else throw new Error("Create and save the plan with plan_file before requesting review.");
    }
    if (record.forkPending) {
      const inherited = this.inheritedPlan(session);
      if (inherited === undefined) throw new Error("The inherited plan receipt is unavailable.");
      const copy = await this.snapshot(this.path(record), signal, true);
      if (copy.content === undefined)
        await this.write(this.path(record), inherited, undefined, signal);
      delete record.forkPending;
      await this.saveState(state, signal);
    }
    return { record, episode, path: this.path(record) };
  }

  async tool(args, exec) {
    const { agent, signal } = exec;
    if (!planning(agent)) throw new Error("plan_file is available in native Plan Mode.");
    return this.exclusive(agent.session.id, async () => {
      if (!planning(agent)) throw new Error("Plan Mode ended before this operation started.");
      if (!["create", "read", "edit"].includes(args.action))
        throw new Error("Use create, read, or edit.");
      if (args.action === "create") {
        validateText(args.content);
        if (!/^#\s+\S/.test(args.content.trim()))
          throw new Error("Start the Markdown plan with a # heading.");
        if (typeof args.title !== "string" || !args.title.trim())
          throw new Error("Supply a short task title.");
      }
      const current = await this.current(agent, signal, {
        title: args.title,
        create: args.action === "create",
      });
      const prior = await this.snapshot(current.path, signal, args.action === "create");
      let content = prior.content;
      if (args.action === "create") {
        if (content !== undefined)
          throw new Error("This plan already exists. Read it and apply localized edits.");
        content = args.content;
      }
      if (args.action === "edit") {
        if (typeof args.version !== "string" || args.version !== prior.version) {
          throw new Error("The plan changed. Read it again and use the returned version.");
        }
        content = applyExactEdits(content, args.edits);
      }
      let version = prior.version;
      if (args.action !== "read")
        version = (await this.write(current.path, content, prior, signal)).version;
      return { protocol: PROTOCOL, episode: current.episode, path: current.path, version, content };
    });
  }
}
