import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("main writes the greeting, run as Cronplane runs it", async () => {
  const folder = mkdtempSync(join(tmpdir(), "my-action-"));
  writeFileSync(join(folder, "with.json"), JSON.stringify({ who: "Ada", shout: false }));
  Object.assign(process.env, {
    CRONPLANE_VERSION: "0.1.0",
    CRONPLANE_WITH: join(folder, "with.json"),
    CRONPLANE_OUTPUT: join(folder, "output.json"),
    CRONPLANE_MASK: join(folder, "mask"),
  });
  await import("./main.ts");
  expect(JSON.parse(readFileSync(join(folder, "output.json"), "utf8"))).toEqual({ greeting: "hello Ada" });
});
