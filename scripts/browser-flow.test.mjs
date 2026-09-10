import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { capture, inspectCaptchaBox, loadCaptcha, observePost, runBrowserCheckin, SITE_URL } from "./browser-flow.mjs";

const reward = { ret: 1, msg: "获得了 257 MB流量和1个豆丁，时长延长 1.5 小时。" };
const blocked = { ret: 0, is_blocked: true, msg: "今日签到机会已锁定" };
const refresh = { ret: 1, msg: "请刷新页面后重试。" };
const captchaError = { ret: 0, msg: "验证码错误或已超时，请刷新重试" };
const options = { email: "test@example.com", password: "test-only", solveImage: async () => "2", log: () => {} };
function response(body, { url = `${SITE_URL}/user/checkin`, method = "POST", status = 200 } = {}) {
  return { url: () => url, request: () => ({ method: () => method }), status: () => status,
    json: async () => body, finished: async () => null, ok: () => status === 200 };
}
function assertClean(page) {
  assert.equal(page.listenerCount("response"), 0);
  assert.equal(page.listenerCount("close"), 0);
}
test("就绪检测识别 CSS 背景、Canvas、文字算式，不把加载提示当验证码", () => {
  function inspect({ tag = "DIV", backgroundImage = "none", text = "", visible = true, complete = true, naturalWidth = 100 } = {}) {
    const el = { tagName: tag, complete, naturalWidth, textContent: text,
      getBoundingClientRect: () => ({ width: visible ? 100 : 0, height: 40 }),
      querySelectorAll: () => [],
    };
    return runInNewContext(`(${inspectCaptchaBox.toString()})(box)`, {
      box: el, getComputedStyle: () => ({ backgroundImage, display: "block", visibility: "visible" }),
    });
  }
  const background = inspect({ backgroundImage: "url(data:image/png;base64,private-image)" });
  assert.equal(background.ready, true);
  assert.ok(!JSON.stringify(background).includes("private-image"));
  assert.equal(inspect({ tag: "CANVAS" }).ready, true);
  assert.equal(inspect({ tag: "IMG", complete: false }).ready, false);
  assert.equal(inspect({ tag: "IMG", visible: false }).ready, false);
  assert.equal(inspect({ text: "玖加三" }).ready, true);
  assert.equal(inspect({ text: "加载中" }).ready, false);
  assert.equal(inspect({ text: "加载失败" }).errorKind, "load-error");
});
test("只接受本站指定 POST，结束后清理监听", async () => {
  const page = new EventEmitter();
  const watcher = observePost(page, "/user/checkin");
  for (const arg of [{ method: "GET" }, { url: "https://example.com/user/checkin" },
    { url: `${SITE_URL}/user/other` }]) page.emit("response", response(blocked, arg));
  page.emit("response", response(reward));
  assert.deepEqual((await watcher.result).body, reward);
  assertClean(page);
});
test("关闭、超时、取消和无法解析响应均结束且不判成功", async () => {
  for (const action of ["close", "timeout", "cancel", "invalid"]) {
    const page = new EventEmitter();
    const watcher = observePost(page, "/user/checkin", { timeoutMs: action === "timeout" ? 5 : 1000 });
    if (action === "close") page.emit("close");
    if (action === "cancel") watcher.cancel();
    if (action === "invalid") page.emit("response", { ...response(null), json: async () => { throw Error(); } });
    assert.ok((await watcher.result).error);
    assertClean(page);
  }
});

class FakePage extends EventEmitter {
  constructor(outcomes, { loggedIn = true, already = false, logins = [{ ret: 1 }], captchaReplies = [] } = {}) {
    super(); this.outcomes = [...outcomes]; this.logins = [...logins]; this.captchaReplies = [...captchaReplies];
    Object.assign(this, { loggedIn, already, clicks: 0, submits: 0, reloads: 0, refreshes: 0, fills: [], image: Buffer.from("fixture-image") });
  }
  async goto(url) { this.currentURL = this.loggedIn ? `${SITE_URL}/user/panel` : url; }
  url() { return this.currentURL; }
  async waitForURL(target) {
    if (typeof target === "function") { this.currentURL = `${SITE_URL}/user`; assert.ok(target(new URL(this.currentURL))); }
    else assert.equal(this.currentURL, target);
  }
  async reload() { this.reloads++; this.already = false; }
  emitCaptcha() {
    assert.equal(this.listenerCount("response"), 1, "必须在点击前监听验证码 GET");
    this.emit("response", response(this.captchaReplies.shift() || { ret: 1 }, {
      url: `${SITE_URL}/user/checkin/captcha`, method: "GET",
    }));
  }
  async waitForResponse(predicate) {
    const res = response({}, { url: `${SITE_URL}/auth/captcha`, method: "GET" });
    assert.ok(predicate(res)); return res;
  }
  locator(selector) {
    const page = this;
    return {
      locator() { return this; }, filter() { return this; }, first() { return this; }, async waitFor() {},
      async evaluate() { return { ready: true }; },
      async screenshot() { return page.image; },
      async fill(value) {
        page.fills.push([selector, value]);
        if (selector === "#captcha_code") {
          assert.equal(page.listenerCount("response"), 1);
          page.emit("response", response(page.logins.shift(), { url: `${SITE_URL}/auth/login` }));
        }
      },
      async click() {
        if (selector === "#checkin-submit-btn") {
          assert.equal(page.listenerCount("response"), 1);
          page.submits++; page.already = true;
          page.emit("response", response(page.outcomes.shift()));
        } else { page.refreshes++; page.emitCaptcha(); }
      },
    };
  }
  getByRole(role, { name }) {
    const page = this;
    return {
      first() { return this; }, async waitFor() {},
      async isVisible() { return page.already; }, async isDisabled() { return page.already; },
      async click() {
        if (name === "控制面板") page.currentURL = `${SITE_URL}/user/panel`;
        if (role === "button") { page.clicks++; page.emitCaptcha(); }
      },
    };
  }
}
test("验证码截图支持无 img 子元素的背景图，不依赖固定子标签", async () => {
  let inspected = 0;
  const page = { locator: () => ({
    async waitFor() {},
    async evaluate() { inspected++; return { ready: true, backgroundImage: true, media: [] }; },
    screenshot: async () => Buffer.from("captcha-only"),
  }) };
  assert.equal((await capture(page, "#captcha")).toString(), "captcha-only");
  assert.equal(inspected, 1);
});

test("截图超时输出明确阶段，不泄露底层错误或私密 URL", async () => {
  const page = { locator: () => ({
    locator() { return this; }, filter() { return this; }, first() { return this; },
    async waitFor() { throw new Error("private-url-and-token"); },
    async evaluate() { return { boxVisible: false, media: [] }; },
  }) };
  const logs = [];
  await assert.rejects(capture(page, "#captcha", (line) => logs.push(line)), /图片未就绪/);
  assert.ok(!logs.join("").includes("private-url"));
});
test("全自动登录和签到，无人工回调，输入登录验证码只提交一次", async () => {
  const page = new FakePage([reward], { loggedIn: false });
  assert.equal((await runBrowserCheckin(page, options)).success, true);
  assert.deepEqual(page.fills, [["#email2", "test@example.com"], ["#passwd", "test-only"],
    ["#captcha_code", "2"], ["#checkin_captcha_code", "2"]]);
  assert.equal(page.submits, 1);
  assert.equal(page.refreshes, 1, "打开签到弹窗已加载验证码，不应重复刷新");
  assertClean(page);
});
test("刷新一次且不把提交后乐观按钮判成功", async () => {
  const page = new FakePage([refresh, reward]);
  assert.equal((await runBrowserCheckin(page, options)).traffic, "257MB");
  assert.equal(page.reloads, 1); assert.equal(page.submits, 2);
  const repeated = new FakePage([refresh, refresh]);
  assert.equal((await runBrowserCheckin(repeated, options)).success, false);
  assert.equal(repeated.reloads, 1);
});
test("验证码错误最多三次，可在重试成功；锁定立即停止", async () => {
  for (const [bodies, success, submissions] of [[Array(3).fill(captchaError), false, 3],
    [[captchaError, reward], true, 2], [[blocked, reward], false, 1]]) {
    const page = new FakePage(bodies);
    assert.equal((await runBrowserCheckin(page, options)).success, success);
    assert.equal(page.submits, submissions); assertClean(page);
  }
});
test("登录验证码三次失败有界停止，账号错误不重试", async () => {
  for (const logins of [Array(3).fill(captchaError), [{ ret: 0, msg: "密码错误" }]]) {
    const page = new FakePage([], { loggedIn: false, logins });
    assert.equal((await runBrowserCheckin(page, options)).success, false);
    assert.equal(page.fills.filter(([selector]) => selector === "#captcha_code").length, logins.length);
    assert.equal(page.submits, 0); assertClean(page);
  }
});
test("新页面已签到则跳过识别和提交", async () => {
  const page = new FakePage([], { already: true });
  assert.equal((await runBrowserCheckin(page, { ...options, solveImage: async () => { throw Error(); } })).alreadyCheckedIn, true);
  assert.equal(page.submits, 0);
});

test("真实 GET 锁定回归：打开签到弹窗后立即结束，不识别、不刷新、不提交", async () => {
  let solves = 0;
  const page = new FakePage([], { captchaReplies: [blocked] });
  const outcome = await runBrowserCheckin(page, { ...options, solveImage: async () => { solves++; return "2"; } });
  assert.equal(outcome.blocked, true);
  assert.equal(outcome.success, false);
  assert.equal(solves, 0);
  assert.equal(page.clicks, 1);
  assert.equal(page.refreshes, 0);
  assert.equal(page.submits, 0);
  assertClean(page);
});

test("登录验证码 GET 锁定与刷新中锁定均立即停止", async () => {
  const login = new FakePage([], { loggedIn: false, captchaReplies: [blocked] });
  assert.equal((await runBrowserCheckin(login, options)).blocked, true);
  assert.equal(login.fills.filter(([selector]) => selector === "#captcha_code").length, 0);
  assertClean(login);
  const retry = new FakePage([captchaError], { captchaReplies: [{ ret: 1 }, blocked] });
  assert.equal((await runBrowserCheckin(retry, options)).blocked, true);
  assert.equal(retry.submits, 1);
  assert.equal(retry.refreshes, 1);
  assertClean(retry);
});

test("验证码 GET 业务失败时不截图或继续提交", async () => {
  const page = new EventEmitter();
  const outcome = await loadCaptcha(page, { async click() {
    page.emit("response", response({ ret: 0 }, { url: `${SITE_URL}/auth/captcha`, method: "GET" }));
  } });
  assert.equal(outcome.success, false);
  assert.match(outcome.msg, /获取验证码失败/);
  assertClean(page);
});
test("识别失败或图片改变时不填写答案，不提交", async () => {
  for (const changed of [false, true]) {
    const page = new FakePage([reward]);
    await assert.rejects(runBrowserCheckin(page, { ...options, solveImage: async () => {
      if (!changed) throw Error("识别失败");
      page.image = Buffer.from("new-image"); return "2";
    } }));
    assert.equal(page.submits, 0); assert.deepEqual(page.fills, []); assertClean(page);
  }
});
test("外站登录跳转不填写凭证，缺少配置不启动流程", async () => {
  const page = new FakePage([]);
  page.goto = async () => { page.currentURL = "https://example.com/login"; };
  await assert.rejects(runBrowserCheckin(page, options), /其他站点/);
  assert.deepEqual(page.fills, []);
  await assert.rejects(runBrowserCheckin(page, { ...options, timeoutMs: 0 }), /等待时间/);
  await assert.rejects(runBrowserCheckin(page), /需要/);
});
