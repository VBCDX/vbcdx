// Test only: `node --import ./test/helpers/unprofiled-register.mjs …` loads src/service/artifact.js
// with one more SERVICES entry, "bogus-server", that has no install profile. No real service is
// verify-only today, so this is how the not-installable guards stay tested.
import { register } from "node:module";

register("./unprofiled-hooks.mjs", import.meta.url);
