import { getTask } from "../services/tasks.js";
import { groupItems, listItems } from "../services/checklist.js";

/** Loads a task's checklist and shapes it for views/partials/checklist.eta. */
export async function checklistView(householdId, taskId) {
  const task = await getTask(householdId, taskId);
  const items = await listItems(taskId);
  return {
    task,
    groups: items.length ? groupItems(items, task.list_mode) : [],
    done: items.filter((i) => i.checked).length,
    total: items.length,
  };
}
