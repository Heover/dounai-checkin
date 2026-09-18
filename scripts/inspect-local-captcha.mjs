// Local, unauthenticated screenshot diagnostic. Never fills credentials or submits a form.
import { chromium } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { capture, readInlineCaptcha, SITE_URL } from "./browser-flow.mjs";

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../temp/captcha-diagnostics");
const browser = await chromium.launch({ channel: "chrome", headless: false, chromiumSandbox: true });
try {
  const page = await browser.newPage({ viewport: null });
  await page.goto(`${SITE_URL}/auth/login`, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: "登录", exact: true }).click();
  const png = await capture(page, "#login-captcha-box");
  await mkdir(directory, { recursive: true });
  const screenshotPath = path.join(directory, "rendered.png");
  await writeFile(screenshotPath, png);
  console.log(screenshotPath);
  const source = await page.locator("#login-captcha-box").evaluate(readInlineCaptcha);
  if (source?.startsWith("data:image/png;base64,")) {
    const originalPath = path.join(directory, "original.png");
    await writeFile(originalPath, Buffer.from(source.split(",")[1], "base64"));
    console.log(originalPath);
  }
} finally { await browser.close(); }
