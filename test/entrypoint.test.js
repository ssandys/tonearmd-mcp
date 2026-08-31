import test from "node:test";
import assert from "node:assert";
import { parseListen } from "../src/server.js";

test("no flag and no env means stdio", () => {
  // Every existing local install runs this way. A default that listened would
  // put the daemon on the LAN on upgrade, without anyone asking.
  assert.strictEqual(parseListen([], {}), null);
});

test("bare --http is 0.0.0.0:9340", () => {
  assert.deepStrictEqual(parseListen(["--http"], {}), { host: "0.0.0.0", port: 9340 });
});

test("--http with a port keeps the default host", () => {
  assert.deepStrictEqual(parseListen(["--http", "9999"], {}), { host: "0.0.0.0", port: 9999 });
});

test("--http with host:port sets both", () => {
  assert.deepStrictEqual(parseListen(["--http", "127.0.0.1:9999"], {}),
                         { host: "127.0.0.1", port: 9999 });
});

test("TONEARM_MCP_HTTP works without the flag", () => {
  assert.deepStrictEqual(parseListen([], { TONEARM_MCP_HTTP: "127.0.0.1:9999" }),
                         { host: "127.0.0.1", port: 9999 });
});

test("the flag beats the env var", () => {
  assert.deepStrictEqual(parseListen(["--http", "9998"], { TONEARM_MCP_HTTP: "9999" }),
                         { host: "0.0.0.0", port: 9998 });
});

test("a non-numeric port throws rather than listening somewhere surprising", () => {
  assert.throws(() => parseListen(["--http", "banana"], {}), /port/i);
});
