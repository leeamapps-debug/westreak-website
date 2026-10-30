// Browser checks for the WeStreak website, using Playwright with Chromium (project-local install).
// Usage: node scripts/browser-checks.mjs
// Starts scripts/serve.mjs on its own port, then: screenshots of every page at 375 and 1280 wide in light
// and dark, the home page at 200 percent zoom; the invite and not-found behaviour of 404.html; axe-core on
// every page; the home page's Tab order; and what a screen reader would hear for key parts of each page.
// Writes the screenshots and browser-checks.txt into Website/checks. Exits 0 on PASS, 1 on FAIL.
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= "0";
const { chromium } = await import("playwright");

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUT = join(ROOT, "checks");
const PORT = 8788;
const BASE = "http://127.0.0.1:" + PORT;
const PAGES = [
  { name: "home", path: "/" },
  { name: "support", path: "/support" },
  { name: "privacy", path: "/privacy" },
  { name: "terms", path: "/terms" },
  { name: "delete-account", path: "/delete-account" },
  { name: "not-found", path: "/no-such-page" },
  { name: "invite", path: "/invite/Ab3dEf6hIj9kLm2n" },
];

const lines = [];
let failures = 0;
function log(s) { lines.push(s); console.log(s); }
function check(ok, label, detail = "") {
  if (!ok) failures++;
  log((ok ? "PASS  " : "FAIL  ") + label + (detail && !ok ? "  |  " + detail : ""));
}

await mkdir(OUT, { recursive: true });

// 1. start the server
const server = spawn(process.execPath, [join(ROOT, "scripts", "serve.mjs"), String(PORT)], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((res, rej) => {
  server.stdout.on("data", (d) => { if (String(d).includes("Serving")) res(); });
  server.on("exit", (c) => rej(new Error("server exited " + c)));
  setTimeout(() => rej(new Error("server did not start")), 10000);
});

const browser = await chromium.launch();
const externalRequests = [];
const axeSource = await readFile(join(ROOT, "node_modules", "axe-core", "axe.min.js"), "utf8");

async function newPage(opts) {
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], ...opts });
  const page = await context.newPage();
  page.on("request", (r) => { if (!r.url().startsWith(BASE)) externalRequests.push(r.url()); });
  return { context, page };
}

try {
  // 2. screenshots, horizontal scroll, axe, aria snapshots
  for (const p of PAGES) {
    for (const scheme of ["light", "dark"]) {
      for (const width of [375, 1280]) {
        const { context, page } = await newPage({ viewport: { width, height: width === 375 ? 812 : 900 }, colorScheme: scheme });
        const resp = await page.goto(BASE + p.path, { waitUntil: "networkidle" });
        const file = `${p.name}-${width}-${scheme}.png`;
        await page.screenshot({ path: join(OUT, file), fullPage: true });
        log("SHOT  " + file + " (status " + resp.status() + ")");
        const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
        check(scrollW <= width, `${p.name} at ${width} ${scheme}: no sideways scrolling`, `scrollWidth ${scrollW}`);
        await context.close();
      }
    }

    // 320 wide, light only: the narrowest phone
    {
      const { context, page } = await newPage({ viewport: { width: 320, height: 640 } });
      await page.goto(BASE + p.path, { waitUntil: "networkidle" });
      const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
      check(scrollW <= 320, `${p.name} at 320: no sideways scrolling`, `scrollWidth ${scrollW}`);
      await context.close();
    }

    // axe-core, 1280 light
    {
      const { context, page } = await newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(BASE + p.path, { waitUntil: "networkidle" });
      await page.addScriptTag({ content: axeSource });
      const result = await page.evaluate(async () => {
        const r = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } });
        return {
          violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => n.target.join(" ")).slice(0, 5) })),
          passes: r.passes.length,
          incomplete: r.incomplete.map((v) => v.id),
        };
      });
      check(result.violations.length === 0, `${p.name}: axe-core finds no violations (${result.passes} rules passed, ${result.incomplete.length} needing manual review: ${result.incomplete.join(", ") || "none"})`,
        JSON.stringify(result.violations));
      for (const v of result.violations) log("  AXE   " + v.impact + " " + v.id + ": " + v.help + " at " + v.nodes.join("; "));

      // what a screen reader would hear
      const parts = [["header", "header"], ["hero", "main section:first-of-type, main #invite:not([hidden]), main #not-found:not([hidden])"], ["pricing", "section[aria-labelledby=pricing-heading]"], ["first question", ".faq h3:first-of-type"]];
      log("TREE  " + p.name);
      for (const [label, sel] of parts) {
        const loc = page.locator(sel).first();
        if ((await loc.count()) === 0) continue;
        let snap = await loc.ariaSnapshot();
        if (label === "first question") {
          const answer = await page.locator(".faq h3:first-of-type + p").first().ariaSnapshot();
          snap += "\n" + answer;
        }
        log("  [" + label + "]\n" + snap.split("\n").map((l) => "      " + l).join("\n"));
      }
      await context.close();
    }
  }

  // 3. home page at 200 percent zoom (a 1280 window at 200 percent is 640 CSS pixels wide, drawn at scale 2)
  {
    const { context, page } = await newPage({ viewport: { width: 640, height: 450 }, deviceScaleFactor: 2 });
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.screenshot({ path: join(OUT, "home-1280-zoom200-light.png"), fullPage: true });
    log("SHOT  home-1280-zoom200-light.png");
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    check(scrollW <= 640, "home at 200 percent zoom: no sideways scrolling", `scrollWidth ${scrollW}`);
    await context.close();
  }

  // 4. invite behaviour
  {
    const { context, page } = await newPage({ viewport: { width: 375, height: 812 } });
    const resp = await page.goto(BASE + "/invite/Ab3dEf6hIj9kLm2n", { waitUntil: "networkidle" });
    check(resp.status() === 404, "invite address is served by 404.html with status 404", String(resp.status()));
    check((await page.title()) === "You're Invited to WeStreak", "invite page title is You're Invited to WeStreak", await page.title());
    check(await page.locator("#invite").isVisible(), "invite content is shown");
    check(!(await page.locator("#not-found").isVisible()), "not-found content is hidden on the invite page");
    check((await page.locator("h1:visible").textContent()).trim() === "You've been invited to WeStreak", "invite heading reads You've been invited to WeStreak");
    await page.getByRole("button", { name: "Copy invite link" }).click();
    await page.waitForFunction(() => document.getElementById("copy-status").textContent.length > 0);
    const status = (await page.locator("#copy-status").textContent()).trim();
    check(status === "Invite link copied.", "copy button announces Invite link copied.", status);
    const role = await page.locator("#copy-status").getAttribute("role");
    const live = await page.locator("#copy-status").getAttribute("aria-live");
    check(role === "status" && live === "polite", "announcement sits in a polite live region");
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    check(clip === BASE + "/invite/Ab3dEf6hIj9kLm2n", "clipboard holds the full page address", clip);
    await context.close();
  }
  {
    const { context, page } = await newPage({ viewport: { width: 375, height: 812 } });
    await page.goto(BASE + "/invite", { waitUntil: "networkidle" });
    check(await page.locator("#invite").isVisible(), "/invite with no code also shows the invite content");
    await context.close();
  }
  // invite without JavaScript: the not-found content shows
  {
    const { context, page } = await newPage({ viewport: { width: 375, height: 812 }, javaScriptEnabled: false });
    await page.goto(BASE + "/invite/Ab3dEf6hIj9kLm2n");
    check(await page.locator("#not-found").isVisible() && !(await page.locator("#invite").isVisible()), "without JavaScript the not-found content shows");
    await context.close();
  }

  // 5. not found behaviour
  {
    const { context, page } = await newPage({ viewport: { width: 375, height: 812 } });
    const resp = await page.goto(BASE + "/no-such-page", { waitUntil: "networkidle" });
    check(resp.status() === 404, "/no-such-page returns status 404", String(resp.status()));
    check((await page.title()) === "Page Not Found, WeStreak", "not-found title is Page Not Found, WeStreak", await page.title());
    check(await page.locator("#not-found").isVisible() && !(await page.locator("#invite").isVisible()), "not-found content shows and invite content is hidden");
    await context.close();
  }

  // 6. keyboard order on the home page
  {
    const { context, page } = await newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    const order = [];
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("Tab");
      const d = await page.evaluate(() => {
        const e = document.activeElement;
        if (!e || e === document.body) return "body";
        const text = (e.getAttribute("aria-label") || e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
        const cs = getComputedStyle(e);
        const r = e.getBoundingClientRect();
        return `${e.tagName.toLowerCase()} "${text}" href=${e.getAttribute("href") || ""} focusRing=${cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0} size=${Math.round(r.width)}x${Math.round(r.height)}`;
      });
      order.push(d);
      if (d === "body" && i > 0) break;
    }
    log("TAB   home page keyboard order:");
    order.forEach((o, i) => log(`      ${i + 1}. ${o}`));
    check(order[0].startsWith('a "Skip to main content"'), "first Tab stop is the skip link");
    check(order.slice(0, 12).every((o) => o === "body" || o.includes("focusRing=true")), "every Tab stop shows a visible focus ring");
    const small = order.filter((o) => { const m = o.match(/size=(\d+)x(\d+)/); return m && (Number(m[1]) < 48 || Number(m[2]) < 48) && !o.includes("Skip to main"); });
    check(small.length === 0, "every link and button in the Tab order is at least 48 by 48", small.join("; "));
    await context.close();
  }

  // 7. no external requests at all
  check(externalRequests.length === 0, "no request left the local server (no fonts, trackers or CDNs)", [...new Set(externalRequests)].join(", "));
} finally {
  await browser.close();
  server.kill();
}

log("");
log(`RESULT: ${failures === 0 ? "PASS" : "FAIL"} (${failures} failed)`);
await writeFile(join(OUT, "browser-checks.txt"), lines.join("\n") + "\n");
process.exit(failures === 0 ? 0 : 1);
