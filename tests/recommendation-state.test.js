const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const appPath = path.join(__dirname, "..", "app.js");
const source = fs.readFileSync(appPath, "utf8");
const core = source.split("/* ------------------------------------------------------------------ *\n * UI")[0];

const fixture = {
  source: "test fixture",
  glossary: {},
  engineering: {},
  systems: [
    {
      id: "series-3",
      name: "Series 3 (640)",
      family: "Sliding",
      sash_w_max: 2500,
      sash_h_max: 3000,
      sash_w_min: 600,
      sash_h_min: 1000,
      sash_sqm_max: 7,
      glass: "32",
      tracks: ["2", "3"],
      locking: "Multipoint",
      automation: "Yes",
      thresholds: {},
      drainage: {},
      sightlines: {},
      configs: [
        { leaves: 2, label: "Sliding + Sliding", tracks: "2", operable: 2 },
        { leaves: 3, label: "Sliding + Fixed + Sliding", tracks: "3", operable: 2 },
        { leaves: 4, label: "Sliding + Fixed + Fixed + Sliding", tracks: "3", operable: 2 },
      ],
      any_config: false,
      drawings: [],
    },
    {
      id: "bifold",
      name: "Bi-fold",
      family: "Folding",
      sash_w_max: 1200,
      sash_h_max: 3000,
      sash_w_min: 500,
      sash_h_min: 1000,
      sash_sqm_max: 3.6,
      glass: "28",
      tracks: ["4"],
      locking: "Multipoint",
      automation: "No",
      thresholds: {},
      drainage: {},
      sightlines: {},
      configs: [
        { leaves: 4, label: "Folding + Folding + Folding + Folding", tracks: "4", operable: 4 },
      ],
      any_config: false,
      drawings: [],
    },
  ],
};

const script = `${core}
const first = respond("I have a 4200 x 2700 opening - what do you recommend?");
assert.match(first, /Opening 4,200 × 2,700 mm/);
assert.equal(recommendationState.dimensions.W, 4200);
assert.equal(recommendationState.dimensions.H, 2700);

const folding = respond("make that folding");
assert.match(folding, /Opening 4,200 × 2,700 mm/);
assert.match(folding, /carried forward from earlier/);
assert.match(folding, /Bi-fold/);
assert.equal(recommendationState.family, "Folding");

const series3 = respond("what about Series 3?");
assert.match(series3, /Opening 4,200 × 2,700 mm/);
assert.match(series3, /Series 3 \\(640\\)/);
assert.doesNotMatch(series3, /Different product family/);
assert.equal(recommendationState.family, null);
assert.deepEqual(recommendationState.systemIds, ["series-3"]);

const fact = respond("What are the sash limitations for Series 3?");
assert.match(fact, /Series 3 \\(640\\) — Limitations/);
assert.match(fact, /Maximum sash width/);
assert.doesNotMatch(fact, /Opening 4,200 × 2,700 mm/);

const hardware = respond("Why can't I use a pop-out handle on Series 3?");
assert.match(hardware, /Series 3 \\(640\\) — Hardware/);
assert.doesNotMatch(hardware, /Opening 4,200 × 2,700 mm/);

const automation = respond("Which systems have automation?");
assert.match(automation, /automation available/);
assert.doesNotMatch(automation, /Opening 4,200 × 2,700 mm/);
`;

vm.runInNewContext(script, {
  window: { ORYX_KB: fixture },
  assert,
});

console.log("recommendation-state tests passed");
