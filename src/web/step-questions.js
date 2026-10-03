import { photosConfigured } from "../config.js";
import { isStale, parseReply } from "../services/coach.js";
import { listDrafts, listQuestionPhotos, listStepQuestions, MAX_QUESTION_PHOTOS, parseSubsteps } from "../services/step-questions.js";

// Questions about a project's steps (src/services/step-questions.js), for the suggestion rows on the project page
// (views/partials/project-live.eta) and the "Ask Claude" card on a project task's page (views/partials/task-ask.eta).

/** Served by the app (GET /step-question-photos/:id/:size), which checks the household, never straight from Cloudinary. */
const photoUrls = (p) => ({ id: p.id, tiny: `/step-question-photos/${p.id}/tiny`, thumb: `/step-question-photos/${p.id}/thumb`, full: `/step-question-photos/${p.id}/full` });

/** Each question's photos, by question id. */
async function photosByQuestion(householdId, questions) {
  const photos = await listQuestionPhotos(householdId, questions.map((q) => q.id));
  const by = new Map(questions.map((q) => [q.id, []]));
  for (const p of photos) by.get(p.question_id)?.push(photoUrls(p));
  return by;
}

/** Someone's draft question about a step: the photos waiting to go with it. */
const draftView = (draft, photos) => (draft ? { id: draft.id, photos: photos.get(draft.id) ?? [] } : null);

/** One question and its answer, as the templates show it. A question left thinking too long counts as failed. */
export function questionView(q, at = Date.now(), photos = []) {
  const stale = isStale(q, at);
  const reply = parseReply(q.reply);
  return {
    id: q.id,
    question: q.question,
    photos,
    status: stale ? "failed" : q.status,
    error: stale ? "That took too long. Try again." : q.error,
    answer: reply?.answer ?? "",
    // On a suggestion the change is made already; on a task it's offered (proposal) until used or turned down.
    changed: Boolean(reply && reply.change !== "keep"),
    proposal: q.proposal,
    title: reply?.title ?? "",
    notes: reply?.notes ?? "",
    substeps: reply?.substeps ?? [],
    remove: (reply?.remove ?? []).map((r) => r.text),
  };
}

/**
 * The project page's suggestions, each with its sub-steps, the questions asked about it, and the viewer's draft
 * (photos they've added but not sent yet).
 */
export async function suggestionsWithQuestions(householdId, projectId, suggestions, { userId, at = Date.now() } = {}) {
  const forSuggestion = (q) => q.suggestion_id && !q.task_id;
  const questions = (await listStepQuestions(householdId, { projectId })).filter(forSuggestion);
  const drafts = userId ? (await listDrafts(householdId, userId, { projectId })).filter(forSuggestion) : [];
  const photos = await photosByQuestion(householdId, [...questions, ...drafts]);
  return suggestions.map((s) => {
    const asked = questions.filter((q) => q.suggestion_id === s.id).map((q) => questionView(q, at, photos.get(q.id)));
    return {
      ...s,
      substeps: parseSubsteps(s.checklist),
      questions: asked,
      draft: draftView(drafts.find((d) => d.suggestion_id === s.id), photos),
      updated: asked.some((q) => q.status === "ready" && q.changed),
    };
  });
}

/**
 * The task page's "Ask Claude" card, or null when there's no one to ask: the task isn't in a project with a goal,
 * or Claude isn't set up. `offer` is the newest change still waiting to be used or turned down; `draft` is the
 * viewer's photos waiting to go with their next question.
 */
export async function taskAskView(householdId, task, { enabled, userId, at = Date.now() }) {
  if (!enabled || !task.project_id || !task.project_has_goal) return null;
  const asked = await listStepQuestions(householdId, { taskId: task.id });
  const [draft] = userId ? await listDrafts(householdId, userId, { taskId: task.id }) : [];
  const photos = await photosByQuestion(householdId, draft ? [...asked, draft] : asked);
  const questions = asked.map((q) => questionView(q, at, photos.get(q.id)));
  const offer = questions.findLast((q) => q.status === "ready" && q.proposal === "open") ?? null;
  return { taskId: task.id, projectId: task.project_id, questions, offer, draft: draftView(draft, photos), ...photoOptions() };
}

/** Whether photos can go with a question, and how many. */
export const photoOptions = () => ({ photosEnabled: photosConfigured(), maxPhotos: MAX_QUESTION_PHOTOS });
