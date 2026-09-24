// Renders design/icon-*.svg to the PNGs the iOS and Mac builds use.
// Needs Playwright + Chromium:  node design/render-icons.js  (then run design/flatten-ios-icons.py)
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const root = path.join(__dirname, "..");
const iosDir = path.join(root, "ios/App/App/Assets.xcassets/AppIcon.appiconset");
const jobs = [
  ["icon-ios.svg", path.join(iosDir, "AppIcon-512@2x.png")],
  ["icon-ios-dark.svg", path.join(iosDir, "AppIcon-dark.png")],
  ["icon-ios-tinted.svg", path.join(iosDir, "AppIcon-tinted.png")],
  ["icon-mac.svg", path.join(root, "desktop/build/icon.png")],
];

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  for (const [svg, out] of jobs) {
    const markup = fs.readFileSync(path.join(__dirname, svg), "utf8");
    await page.setContent(`<html><body style="margin:0;background:transparent">${markup}</body></html>`);
    await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
    console.log("rendered", path.relative(root, out));
  }
  await browser.close();
})();
