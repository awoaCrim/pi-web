import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script, createContext } from "node:vm";
import ts from "typescript";

// Exercise the actual hook callback with controlled HTTP completion order.
// No model, real transcript, browser session or extension is started.
const source = ts.createSourceFile("useAgentSession.ts",
  await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true);
const nodes = [];
function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(source);
const declaration = nodes.find((node) => ts.isVariableDeclaration(node)
  && node.name.getText(source) === "loadSession");
assert.ok(declaration);
const callback = new Script(ts.transpileModule(
  `(${declaration.initializer.arguments[0].getText(source)})`,
  { compilerOptions: { target: ts.ScriptTarget.ESNext } },
).outputText);

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const view = (text = "fresh", revision = "r2") => ({
  sessionId: "s", filePath: "", leafId: text, tree: [], treeFormat: "summary",
  snapshotRevision: revision, totalActiveMs: 0,
  context: {
    messages: [{ role: "user", content: text }], entryIds: [text],
    oldestEntryId: text, hasMore: false, turnsBefore: 0,
    thinkingLevel: "off", model: null,
  },
});
function setup() {
  const requests = [], snapshots = [], writes = [];
  let cached = null;
  const state = {
    data: view("old", "r1"), messages: [{ role: "user", content: "old" }],
    entryIds: ["old"], activeLeafId: "old", historyCursor: "old",
    hasEarlierMessages: false, earlierTurnCount: 0,
  };
  const context = {
    URLSearchParams, AbortController, console,
    sessionReadIdRef: { current: 0 }, sessionReadAbortRef: { current: null },
    sessionHookMountedRef: { current: true }, sessionIdRef: { current: "s" },
    historyEventVersionRef: { current: 0 }, loadFlightsRef: { current: new Map() },
    sessionToolsPinnedRef: { current: false }, modelSwitchPendingRef: { current: false },
    eventConnectionRef: { current: null }, CONFIGURED_TOOL_PRESET: "configured",
    getPresetFromToolNames: () => "custom", asConcreteThinkingLevel: (x) => x,
    getSessionViewSnapshot: () => cached,
    deleteSessionViewSnapshot: () => { cached = null; },
    setSessionViewSnapshot: (snapshot) => { cached = snapshot; snapshots.push(snapshot); },
    fetch: (url, init) => {
      const pending = deferred();
      requests.push({ ...pending, url, signal: init.signal });
      return pending.promise;
    },
  };
  for (const key of Object.keys(state)) {
    context[key + "Ref"] = { current: state[key] };
    context["set" + key[0].toUpperCase() + key.slice(1)] = (value) => {
      state[key] = typeof value === "function" ? value(state[key]) : value;
      context[key + "Ref"].current = state[key];
      writes.push(key);
    };
  }
  for (const key of ["Loading", "Error", "ToolPresetState", "CurrentModelOverride", "CurrentThinkingOverride", "LiveThinkingLevel"]) {
    context["set" + key] = (value) => { state[key] = value; writes.push(key); };
  }
  const load = callback.runInContext(createContext(context));
  const reply = (index, body, status = 200) => requests[index].resolve({
    status, ok: status >= 200 && status < 300, json: async () => body,
  });
  return { context, state, requests, snapshots, writes, load, reply,
    cache: (value) => { cached = value; } };
}

test("cached revisit shows fresh transcript before full metadata returns", async () => {
  const s = setup();
  const pending = s.load("s", false, false, { force: true, fastTranscript: true });
  assert.match(s.requests[0].url, /view=transcript/);
  s.reply(0, view());
  await tick();
  assert.equal(s.requests.length, 2);
  assert.equal(s.state.messages[0].content, "fresh");
  assert.equal(s.state.data.snapshotRevision, null);
  assert.equal(s.snapshots.length, 0, "old metadata must not be cached as fresh");
  s.reply(1, view());
  await pending;
  assert.equal(s.snapshots.length, 1);
  assert.equal(s.snapshots[0].revision, "r2");
});

test("a superseded late 404 cannot clear a newer view or cache", async () => {
  const s = setup();
  const first = s.load("s", true, false, { force: true });
  const second = s.load("s", false, false, { force: true });
  assert.equal(s.requests[0].signal.aborted, true);
  s.reply(1, view("newer"));
  await second;
  const count = s.writes.length;
  s.reply(0, {}, 404);
  await first;
  assert.equal(s.state.messages[0].content, "newer");
  assert.equal(s.writes.length, count);
  assert.equal(s.state.Loading, false);
});

test("a completed SSE message invalidates an in-flight history response", async () => {
  const s = setup();
  const pending = s.load("s");
  s.context.historyEventVersionRef.current++;
  s.reply(0, view("stale"));
  await tick();
  assert.equal(s.requests.length, 2);
  assert.equal(s.state.messages[0].content, "old");
  s.reply(1, view("latest"));
  await pending;
  assert.equal(s.state.messages[0].content, "latest");
});

test("an unchanged revision stores one coherent expanded history window", async () => {
  const s = setup();
  const ids = ["older", "old"];
  s.context.entryIdsRef.current = ids;
  s.context.messagesRef.current = ids.map((content) => ({ role: "user", content }));
  s.context.historyCursorRef.current = "older";
  s.context.hasEarlierMessagesRef.current = true;
  s.context.earlierTurnCountRef.current = 4;
  s.cache({ revision: "r1", entryIds: ids });
  const pending = s.load("s");
  s.reply(0, view("old", "r1"));
  await pending;
  assert.equal(s.snapshots.length, 1);
  const saved = s.snapshots[0];
  assert.deepEqual(Array.from(saved.entryIds), ids);
  assert.equal(saved.messages.length, 2);
  assert.deepEqual(Array.from(saved.loadedEntryIds), ids);
  assert.equal(saved.oldestEntryId, "older");
  assert.equal(saved.hasMore, true);
  assert.equal(saved.turnsBefore, 4);
});

test("unmount suppresses a late fast response and its metadata request", async () => {
  const s = setup();
  const pending = s.load("s", false, false, { fastTranscript: true });
  s.context.sessionHookMountedRef.current = false;
  s.context.sessionReadAbortRef.current.abort();
  const count = s.writes.length;
  s.reply(0, view());
  await pending;
  assert.equal(s.requests.length, 1);
  assert.equal(s.writes.length, count);
});

test("fast-read errors fall back to the full detail read", async () => {
  const s = setup();
  const pending = s.load("s", false, false, { fastTranscript: true });
  s.reply(0, {}, 500);
  await tick();
  s.reply(1, view());
  await pending;
  assert.equal(s.state.messages[0].content, "fresh");
});
