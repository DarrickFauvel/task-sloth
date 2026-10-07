import { coachConfigured, photosConfigured } from "../config.js";
import { HttpError } from "../lib/http.js";
import { isStale, listCheckinPhotos, listCheckins, listSuggestions, MAX_CHECKIN_PHOTOS, parseReply } from "../services/coach.js";
import { getProject, listProjects, PROJECT_COLORS, PROJECT_ICONS } from "../services/projects.js";
import { listTasks } from "../services/tasks.js";
import { MEMBER_COLOR_NAMES } from "../services/users.js";
import { describeRecurrence, parseRule } from "../../public/js/lib/recurrence.js";
import { projectShortcut } from "../../public/js/lib/suggest.js";
import { decorateTask, projectHref } from "./task-list.js";
import { progressLine } from "./encouragement.js";
import { suggestionsWithQuestions } from "./step-questions.js";

// A project, for views/pages/project.eta. Every project has this page: its tasks and progress, and an edit sheet.
// One with a goal (src/services/coach.js) also has, top to bottom: the plan (or the form that asks for one); what
// Claude suggests adding; the check-in in progress; earlier check-ins, newest first. One without can ask for a plan.

/** Served by the app (GET /checkin-photos/:id/:size), which checks the household, never straight from Cloudinary. */
const photoUrls = (p) => ({ id: p.id, thumb: `/checkin-photos/${p.id}/thumb`, full: `/checkin-photos/${p.id}/full` });

export async function projectPageView({ householdId, projectId, membership, userId, today, time = null, now = Date.now() }) {
  const project = await getProject(householdId, projectId);
  if (project.archived) throw new HttpError(404, "Project not found");
  const coachEnabled = coachConfigured();
  // Claude's part only for a project with a goal, and only while Claude is set up.
  const planned = project.goal != null && coachEnabled;
  const checkins = (planned ? await listCheckins(householdId, projectId) : []).map((c) => ({
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
  // Each with its sub-steps and what's been asked about it.
  const suggestions = planned ? await suggestionsWithQuestions(householdId, projectId, await listSuggestions(householdId, projectId), { userId, at: now }) : [];
  const lastAnswer = later.filter((c) => c.status === "ready" && c.kind === "checkin").at(-1);
  const plan = start?.status === "ready" ? start.reply : null;
  const draft = plan ? later.find((c) => c.status === "draft") ?? null : null;
  const goalReached = Boolean(lastAnswer?.reply?.goal_reached) || (tasks.length > 0 && open.length === 0);
  const hasUpkeep = later.some((c) => c.kind === "upkeep" && c.status === "ready");

  return {
    project,
    planned,
    coachEnabled,
    hashName: projectShortcut(project.name),
    colors: PROJECT_COLORS,
    colorNames: MEMBER_COLOR_NAMES, // the project colors are the member colors
    iconSrc: PROJECT_ICONS[project.icon]?.src ?? null,
    icons: Object.entries(PROJECT_ICONS).map(([key, i]) => ({ key, ...i })),
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
    primary: !planned ? (coachEnabled ? "plan" : null) : !plan ? "plan" : suggestions.length ? "add" : draft ? "ask" : goalReached && !hasUpkeep ? "upkeep" : "checkin",
    photosEnabled: photosConfigured(),
    maxPhotos: MAX_CHECKIN_PHOTOS,
  };
}

/** The projects page: every open project, A to Z, each with how far along it is; and how many are empty. */
export async function projectsPageView(householdId) {
  const projects = (await listProjects(householdId)).map((p) => {
    const done = Number(p.done_count);
    const total = Number(p.task_count);
    return { ...p, href: projectHref(p.id), iconSrc: PROJECT_ICONS[p.icon]?.src ?? null, done, total, open: total - done };
  });
  return { projects, empty: projects.filter((p) => !p.total && p.goal == null).length };
}
