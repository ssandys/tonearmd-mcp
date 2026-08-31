import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { VERSION } from "../src/server.js";

// tonearm has already paid for this one. Its `display_version` was a literal,
// and the manifest reached 0.9.0 while the literal stayed at the 0.1.0 it was
// written with -- "because nothing connected them and nothing could notice."
// This server had the same two-copies-of-one-fact shape: a "0.1.0" in the
// McpServer constructor beside package.json's own. This fails the moment the
// version Claude is told diverges from the version the package declares.
test("the version Claude sees is the one package.json declares", () => {
  const declared = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url))).version;
  assert.strictEqual(VERSION, declared);
});
