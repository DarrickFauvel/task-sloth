import { photosConfigured } from "../config.js";
import { getGoalProject, isStale, listCheckinPhotos, listCheckins, listGoalProjects, listSuggestions, MAX_CHECKIN_PHOTOS, parseReply } from "../services/coach.js";
import { listTasks } from "../services/tasks.js";
import { describeRecurrence, parseRule } from "../../public/js/lib/recurrence.js";
import { decorateTask } from "./task-list.js";
import { progressLine } from "./encouragement.js";

// A project started from a goal (src/services/coach.js), for views/pages/project.eta. Top to bottom: the goal and
// progress; the plan (or the form that asks for one); what Claude suggests adding; the project's tasks; the
// check-in in progress; earlier check-ins, newest first.

/** Served by the app (GET /checkin-photos/:id/:size), which checks the household, never straight from Cloudinary. */
const photoUrls = (p) => ({ id: p.id, thumb: `/checkin-photos/${p.id}/thumb`, full: `/checkin-photos/${p.id}/full` });

export async function projectPageView({ householdId, projectId, membership, today, time = null, now = Date.now() }) {
  const project = await getGoalProject(householdId, projectId);
  const checkins = (await listCheckins(householdId, projectId)).map((c) => ({
    ...c,
    // A server restart mid-answer leaves it thinking for good; past the timeout it can be asked again.
    status: isStale(c, now) ? "failed" : c.status,
    error: isStale(c, now) ? "That took too long. Try again." : c.error,
    reply: parseReply(c.reply),
  }));
  const photos = await listCheckinPhotos(householdId, checkins.map((c) => c.id));
  for (const c of checkins) c.photos = photos.filter((p) => p.checkin_id === c.id).map(photoUrls);

  const start = checkins.find((c) => c.kind === "start");
  const later = checkins.filter((c) => c !== start);
  const tasks = (await listTasks(householdId, { projectId })).map((t) => decorateTask(t, membership, today, time));
  const open = tasks.filter((t) => t.status === "open");
  const done = tasks.filter((t) => t.status === "done");
  const suggestions = await listSuggestions(householdId, projectId);
  const lastAnswer = later.filter((c) => c.status === "ready" && c.kind === "checkin").at(-1);
  const plan = start?.status === "ready" ? start.reply : null;
  const draft = plan ? later.find((c) => c.status === "draft") ?? null : null;
  const goalReached = Boolean(lastAnswer?.reply?.goal_reached) || (tasks.length > 0 && open.length === 0);
  const hasUpkeep = later.some((c) => c.kind === "upkeep" && c.status === "ready");

  return {
    project,
    progress: { done: done.length, total: tasks.length, line: progressLine({ done: done.length, total: tasks.length }) },
    // The plan once Claude has made it; until then, the start check-in (draft, thinking or failed).
    plan,
    start,
    suggestions: {
      steps: suggestions.filter((s) => s.kind === "step"),
      upkeep: suggestions.filter((s) => s.kind === "upkeep").map((s) => ({ ...s, repeats: describeRecurrence(parseRule(s.recurrence)) })),
    },
    open,
    done,
    // The check-in being put together, if any (only once there's a plan).
    draft,
    // One that's with Claude, or one that didn't work out: shown above the history, with Try again.
    pending: later.filter((c) => c.status === "thinking" || c.status === "failed"),
    history: later.filter((c) => c.status === "ready").reverse(),
    // Done, as far as anyone can tell: time for upkeep.
    goalReached,
    hasUpkeep,
    // The page's one filled button: whatever moves the project on from here.
    primary: !plan ? "plan" : suggestions.length ? "add" : draft ? "ask" : goalReached && !hasUpkeep ? "upkeep" : "checkin",
    photosEnabled: photosConfigured(),
    maxPhotos: MAX_CHECKIN_PHOTOS,
  };
}

/** The projects page: projects with a goal, each with how far along it is. */
export async function projectsPageView(householdId) {
  return (await listGoalProjects(householdId)).map((p) => ({ ...p, done: Number(p.done_count), total: Number(p.task_count) }));
}
