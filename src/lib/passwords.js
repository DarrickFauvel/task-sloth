import { HttpError } from "./http.js";

/**
 * The rules for a new password, wherever one is chosen (sign-up, a reset link, Settings): 8–200 characters,
 * and, where it's typed twice, the same both times. Throws a 400 with a message for the form.
 */
export function checkNewPassword(password, again = password) {
  password = String(password ?? "");
  if (password.length < 8) throw new HttpError(400, "Password must be at least 8 characters");
  if (password.length > 200) throw new HttpError(400, "Password must be at most 200 characters");
  if (password !== String(again ?? "")) throw new HttpError(400, "The two passwords don't match");
  return password;
}
