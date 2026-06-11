const fs = require("fs");
const path = require("path");

const pkg = require("./package.json");

const source = path.join(
    __dirname,
    "dist",
    pkg.version,
    "isracard.widgets.TwilioVideoChat.mpk"
);

const target = path.join(
    __dirname,
    "dist",
    pkg.version,
    `isracard.widgets.TwilioVideoChat-${pkg.version}.mpk`
);

if (fs.existsSync(source)) {
    fs.copyFileSync(source, target);
    console.log(`Created: ${target}`);
} else {
    console.error(`MPK not found: ${source}`);
}