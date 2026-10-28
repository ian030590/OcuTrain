const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "modules", "analysis");
const destination = path.join(root, "wwwroot", "analysis");
fs.mkdirSync(destination, { recursive: true });
for (const filename of ["index.html", "styles.css", "app.mjs", "model.mjs", "charts.mjs"]) {
  fs.copyFileSync(path.join(source, filename), path.join(destination, filename));
}
console.log("Analysis assets prepared for the desktop executable.");
