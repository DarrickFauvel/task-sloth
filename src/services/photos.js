import { db, newId, now } from "../db/client.js";
import { HttpError } from "../lib/http.js";
import { destroyImage, uploadImage } from "../lib/cloudinary.js";
import { activityStatement } from "./activity.js";
import { changed } from "./changes.js";
import { getTask } from "./tasks.js";
import { imageType } from "./users.js";

/** The largest photo we take. The task page shrinks photos to 2000px in the browser, which is far smaller. */
export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
export const MAX_PHOTOS_PER_TASK = 20;

export async function getPhoto(householdId, photoId) {
  const photo = await db.get("SELECT * FROM task_photos WHERE id = ? AND household_id = ?", [photoId, householdId]);
  if (!photo) throw new HttpError(404, "Photo not found");
  return photo;
}

export async function listPhotos(householdId, taskId) {
  return db.all("SELECT * FROM task_photos WHERE household_id = ? AND task_id = ? ORDER BY created_at, id", [householdId, taskId]);
}

/** Uploads a photo to Cloudinary (one folder per household) and adds it to the task. */
export async function addPhoto(actor, taskId, bytes) {
  const task = await getTask(actor.householdId, taskId);
  const type = imageType(bytes);
  if (!type) throw new HttpError(400, "That isn't a JPEG, PNG or WebP image");
  if (bytes.length > PHOTO_MAX_BYTES) throw new HttpError(400, "That photo is too big");
  const { n } = await db.get("SELECT COUNT(*) AS n FROM task_photos WHERE task_id = ?", [task.id]);
  if (Number(n) >= MAX_PHOTOS_PER_TASK) throw new HttpError(400, `A task can have up to ${MAX_PHOTOS_PER_TASK} photos`);

  const { publicId, width, height } = await uploadImage(bytes, type, { folder: `task-sloth/${actor.householdId}` });
  const id = newId();
  await db.batch([
    {
      sql: "INSERT INTO task_photos (id, household_id, task_id, public_id, width, height, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      args: [id, actor.householdId, task.id, publicId, width ?? null, height ?? null, actor.id, now()],
    },
    activityStatement(actor.householdId, actor.id, task.id, "photo"),
  ]);
  changed(actor.householdId);
  return id;
}

/** Removes a photo from the task, then from Cloudinary (a failure there only leaves an orphan behind). */
export async function removePhoto(actor, photoId) {
  const photo = await getPhoto(actor.householdId, photoId);
  await db.run("DELETE FROM task_photos WHERE id = ?", [photo.id]);
  changed(actor.householdId);
  await destroyImage(photo.public_id).catch((err) => console.error("couldn't delete photo from Cloudinary", photo.public_id, err));
  return photo.task_id;
}
