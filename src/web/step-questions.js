import { isStale, parseReply } from "../services/coach.js";
import { listStepQuestions, parseSubsteps } from "../services/step-questions.js";

// Questions about a project's steps (src/services/step-questions.js), for the suggestion rows on the project page
// (views/partials/project-live.eta) and the "Ask Claude" card on a project task's page (views/partials/task-ask.eta).

/** One question and its answer, as the templates show it. A question left thinking too long counts as failed. */
export function questionView(q, at = Date.now()) {
  const stale = isStale(q, at);
  const reply = parseReply(q.reply);
  return {
    id: q.id,
    question: q.question,
    status: stale ? "failed" : q.status,
    error: stale ? "That took too long. Try again." : q.error,
    answer: reply?.answer ?? "",
    // On a suggestion the change is made already; on a task it's offered (proposal) until used or turned down.
    changed: Boolean(reply && reply.change !== "keep"),
    proposal: q.proposal,
    title: reply?.title ?? "",
    notes: reply?.notes ?? "",
    substeps: reply?.substeps ?? [],
  };
}

/** The project page's suggestions, each with its sub-steps and the questions asked about it. */
export async function suggestionsWithQuestions(householdId, projectId, suggestions, at = Date.now()) {
  const questions = (await listStepQuestions(householdId, { projectId })).filter((q) => q.suggestion_id && !q.task_id);
  return suggestions.map((s) => {
    const asked = questions.filter((q) => q.suggestion_id === s.id).map((q) => questionView(q, at));
    return { ...s, substeps: parseSubsteps(s.checklist), questions: asked, updated: asked.some((q) => q.status === "ready" && q.changed) };
  });
}

/**
 * The task page's "Ask Claude" card, or null when there's no one to ask: the task isn't in a project with a goal,
 * or Claude isn't set up. `offer` is the newest change still waiting to be used or turned down.
 */
export async function taskAskView(householdId, task, { enabled, at = Date.now() }) {
  if (!enabled || !task.project_id || !task.project_has_goal) return null;
  const questions = (await listStepQuestions(householdId, { taskId: task.id })).map((q) => questionView(q, at));
  const offer = questions.findLast((q) => q.status === "ready" && q.proposal === "open") ?? null;
  return { taskId: task.id, projectId: task.project_id, questions, offer };
}
