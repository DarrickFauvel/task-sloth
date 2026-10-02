import { focusChoices, getFocus, householdSessions, sessionDone, sessionQueue, sessionTarget } from "../services/focus.js";
import { decorateTask } from "./task-list.js";

// The focus session screen (views/pages/focus.eta): the task in front of you, how far along you are, and what's
// next; or, with no session on, what you could focus on.

/** "🛒 Weekly shop" or "@Target". */
export const targetLabel = (target) => (target.kind === "project" ? `${target.emoji ?? ""} ${target.name}`.trim() : `@${target.name}`);

/**
 * @param {{ actor: import("../services/tasks.js").Actor, membership: object, today: string, time?: string }} args
 */
export async function focusPageView({ actor, membership, today, time = null }) {
  const session = await getFocus(actor);
  if (!session) return { choices: await focusChoices(actor) };
  const [target, done, queue] = await Promise.all([sessionTarget(actor.householdId, session), sessionDone(actor, session), sessionQueue(actor, session)]);
  const [current, next] = queue;
  return {
    session: true,
    target: { ...target, label: targetLabel(target) },
    done,
    total: done + queue.length,
    current: current ? decorateTask(current, membership, today, time) : null,
    next: next?.title ?? null,
    left: queue.length,
  };
}

/**
 * Who's focusing on what, for the line at the top of the lists: "Sam is focusing on @Target · 3 of 7 done",
 * or for you, "You're focusing on …" with a way back to it. Yours first.
 */
export async function focusLines(householdId, membership, userId) {
  const lines = (await householdSessions(householdId)).map((s) => {
    const member = membership.members.find((m) => m.id === s.userId);
    const mine = s.userId === userId;
    return {
      mine,
      // For your own session: what it's on and how far along, so the Working on now card can carry it (see taskListView).
      target: targetLabel(s.target), done: s.done, total: s.total, currentId: s.currentId,
      color: member?.color ?? null,
      text: `${mine ? "You're" : `${member?.name.split(" ")[0] ?? "Someone"} is`} focusing on ${targetLabel(s.target)} · ${s.done} of ${s.total} done`,
    };
  });
  return lines.sort((a, b) => b.mine - a.mine);
}
