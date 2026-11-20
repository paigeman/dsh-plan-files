import { join } from "node:path";
import { writeJson } from "./acceptance-control.mjs";

export const name = "plan-files-tui-acceptance-dev";

export function apply(ctx, config) {
  let agent;
  const state = {
    pid: process.pid,
    records: [],
    reviews: [],
    modes: [],
    turns: [],
  };
  const save = () => {
    if (agent) state.status = agent.status;
    writeJson(join(config.directory, "observation.json"), state);
  };
  ctx.on("agent/created", ({ agent: created }) => {
    if (created.session.header.cwd !== config.project) return;
    agent = created;
    state.sessionId = agent.id;
    save();
  });
  ctx.on("session/event", (session, event) => {
    if (session.id !== agent?.id) return;
    if (["plan/mode", "sandbox/mode", "approval/policy"].includes(event.type)) {
      state.modes.push({ type: event.type, ...event.data });
    }
    const message =
      event.type === "tool/ptc-dispatch" && event.data.name === "plan_file"
        ? event.data
        : event.type === "tool/result"
          ? event.data.message
          : undefined;
    if (message && !message.isError) {
      for (const block of message.content ?? []) {
        if (block.type !== "text") continue;
        try {
          const value = JSON.parse(block.text);
          if (value.protocol === "dsh-plan-files/1") state.records.push(value);
        } catch {
          // Other tools return ordinary text.
        }
      }
    }
    if (event.type === "turn/end") state.turns.push(event.data.reason);
    save();
  });
  ctx.on("user-questions/request", async (request, next) => {
    if (request.agent?.id !== agent?.id) return next();
    const question = request.questions.find((item) => item.intent?.kind === "plan-review");
    if (!question) return next();
    const review = { question: question.question, detail: question.detail, open: true };
    state.reviews.push(review);
    save();
    try {
      const answer = await next();
      review.answer = answer.answers.find((item) => item.id === question.id);
      return answer;
    } finally {
      review.open = false;
      save();
    }
  });
  const timer = setInterval(save, 200);
  ctx.effect(() => () => {
    clearInterval(timer);
    state.stopped = true;
    save();
  });
  ctx.provide("planFilesTuiAcceptance", {});
  save();
}
