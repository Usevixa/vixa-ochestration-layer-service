/**
 * Greeting names. The API is inconsistent about where the name lives:
 *   POST /auth/login → data.user.fullName   (no firstName at all)
 *   GET  /auth/me    → firstName, possibly inside a { data } envelope
 * so look in every known place, and return "" rather than ever letting
 * "undefined"/"null" reach a message.
 */

const clean = (v) => {
  const s = String(v ?? "").trim();
  return /^(undefined|null)$/i.test(s) ? "" : s;
};

/** "Ada" from "Ada Obi", "" for nothing usable. */
export function firstNameFrom(fullName) {
  return clean(fullName).split(/\s+/)[0] || "";
}

/** The user's first name for greetings, or "" when there isn't a usable one. */
export function displayName(p) {
  return (
    clean(p?.firstName) ||
    clean(p?.data?.firstName) ||
    firstNameFrom(p?.fullName) ||
    firstNameFrom(p?.data?.fullName) ||
    firstNameFrom(p?.user?.fullName) ||
    ""
  );
}

/** " Name" for "Welcome back${withName(p)}", or "" when there's no name. */
export function withName(p) {
  const name = displayName(p);
  return name ? ` ${name}` : "";
}
