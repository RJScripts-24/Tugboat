// Verifies the scroll-reveal actually animates: samples computed opacity
// over time on load, then again after scrolling each section into view.
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto("http://localhost:3000/", { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);

  const sample = () =>
    page.evaluate(() =>
      [...document.querySelectorAll(".rise, .reveal")].slice(0, 5).map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || "").trim().slice(0, 24),
        opacity: +getComputedStyle(el).opacity.slice(0, 4),
        visible: el.classList.contains("is-visible"),
      })),
    );

  console.log("html has .js:", await page.evaluate(() => document.documentElement.classList.contains("js")));
  console.log("total .reveal nodes:", await page.evaluate(() => document.querySelectorAll(".rise, .reveal").length));

  for (const t of [0, 250, 1200]) {
    if (t) await page.waitForTimeout(t === 250 ? 250 : 950);
    console.log(`\n--- hero @ ~${t}ms ---`);
    console.table(await sample());
  }

  // scroll the cards into view and confirm they flip to visible
  await page.evaluate(() => document.querySelector("#how-it-works")?.scrollIntoView());
  await page.waitForTimeout(1400);
  const cards = await page.evaluate(() =>
    [...document.querySelectorAll("#how-it-works li.reveal")].map((el) => ({
      card: (el.textContent || "").trim().slice(0, 10),
      opacity: +getComputedStyle(el).opacity.slice(0, 4),
      delay: getComputedStyle(el).transitionDelay,
    })),
  );
  console.log("\n--- cards after scrolling into view ---");
  console.table(cards);

  // scroll back to top: the hero should be re-revealed, cards faded out again
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1400);
  const cardsAway = await page.evaluate(() =>
    [...document.querySelectorAll("#how-it-works li.reveal")].map((el) =>
      +getComputedStyle(el).opacity.slice(0, 4),
    ),
  );
  console.log("\ncard opacity once scrolled away (fade-out):", cardsAway.join(", "));

  await browser.close();
})();
