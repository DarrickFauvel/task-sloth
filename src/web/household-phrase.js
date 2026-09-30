// A sloth-paced line under the brand that works the household's name in, e.g. "The Fauvel House,
// takin' it slow". One is picked at random per page load; the header types it out (/js/type-writer.js).
// {h} is the household name. Keep them short: on a phone about 40 characters fit before the "…".

export const HOUSEHOLD_PHRASES = [
  "{h}, takin' it slow",
  "takin' it slow with {h}",
  "just hangin' with {h}",
  "{h}, one branch at a time",
  "{h}, powered by naps",
  "slow and steady, {h}",
  "{h} runs on sloth time",
  "moseying along with {h}",
  "no rush, {h}",
  "{h}, unhurried since forever",
  "chillin' in the canopy with {h}",
  "{h}, getting there eventually",
  "hang in there, {h}",
  "{h}, fashionably late",
  "{h}, cozy and in no hurry",
  "easy does it, {h}",
];

/** A phrase with the household's name worked in. `random` is for tests. */
export function householdPhrase(name, random = Math.random) {
  const template = HOUSEHOLD_PHRASES[Math.floor(random() * HOUSEHOLD_PHRASES.length)];
  return template.replace("{h}", name);
}
