// Registers the module hooks for the funding-limits smoke test (same pattern
// as register-push-stub.mjs). Import via:
//   node --import tsx/esm --import ./scripts/register-funding-hooks.mjs scripts/test_funding_limits.mjs
import { register } from "node:module";
import { pathToFileURL } from "node:url";
register("./funding-test-hooks.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));
