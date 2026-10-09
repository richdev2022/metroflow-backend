// Registers the DB-stub module hooks for the push smoke test (must run BEFORE
// tsx's own hooks so /server/db resolution is short-circuited; hook chains are
// LIFO so this is imported LAST on the --import list).
import { register } from "node:module";
import { pathToFileURL } from "node:url";
register("./push-test-hooks.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));
