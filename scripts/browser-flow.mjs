import { classifyCheckinResult, isCaptchaError, isCheckinBlocked } from "./checkin.mjs";
import { solveCaptchaImage } from "./captcha-vision.mjs";

export const SITE_URL = "https://dounai.win";
export class PageFlowError extends Error {}

export async function captchaDiagnostics(page, selector) {
  try {
    return await page.locator(selector).evaluate((box) => ({
      boxVisible: !!(box.getBoundingClientRect().width && box.getBoundingClientRect().height),
      media: Array.from(box.querySelectorAll("img, svg, canvas")).map((el) => ({
        tag: el.tagName.toLowerCase(),
        visible: !!(el.getBoundingClientRect().width && el.getBoundingClientRect().height) && getComputedStyle(el).visibility !== "hidden",
        width: el.getBoundingClientRect().width,
        height: el.getBoundingClientRect().height,
      })),
    }));
  } catch { return { unavailable: true }; }
}

/** Observe the webpage's own request; never forge/replay a POST or hidden token. */
export function observePost(page, pathname, { timeoutMs = 30_000 } = {}) {
  let finish;
  let settled = false;
  const result = new Promise((resolve) => { finish = resolve; });
  const timer = setTimeout(() => complete({ error: "等待页面响应超时，未确认成功" }), timeoutMs);
  function complete(value) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    page.off("response", onResponse);
    page.off("close", onClose);
    finish(value);
  }
  function onClose() { complete({ error: "浏览器已关闭，流程未完成" }); }
  async function onResponse(response) {
    try {
      const url = new URL(response.url());
      if (url.origin !== SITE_URL || url.pathname !== pathname || response.request().method() !== "POST") return;
      complete({ body: await response.json(), status: response.status() });
    } catch { complete({ error: "页面响应无法解析，未确认成功" }); }
  }
  page.on("response", onResponse);
  page.on("close", onClose);
  return { result, cancel: () => complete({ error: "已停止等待页面响应" }) };
}

export async function capture(page, selector, log = console.log) {
  const box = page.locator(selector);
  try {
    // Canvas-rendered images and hidden placeholder elements must not block capture.
    await box.locator("img, svg, canvas").filter({ visible: true }).first().waitFor({ state: "visible", timeout: 10_000 });
    // Only the captcha box is transmitted, never a full page/sensitive form.
    return await box.screenshot({ type: "png", animations: "disabled", timeout: 10_000 });
  } catch {
    log(`验证码区域诊断 ${selector}: ${JSON.stringify(await captchaDiagnostics(page, selector))}`);
    throw new PageFlowError(`验证码图片未就绪或截图失败（${selector}），未提交`);
  }
}

/** Refresh through the visible page control, then wait for its actual GET to finish. */
async function refreshImage(page, control) {
  const response = page.waitForResponse((res) => {
    const url = new URL(res.url());
    return url.origin === SITE_URL && url.pathname === "/auth/captcha" && res.request().method() === "GET";
  }, { timeout: 15_000 });
  // Attach rejection handling immediately, even if click itself fails.
  const handled = response.then(async (res) => { await res.finished(); return res.ok(); }, () => false);
  await control.click();
  if (!await handled) throw new Error("页面刷新验证码失败");
}

async function submitImage(page, { box, input, button, pathname, solveImage, timeoutMs, log }) {
  const png = await capture(page, box, log);
  log("验证码图片已截取，调用 DeepSeek 识别。");
  const answer = await solveImage(png);
  if (!/^-?\d{1,3}$/.test(answer)) throw new PageFlowError("验证码答案格式异常");
  // Image must still be the same after the API call; never submit a stale answer.
  if (!png.equals(await capture(page, box, log))) throw new PageFlowError("识别期间验证码已改变，已停止提交");
  log("验证码复核通过，准备填写并提交。");
  const watcher = observePost(page, pathname, { timeoutMs });
  try {
    try { await page.locator(input).fill(answer); }
    catch { throw new PageFlowError(`验证码输入框无法填写（${input}），未确认提交`); }
    // Login auto-submits on input; explicit click there would risk double-submit.
    if (button) {
      try { await page.locator(button).click(); }
      catch { throw new PageFlowError(`签到确认按钮无法点击（${button}），未确认提交`); }
    }
    return await watcher.result;
  } finally { watcher.cancel(); }
}

export async function runBrowserCheckin(page, {
  email = "", password = "", timeoutMs = 30_000,
  solveImage = solveCaptchaImage, log = console.log,
} = {}) {
  if (!email || !password) throw new Error("全自动运行需要 DOUNAI_EMAIL 和 DOUNAI_PASSWD");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) throw new Error("页面等待时间须为 1000–120000 毫秒");
  await page.goto(`${SITE_URL}/auth/login`, { waitUntil: "domcontentloaded" });
  if (new URL(page.url()).origin !== SITE_URL) throw new Error("登录页跳转到了其他站点，停止填写账号");
  if (!/^\/user(?:\/|$)/.test(new URL(page.url()).pathname)) {
    await page.getByRole("link", { name: "登录", exact: true }).click();
    await page.locator("#email2").fill(email);
    await page.locator("#passwd").fill(password);
    let loggedIn = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      await refreshImage(page, page.locator("#login-captcha-box"));
      log(`自动识别登录验证码（${attempt + 1}/3）`);
      const reply = await submitImage(page, { box: "#login-captcha-box", input: "#captcha_code",
        pathname: "/auth/login", solveImage, timeoutMs, log });
      if (reply.error) return { success: false, msg: reply.error };
      if (isCheckinBlocked(reply.body)) return { success: false, blocked: true, msg: "登录被站点锁定，停止重试" };
      if (reply.status === 200 && reply.body?.ret === 1) { loggedIn = true; break; }
      if (reply.status !== 200 || !isCaptchaError(reply.body?.msg || "")) {
        return { success: false, msg: `登录失败（HTTP ${reply.status}），停止重试` };
      }
    }
    if (!loggedIn) return { success: false, msg: "登录验证码连续三次失败，已停止" };
    await page.waitForURL((url) => url.origin === SITE_URL && /^\/user(?:\/|$)/.test(url.pathname), { timeout: timeoutMs });
  }
  if (new URL(page.url()).pathname !== "/user/panel") await page.getByRole("link", { name: "控制面板", exact: true }).click();
  await page.waitForURL(`${SITE_URL}/user/panel`, { timeout: timeoutMs });

  let reloads = 0;
  let needOpen = true;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (needOpen) {
      await page.getByRole("button", { name: /今日已签到|立即续命/ }).first().waitFor({ state: "visible" });
      const already = page.getByRole("button", { name: /今日已签到/ });
      // This check is only on fresh navigation/reload, never optimistic post-submit UI.
      if (await already.isVisible() && await already.isDisabled()) {
        return { success: true, alreadyCheckedIn: true, msg: "新加载的页面显示今日已签到" };
      }
      await page.getByRole("button", { name: /立即续命/ }).click();
      log(`签到弹窗图片结构: ${JSON.stringify(await captchaDiagnostics(page, "#checkin-captcha-box"))}`);
      needOpen = false;
    } else {
      await refreshImage(page, page.locator("#checkin-refresh-btn"));
    }
    log(`自动识别签到验证码（${attempt + 1}/3）`);
    const reply = await submitImage(page, { box: "#checkin-captcha-box", input: "#checkin_captcha_code",
      button: "#checkin-submit-btn", pathname: "/user/checkin", solveImage, timeoutMs, log });
    if (reply.error) return { success: false, msg: reply.error };
    const outcome = classifyCheckinResult(reply.body, reply.status);
    if (outcome.blocked || outcome.success) return outcome;
    if (attempt < 2 && outcome.refreshRequired && reloads++ === 0) {
      log("服务端要求刷新，最多重新加载一次。");
      await page.reload({ waitUntil: "domcontentloaded" });
      needOpen = true;
      continue;
    }
    if (!outcome.captchaError || attempt === 2) return outcome;
  }
}
