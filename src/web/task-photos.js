import { photosConfigured } from "../config.js";
import { listPhotos } from "../services/photos.js";

/** What each photo size asks Cloudinary for. */
export const PHOTO_SIZES = { tiny: "c_fill,g_auto,w_96,h_96", thumb: "c_fill,g_auto,w_320,h_320", full: "c_limit,w_1600,h_1600" };

/** The task page's photos, for views/partials/task-photos.eta. */
export async function taskPhotosView(householdId, taskId) {
  const enabled = photosConfigured();
  const photos = enabled ? await listPhotos(householdId, taskId) : [];
  return {
    taskId,
    enabled,
    photos: photos.map((p) => ({
      id: p.id,
      // Served by the app (GET /photos/:id/:size), which checks the household, never straight from Cloudinary.
      tiny: `/photos/${p.id}/tiny`,
      thumb: `/photos/${p.id}/thumb`,
      full: `/photos/${p.id}/full`,
    })),
  };
}
