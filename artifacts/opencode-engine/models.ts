import assert from "node:assert/strict";
import { offeredModels } from "../../runner/engines/opencode";

// bun artifacts/opencode-engine/models.ts
// The listing rule behind "backup for model switching"
// (runner/engines/opencode.ts, offeredModels): every model `opencode models`
// prints is offered, bundled ones first, so a chat can leave a bundled plan
// that is used up for a provider's own quota with /model.
//
// Ways it could fail, written down before the checks:
//   1. The old filter comes back and provider models are dropped.
//   2. A provider's model is ordered before the bundled ones, moving the
//      default off the free model when a provider is connected.
//   3. No model, or a provider, is marked the default.
//   4. A duplicate id is listed twice.
//   5. A bundled model keeps its `opencode/` name, or a provider loses its id.
//   6. Efforts learned by a session are applied to the wrong id.

const bundled = "opencode/beam-free";
const provider = "google/gemini-2.5-flash";

// 1. Both groups are offered.
const both = offeredModels([bundled, provider]);
assert.deepEqual(both.map((model) => model.id), [bundled, provider], "provider models must be offered");

// 2. Bundled first, whatever order the CLI prints, and 3. the default is a bundled model.
const reversed = offeredModels([provider, bundled]);
assert.equal(reversed[0].id, bundled, "bundled models must stay first");
assert.equal(reversed.find((model) => model.isDefault)?.id, bundled, "the default must stay bundled");

// 4. Duplicates and blank lines are not models.
assert.deepEqual(offeredModels([bundled, " ", provider, bundled]).map((model) => model.id), [bundled, provider], "ids must be listed once");

// 5. Names: the bundled prefix is dropped, a provider keeps its id.
assert.equal(both[0].name, "beam-free", "bundled names drop the engine's own prefix");
assert.equal(both[1].name, provider, "provider names keep the id");

// 6. Learned efforts follow their id, and only it.
const withEfforts = offeredModels([bundled, provider], [
  { id: provider, name: provider, isDefault: false, efforts: ["low", "high"], defaultEffort: "low" },
]);
assert.equal(withEfforts[0].efforts, undefined, "efforts must not leak to another model");
assert.deepEqual(withEfforts[1].efforts, ["low", "high"]);
assert.equal(withEfforts[1].defaultEffort, "low");

// An empty answer is an empty list, never a crash or a made-up model.
assert.deepEqual(offeredModels([]), []);

console.log("ok: offeredModels — bundled first, providers after, default unchanged, deduped, names kept");
