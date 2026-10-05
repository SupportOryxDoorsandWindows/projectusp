// Every entry in assets/items/index.json (item code -> photo file) must point
// at a real file, and every photo file must be listed -- a typo would show a
// broken image in Master Inventory.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const dir = "assets/items";
const map = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
const files = new Set(fs.readdirSync(dir).filter((f) => f !== "index.json"));

for (const [code, file] of Object.entries(map)) {
  assert.ok(files.has(file), `photo for ${code} is missing: ${file}`);
  assert.ok(/^[A-Za-z0-9-]+\.(png|jpe?g|webp)$/.test(file), `unsafe photo file name for ${code}: ${file}`);
}
const listed = new Set(Object.values(map));
for (const f of files) assert.ok(listed.has(f), `photo file not in index.json: ${f}`);

console.log(`item-photos tests passed (${Object.keys(map).length} photos)`);
