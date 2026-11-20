// node tests/displayName.unit.mjs
import { displayName, withName } from "../src/services/user.service.js";

const cases = [
  [{ firstName: "Tobi" }, "Tobi", " Tobi"],
  [{ data: { firstName: "Tobi" } }, "Tobi", " Tobi"], // wrapped /auth/me
  [{ firstName: "  Ada " }, "Ada", " Ada"],
  [{}, "", ""],
  [null, "", ""],
  [undefined, "", ""],
  [{ firstName: "undefined" }, "", ""],
  [{ firstName: "null" }, "", ""],
  [{ firstName: "" }, "", ""],
];

let failed = 0;
for (const [me, wantName, wantWith] of cases) {
  const gotName = displayName(me);
  const gotWith = withName(me);
  const ok = gotName === wantName && gotWith === wantWith;
  if (!ok) failed++;
  console.log(
    `${ok ? "✅" : "❌"} ${JSON.stringify(me)} → "Welcome back${gotWith} 👋"` +
      (ok ? "" : `  EXPECTED "Welcome back${wantWith} 👋"`),
  );
}
console.log(`\n${cases.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
