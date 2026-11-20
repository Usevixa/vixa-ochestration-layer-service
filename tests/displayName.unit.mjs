// node tests/displayName.unit.mjs
import { displayName, withName } from "../src/utils/names.js";

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
  [{ fullName: "Ada Obi" }, "Ada", " Ada"], // /auth/me with fullName only
  [{ id: "1", fullName: "  Tobi  Salvo " }, "Tobi", " Tobi"], // login data.user
  [{ user: { fullName: "Ada Obi" } }, "Ada", " Ada"],
  [{ fullName: "undefined" }, "", ""],
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
