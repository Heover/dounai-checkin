import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFile } from "node:fs/promises";
import { runBrowserCheckin, PageFlowError } from "./browser-flow.mjs";
import { sendServerChanMessage } from "./checkin.mjs";
import { CaptchaVisionError } from "./captcha-vision.mjs";
import { installPageDiagnostics, readCaptchaControls } from "./page-diagnostics.mjs";

const HELP = `豆奶全自动页面签到

  npm run checkin           自动打开浏览器、识别验证码并签到
  npm run checkin -- --help 查看说明

程序自动填写账号密码，截取验证码小图交给 DeepSeek 识别并填写，完成页面签到。
无人工步骤。失败、超时或锁定时停止并通知，不等待人工处理。

环境变量或 .env 配置：
  DOUNAI_EMAIL / DOUNAI_PASSWD
  DEEPSEEK_API_KEY               必填，只发送验证码小图
  CHECKIN_BROWSER=chrome         也可填 msedge / chromium
  CHECKIN_TIMEOUT_MS=30000       页面响应等候上限（1000–120000）
  SERVER_UID / SERVER_KEY        沿用 Server 酱3 通知

浏览器使用独立临时会话，关闭后不保存密码或登录 Cookie。`;

export function describeLaunchError(error, channel) {
  const detail = String(error?.message || "");
  if (/sandbox|namespace|Operation not permitted/i.test(detail)) return `${channel} 浏览器沙箱无法初始化；未禁用沙箱，停止运行。`;
  if (/X server|DISPLAY|xvfb/i.test(detail)) return `${channel} 缺少可用显示环境，请检查 Xvfb。`;
  if (/executable.*(?:exist|found)|distribution.*not found/i.test(detail)) return `${channel} 可执行文件不存在，请安装对应浏览器。`;
  return `无法启动 ${channel}，请确认已安装浏览器并执行 npm install。`;
}

export async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(HELP);
    return;
  }
  const channel = process.env.CHECKIN_BROWSER || "chrome";
  const timeoutMs = Number(process.env.CHECKIN_TIMEOUT_MS || 30000);

  let browser;
  let page;
  let stopDiagnostics;
  let stage = "启动浏览器";
  const started = performance.now();
  let stageStarted = started;
  const onStage = (next) => {
    console.log(`阶段结束: ${stage}，耗时 ${Math.round(performance.now() - stageStarted)} ms`);
    stage = next;
    stageStarted = performance.now();
    console.log(`阶段开始: ${stage}`);
  };
  let outcome;
  try {
    const missing = ["DOUNAI_EMAIL", "DOUNAI_PASSWD", "DEEPSEEK_API_KEY"].filter((name) => !process.env[name]);
    if (missing.length) {
      stage = `配置缺失：${missing.join("、")}`;
      throw new Error();
    }
    if (!["chrome", "msedge", "chromium"].includes(channel) || !Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
      stage = "配置无效：请检查 CHECKIN_BROWSER 和 CHECKIN_TIMEOUT_MS";
      throw new Error();
    }
    const { chromium } = await import("playwright-core");
    console.log(`运行环境: ${JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, channel, timeoutMs, headless: false, sandbox: true, credentialsConfigured: true, visionConfigured: true, notificationConfigured: !!(process.env.SERVER_UID && process.env.SERVER_KEY) })}`);
    browser = await chromium.launch({ ...(channel === "chromium" ? {} : { channel }), headless: false, chromiumSandbox: true });
    console.log(`浏览器版本: ${browser.version()}`);
    const context = await browser.newContext({ viewport: null });
    page = await context.newPage();
    stopDiagnostics = installPageDiagnostics(page);
    onStage("自动页面操作");
    outcome = await runBrowserCheckin(page, {
      email: process.env.DOUNAI_EMAIL,
      password: process.env.DOUNAI_PASSWD,
      timeoutMs,
      onStage,
    });
  } catch (error) {
    if (page) console.log(`页面控件诊断: ${JSON.stringify(await readCaptchaControls(page))}`);
    // Playwright errors may include form values or private URLs in call logs.
    outcome = { success: false, msg: error instanceof CaptchaVisionError || error instanceof PageFlowError ? error.message : stage.startsWith("配置") ? stage : stage === "启动浏览器"
      ? describeLaunchError(error, channel)
      : "自动页面操作或验证码识别失败，未确认签到成功。" };
  }

  try {
    const result = outcome.blocked ? "blocked" : outcome.success ? outcome.alreadyCheckedIn ? "already-checked-in" : "success" : "failed";
    const elapsedMs = Math.round(performance.now() - started);
    console.log(`执行汇总: ${JSON.stringify({ result, lastStage: stage, stageDurationMs: Math.round(performance.now() - stageStarted), elapsedMs })}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      try {
        // Only locally generated fields; never write server messages or model output.
        await appendFile(process.env.GITHUB_STEP_SUMMARY, `## 签到执行结果\n\n- 结果：${result}\n- 最后阶段：${stage}\n- 总耗时：${elapsedMs} ms\n- 详细状态和阶段耗时见执行签到日志；不保存截图或凭据。\n`);
      } catch { console.log("无法写入 Actions 摘要，结果仍保留在日志中。"); }
    }
    console.log(`${outcome.success ? "✅" : outcome.blocked ? "⛔" : "❌"} ${outcome.msg}`);
    await sendServerChanMessage(
      outcome.success ? "✅ 豆奶签到成功" : outcome.blocked ? "⛔ 豆奶签到已锁定" : "❌ 豆奶签到未完成",
      outcome.msg,
    );
    if (!outcome.success) process.exitCode = 1;
  } finally {
    stopDiagnostics?.();
    await browser?.close();
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("页面签到未正常结束，请检查浏览器和网络连接。");
    process.exitCode = 1;
  });
}
