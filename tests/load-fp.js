// Loads the stock-screen files (the old fp-pro.js, now split) into a vm
// context in boot.js's own order (FP_FILES), without fp-main.js -- so
// nothing starts -- and returns the shared names (window.ORYX_FP).
const fs = require("fs");
const vm = require("vm");

function fpFiles() {
  const m = fs.readFileSync("boot.js", "utf8").match(/const FP_FILES = \[([\s\S]*?)\];/);
  if (!m) throw new Error("FP_FILES not found in boot.js");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

function loadFp(context) {
  vm.createContext(context);
  for (const f of fpFiles()) {
    if (f === "fp-main.js") continue;
    vm.runInContext(fs.readFileSync(f, "utf8"), context, { filename: f });
  }
  return context.window.ORYX_FP;
}

module.exports = { loadFp, fpFiles };
