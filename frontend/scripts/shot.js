// Screenshot the landing page for visual diffing against design/landing.png
const { chromium } = require("playwright");

const OUT = process.argv[2] || "shot.png";
const WIDTH = Number(process.argv[3] || 1440);
const URL = process.argv[4] || "http://localhost:3000/";

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: 1000 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("requestfailed", (r) => errors.push("REQFAIL " + r.url()));
  page.on("response", (r) => { if (r.status() >= 400) errors.push(r.status() + " " + r.url()); });

  await page.goto(URL, { waitUntil: "load", timeout: 60000 });
  // Let hydration finish before touching the DOM — mutating .reveal mid-hydration
  // makes React report a false "attributes didn't match" mismatch.
  await page.waitForTimeout(1500);

  // let fonts settle + pin the video to a stable frame so diffs are comparable
  await page.evaluate(async () => {
    await document.fonts.ready;
    document.querySelectorAll("video").forEach((v) => {
      v.pause();
      v.currentTime = 0;
    });
    // settle scroll-reveal so a still frame shows the final layout
    document.querySelectorAll(".reveal").forEach((el) => {
      el.classList.add("is-visible");
      el.style.transition = "none";
    });
  });
  await page.waitForTimeout(1600);
  await page.screenshot({ path: OUT, fullPage: true });
  if (errors.length) console.log("CONSOLE ERRORS:\n" + errors.join("\n"));
  else console.log("no console errors");
  const h = await page.evaluate(() => document.body.scrollHeight);
  console.log("page height:", h, "width:", WIDTH);
  await browser.close();
})();
