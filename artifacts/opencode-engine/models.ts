import assert from "node:assert/strict";
import { offeredModels, providerKeys } from "../../runner/engines/opencode";

// bun artifacts/opencode-engine/models.ts
// The listing rule behind "backup for model switching"
// (runner/engines/opencode.ts, offeredModels): the models `opencode models`
// prints for providers connected with `opencode auth login` are offered after
// the free bundled ones, so a chat can leave a bundled plan that is used up
// for a provider's own quota with /model.
//
// Ways it could fail, written down before the checks:
//   1. The old filter comes back and connected providers' models are dropped.
//   2. A provider's model is ordered before the bundled ones, moving the
//      default off the free model when a provider is connected.
//   3. No model, or a provider, is marked the default.
//   4. A duplicate id is listed twice.
//   5. A bundled model keeps its `opencode/` name, or a provider loses its id.
//   6. Efforts learned by a session are applied to the wrong id.
//   7. A provider that is not connected is offered anyway: `opencode models`
//      can list hundreds of models of providers this computer cannot use.

const bundled = "opencode/beam-free";
const provider = "google/gemini-2.5-flash";
const connected = ["google"];

// 1. Both groups are offered.
const both = offeredModels([bundled, provider], [], connected);
assert.deepEqual(both.map((model) => model.id), [bundled, provider], "a connected provider's models must be offered");

// 7. A provider that is not connected is left out; bundled comes with no auth.
assert.deepEqual(offeredModels([bundled, provider], [], []).map((model) => model.id), [bundled], "unconnected providers must be left out");
assert.equal(offeredModels([bundled], [], []).length, 1, "bundled models need no connection");

// 2. Bundled first, whatever order the CLI prints, and 3. the default is a bundled model.
const reversed = offeredModels([provider, bundled], [], connected);
assert.equal(reversed[0].id, bundled, "bundled models must stay first");
assert.equal(reversed.find((model) => model.isDefault)?.id, bundled, "the default must stay bundled");

// 4. Duplicates and blank lines are not models.
assert.deepEqual(offeredModels([bundled, " ", provider, bundled], [], connected).map((model) => model.id), [bundled, provider], "ids must be listed once");

// 5. Names: the bundled prefix is dropped, a provider keeps its id.
assert.equal(both[0].name, "beam-free", "bundled names drop the engine's own prefix");
assert.equal(both[1].name, provider, "provider names keep the id");

// A connection id's case does not change which models are offered.
assert.equal(offeredModels([provider], [], ["Google"]).length, 1, "connection ids must match case-insensitively");

// 6. Learned efforts follow their id, and only it.
const withEfforts = offeredModels([bundled, provider], [
  { id: provider, name: provider, isDefault: false, efforts: ["low", "high"], defaultEffort: "low" },
], connected);
assert.equal(withEfforts[0].efforts, undefined, "efforts must not leak to another model");
assert.deepEqual(withEfforts[1].efforts, ["low", "high"]);
assert.equal(withEfforts[1].defaultEffort, "low");

// An empty answer is an empty list, never a crash or a made-up model.
assert.deepEqual(offeredModels([]), []);

// 7 again, from `opencode auth list`: the provider prefixes come from both
// entry shapes seen in the wild, and an MCP integration adds a harmless key.
assert.deepEqual(providerKeys([{ id: "google", name: "Google" }]), ["google"], "a provider's id and name must both be keys");
assert.deepEqual(providerKeys([{ id: "cred_1", integrationID: "groq", name: "Groq" }]), ["cred_1", "groq"], "integrationID must be a key too");
assert.deepEqual(providerKeys([{ id: "mcp_1", name: "notion" }, "anthropic"]), ["anthropic"], "MCP integrations are not model providers");
assert.deepEqual(providerKeys([]), [], "no entries, no keys");
assert.deepEqual(offeredModels(["notion/page", "google/gemini-2.5-flash", bundled], [], providerKeys([{ id: "mcp_1", name: "notion" }, { id: "google", name: "Google" }])).map((model) => model.id), [bundled, "google/gemini-2.5-flash"], "only a connected provider's models are offered");

console.log("ok: offeredModels — bundled first, connected providers after, default unchanged, deduped, names kept");
