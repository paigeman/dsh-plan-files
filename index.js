import { homedir } from "node:os";
import { join } from "node:path";
import { PlanStore, planning } from "./lib/plan-store.js";

export const name = "plan-files";
export const inject = ["fs", "tools", "systemPrompt"];

const parameters = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["create", "read", "edit"] },
    title: { type: "string", description: "Short task summary used only when creating the plan." },
    content: {
      type: "string",
      description: "Complete initial Markdown, accepted only for create.",
    },
    version: {
      type: "string",
      description: "Exact version returned by the most recent plan_file call, required for edit.",
    },
    edits: {
      type: "array",
      description:
        "Localized literal replacements against the current file. Each old_text must match once.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["old_text", "new_text"],
        properties: {
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
      },
    },
  },
};

export async function apply(ctx, config = {}) {
  const directory =
    config.plansDir ?? join(process.env.DSH_HOME || join(homedir(), ".dsh"), "plans");
  const stores = new WeakMap();
  const storeFor = (agent) => {
    if (!agent) throw new Error("A planning session is required.");
    if (!stores.has(agent.session)) stores.set(agent.session, new PlanStore(ctx, directory));
    return stores.get(agent.session);
  };
  const reviews = new Map();
  const denials = new Map();
  let disposed = false;
  ctx.effect(() => () => {
    disposed = true;
  });

  ctx.tools.register(
    {
      name: "plan_file",
      description:
        "Read, create, or precisely edit this session's Markdown plan. Read first on entering Plan Mode. Create only if this session has no plan. Reuse the same file after feedback, resume, and Plan Mode re-entry. Submit its exact content through native exit_plan_mode.",
      parameters,
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["protocol", "episode", "path", "version", "content"],
          properties: Object.fromEntries(
            ["protocol", "episode", "path", "version", "content"].map((key) => [
              key,
              { type: "string" },
            ]),
          ),
        },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      execute: (args, exec) => storeFor(exec.agent).tool(args, exec),
    },
    { when: ({ agent }) => planning(agent) },
  );

  ctx.systemPrompt.section({
    name: "plan-files:workflow",
    order: 910,
    text: ({ agent }) =>
      !planning(agent)
        ? ""
        : [
            "Use plan_file to keep one Markdown plan file for this session across Plan Mode entries.",
            "Saving and editing that plan through plan_file is permitted in Plan Mode. Keep implementation changes for approved execution.",
            "Read the session's existing plan when entering Plan Mode. Create an initial plan only when this session has none, before its first review. After approval and re-entry, continue reading and locally editing the same file.",
            "For feedback and later planning requests, use exact localized edits on that file, preserving unrelated content.",
            "The user gives ordinary natural-language feedback. Locate the relevant passages yourself. Clarify ambiguous feedback or a significantly expanded scope.",
            "Supply the version returned by plan_file when editing. Native write, edit, and apply_patch cannot modify managed plans.",
            "Call native exit_plan_mode with the exact saved content. Use native Approve, Keep planning, and feedback normally.",
            "Other tools retain their existing DSH permissions.",
          ].join("\n"),
  });

  ctx.on("tools/pre-execute", async (exec, next) => {
    const args = exec.arguments ?? {};
    const paths = [];
    if (
      ["write", "edit"].includes(exec.name) ||
      (exec.name === "str_replace_editor" && args.command !== "view")
    )
      paths.push(args.file_path ?? args.path);
    if (exec.name === "apply_patch" && typeof args.input === "string") {
      for (const match of args.input.matchAll(
        /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm,
      ))
        paths.push(match[1]);
    }
    if (paths.length === 0) return next();
    const fs = ctx.fs;
    if (!fs) return next();
    const root = await fs.resolve(directory, { signal: exec.signal });
    for (const path of paths.filter((path) => typeof path === "string")) {
      const target = await fs.resolve(path, {
        cwd: exec.agent?.session.header.cwd,
        signal: exec.signal,
      });
      if (fs.contains(root, target))
        denials.set(
          exec.token,
          "Use plan_file for managed plans so edits preserve all text outside the exact replacements.",
        );
    }
    return next();
  });
  ctx.tools.guard((exec) => denials.get(exec.token));
  ctx.on("tools/result", (exec) => {
    denials.delete(exec.token);
  });

  for (const event of ["fs/write-intent", "fs/edit-intent", "fs/delete-intent"]) {
    ctx.on(
      event,
      async (target, actor, next) => {
        const fs = ctx.fs;
        if (!fs) return next();
        const root = await fs.resolve(directory);
        if (fs.contains(root, target)) throw new Error("Use plan_file to modify managed plans.");
        return next();
      },
      { prepend: true },
    );
  }

  ctx.on("tools/execute", async (exec, next) => {
    if (
      exec.name !== "exit_plan_mode" ||
      !exec.agent ||
      exec.agent.session.header.origin === "subagent"
    )
      return next();
    const store = storeFor(exec.agent);
    return store.exclusive(exec.agent.session.id, async () => {
      const current = await store.current(exec.agent, exec.signal);
      const snapshot = await store.snapshot(current.path, exec.signal);
      if (exec.arguments.plan !== snapshot.content) {
        throw new Error(
          "Review content differs from the saved plan. Read plan_file and submit its exact content.",
        );
      }
      const key = `${exec.agent.session.id}/${exec.callId}`;
      reviews.set(key, { store, path: current.path, ...snapshot });
      try {
        return await next();
      } finally {
        reviews.delete(key);
      }
    });
  });

  ctx.on(
    "user-questions/request",
    async (request, next) => {
      const checks = request.questions
        .filter((question) => question.intent?.kind === "plan-review")
        .flatMap((question) => {
          const key = `${request.agent?.session.id}/${question.intent.callId}`;
          const review = reviews.get(key);
          if (!review) return [];
          if (question.detail !== review.content)
            throw new Error("Plan review differs from the saved-file submission.");
          return [{ question, review }];
        });
      for (const { review } of checks) {
        const current = await review.store.snapshot(review.path, request.signal);
        if (current.version !== review.version || current.content !== review.content) {
          throw new Error(
            "The plan changed before review opened. Submit the current saved file again.",
          );
        }
      }
      const answer = await next();
      for (const { question, review } of checks) {
        const item = answer.answers.find((item) => item.id === question.id);
        if (
          item?.selected.length !== 1 ||
          item.selected[0] !== question.intent.approve ||
          item.custom !== undefined
        )
          continue;
        const current = await review.store.snapshot(review.path, request.signal);
        if (disposed || current.version !== review.version || current.content !== review.content) {
          throw new Error(
            "The plan changed during review. Present the current saved file again before approval.",
          );
        }
      }
      return answer;
    },
    { prepend: true },
  );
}
