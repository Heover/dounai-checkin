import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { stringify } from "node:querystring";
import { fileURLToPath } from "node:url";
import { createWorker, PSM, OEM } from "tesseract.js";
import { Jimp } from "jimp";

// ========== 加载 .env（本地调试用） ==========
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
try {
  const envPath = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
    console.log("已加载 .env 文件");
  }
} catch (_) {
  // 忽略加载错误
}

// ========== 配置 ==========
const EMAIL = process.env.DOUNAI_EMAIL;
const PASSWD = process.env.DOUNAI_PASSWD;
const BASE_URL = "https://dounai.win";
const MAX_CAPTCHA_ATTEMPTS = 8;
const CAPTCHA_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000, 30000];

// ========== 工具函数 ==========

/**
 * 发送 HTTP/HTTPS 请求
 */
function request(method, urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const transport = url.protocol === "https:" ? https : http;

    const headers = {
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "Accept-Language": "zh-CN,zh;q=0.9",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "X-Requested-With": "XMLHttpRequest",
      ...(opts.headers || {}),
    };

    if (opts.body && typeof opts.body === "string") {
      headers["Content-Type"] =
        headers["Content-Type"] ||
        "application/x-www-form-urlencoded; charset=UTF-8";
      headers["Content-Length"] = Buffer.byteLength(opts.body);
    }

    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers,
      rejectUnauthorized: false,
    };

    const req = transport.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        const cookies = res.headers["set-cookie"] || [];
        resolve({
          status: res.statusCode,
          headers: res.headers,
          cookies,
          body: data,
        });
      });
    });

    req.on("error", (err) => reject(err));
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("请求超时"));
    });

    if (opts.body) {
      req.write(opts.body);
    }
    req.end();
  });
}

/**
 * 最小 Cookie 容器：按名称覆盖同名 Cookie，避免重复 PHPSESSID 导致会话错乱。
 */
export class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  update(setCookieHeaders = []) {
    for (const header of setCookieHeaders) {
      const pair = header.split(";", 1)[0]?.trim();
      const separator = pair?.indexOf("=") ?? -1;
      if (separator <= 0) continue;

      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (name) this.cookies.set(name, value);
    }
  }

  toHeader() {
    return [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  get size() {
    return this.cookies.size;
  }
}

export function isCaptchaError(message = "") {
  return message.includes("验证码") && /(错误|超时|过期|失效)/.test(message);
}

export function isAlreadyCheckedIn(message = "") {
  return /(已(?:经)?签到|签到过了|重复签到|已(?:经)?续过命|续过命了)/.test(message);
}

export function captchaRetryDelayMs(attempt) {
  const index = Math.min(Math.max(Number(attempt) || 1, 1), CAPTCHA_RETRY_DELAYS_MS.length) - 1;
  return CAPTCHA_RETRY_DELAYS_MS[index];
}

/**
 * 兼容旧的 4 位验证码与新的单数字加法验证码。
 * primaryText 为原有字母数字 OCR；mathText 为算术模式的补充 OCR。
 */
export function resolveCaptchaValue(primaryText = "", mathText = "") {
  const primary = primaryText.toLowerCase().replace(/[^0-9a-z]/g, "");

  // 旧格式：完整的 4 位字母数字验证码。
  if (primary.length === 4) return primary;

  const primaryDigits = primary.match(/\d/g) || [];
  if (primaryDigits.length >= 2) {
    // 加号经常被 OCR 误读成 4、2 等数字（如 8+5 被读成 845），
    // 因此单数字加法应取首尾两个数字作为操作数。
    return String(Number(primaryDigits[0]) + Number(primaryDigits.at(-1)));
  }

  const mathDigits = mathText.match(/\d/g) || [];
  if (mathDigits.length >= 2) {
    return String(Number(mathDigits[0]) + Number(mathDigits.at(-1)));
  }

  // 两种 OCR 各识别到一个操作数时，合并计算。
  if (primaryDigits.length === 1 && mathDigits.length === 1) {
    return String(Number(primaryDigits[0]) + Number(mathDigits[0]));
  }

  return null;
}

// ========== 签到流程 ==========

/**
 * 用 tesseract.js 识别验证码图片（data URL）
 * 兼容旧 4 位字符和新单数字加法题；主识别失败时使用算术模式补充识别。
 */
async function recognizeCaptcha(worker, dataUrl) {
  const base64 = dataUrl.split(",")[1];
  const img = await Jimp.read(Buffer.from(base64, "base64"));

  await worker.setParameters({
    tessedit_char_whitelist: "0123456789abcdefghijklmnopqrstuvwxyz",
    tessedit_pageseg_mode: PSM.SINGLE_LINE,
  });
  const primaryImage = await img.clone().scale(3).invert().getBuffer("image/png");
  const { data: primaryData } = await worker.recognize(primaryImage);
  const primaryText = primaryData.text.replace(/\s+/g, "");
  const primaryValue = resolveCaptchaValue(primaryText);
  if (primaryValue) return primaryValue;

  await worker.setParameters({
    tessedit_char_whitelist: "0123456789+=",
    tessedit_pageseg_mode: PSM.SINGLE_LINE,
  });
  const mathImage = await img.clone().scale(4).invert().getBuffer("image/png");
  const { data: mathData } = await worker.recognize(mathImage);
  return resolveCaptchaValue(primaryText, mathData.text.replace(/\s+/g, ""));
}

async function createCaptchaWorker() {
  const worker = await createWorker("eng", OEM.LSTM_ONLY, { logger: () => {} });
  await worker.setParameters({
    tessedit_char_whitelist: "0123456789abcdefghijklmnopqrstuvwxyz",
    tessedit_pageseg_mode: PSM.SINGLE_LINE,
  });
  return worker;
}

/**
 * 在指定会话中刷新并识别验证码。
 */
async function fetchCaptcha(worker, cookieJar) {
  const cookieHeader = cookieJar.toHeader();
  const captchaRes = await request("GET", `${BASE_URL}/auth/captcha`, {
    headers: cookieHeader ? { Cookie: cookieHeader } : {},
  });
  cookieJar.update(captchaRes.cookies);

  let captchaData;
  try {
    captchaData = JSON.parse(captchaRes.body);
  } catch {
    throw new Error(`验证码响应不是 JSON（HTTP ${captchaRes.status}）`);
  }

  const imageMatch = captchaData?.svg?.match(/src="(data:image\/[^\"]+)"/);
  if (!imageMatch) {
    throw new Error(`验证码响应缺少图片（HTTP ${captchaRes.status}）`);
  }

  const captchaCode = await recognizeCaptcha(worker, imageMatch[1]);
  if (!captchaCode) {
    throw new Error("验证码识别结果异常（无法解析字符或算术题）");
  }

  return captchaCode;
}

async function login() {
  console.log("正在登录 dounai.win ...");

  // 初始化 OCR 引擎（识别登录图形验证码）
  let worker;
  try {
    worker = await createCaptchaWorker();
  } catch (err) {
    console.error(`  ❌ 无法初始化 OCR 引擎: ${err.message}`);
    return null;
  }

  const cookieJar = new CookieJar();
  try {
    for (let attempt = 1; attempt <= MAX_CAPTCHA_ATTEMPTS; attempt++) {
      // 1. 获取图形验证码（验证码与返回的会话 cookie 绑定，需复用）
      let captchaCode;
      try {
        captchaCode = await fetchCaptcha(worker, cookieJar);
      } catch (err) {
        console.warn(`  ⚠ 获取或识别验证码失败: ${err.message}（${attempt}/${MAX_CAPTCHA_ATTEMPTS}）`);
        if (attempt < MAX_CAPTCHA_ATTEMPTS) {
          const delayMs = captchaRetryDelayMs(attempt);
          console.warn(`  等待 ${delayMs / 1000} 秒后刷新重试`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        continue;
      }
      console.log(`  第 ${attempt} 次尝试，识别验证码: ${captchaCode}`);

      // 2. 携带验证码登录
      const body = stringify({
        email: EMAIL,
        passwd: PASSWD,
        captcha_code: captchaCode,
      });

      const res = await request("POST", `${BASE_URL}/auth/login`, {
        body,
        headers: cookieJar.size ? { Cookie: cookieJar.toHeader() } : {},
      });
      cookieJar.update(res.cookies);

      let result;
      try {
        result = JSON.parse(res.body);
      } catch {
        result = { raw: res.body };
      }

      const msg = result.msg || "";
      console.log(`  登录响应状态: ${res.status}，ret=${result.ret}`);

      if (result.ret === 1) {
        console.log(`  登录会话已建立（${cookieJar.size} 个 Cookie）`);
        return cookieJar;
      }

      if (msg.includes("验证码")) {
        console.warn(`  ⚠ 验证码错误（${attempt}/${MAX_CAPTCHA_ATTEMPTS}）`);
        if (attempt < MAX_CAPTCHA_ATTEMPTS) {
          const delayMs = captchaRetryDelayMs(attempt);
          console.warn(`  等待 ${delayMs / 1000} 秒后刷新重试`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        continue;
      }

      // 其他错误（如账号密码错误）直接失败，不再重试
      console.error(`  ❌ 登录失败：${msg || res.body}`);
      break;
    }
  } finally {
    try {
      await worker.terminate();
    } catch (_) {
      // 忽略释放错误
    }
  }

  console.error("  ❌ 登录失败：多次尝试后仍无法登录");
  return null;
}

async function submitCheckin(cookieJar, captchaCode = null) {
  const body = captchaCode ? stringify({ captcha_code: captchaCode }) : undefined;
  const res = await request("POST", `${BASE_URL}/user/checkin`, {
    ...(body ? { body } : {}),
    headers: {
      Cookie: cookieJar.toHeader(),
      Referer: `${BASE_URL}/user/panel`,
      Origin: BASE_URL,
    },
  });
  cookieJar.update(res.cookies);

  console.log(`  签到响应状态: ${res.status}`);
  console.log(`  签到响应内容: ${res.body}`);

  if (res.status === 401) {
    console.error("  ❌ 签到响应 401：会话未认证，登录状态无效");
    return { success: false, msg: "会话未认证，登录状态无效", captchaError: false };
  }

  let result;
  try {
    result = JSON.parse(res.body);
  } catch {
    result = { raw: res.body };
  }

  const msg = result.msg || res.body || "未知错误";
  if (isAlreadyCheckedIn(msg)) {
    console.log(`  ✅ 今日已签到，无需重复操作：${msg}`);
    return { success: true, msg, alreadyCheckedIn: true };
  }

  if (result.ret === 1) {
    const trafficMatch = result.msg.match(/(\d+\.?\d*\s*[KMG]?B?)流量/);
    const durationMatch = result.msg.match(/延长\s*(\d+\.?\d*)\s*小时/);

    const traffic = trafficMatch ? trafficMatch[1].replace(/\s+/g, "") : null;
    const duration = durationMatch ? `${durationMatch[1]} 小时` : null;

    if (traffic && duration) {
      console.log(`  ✅ 签到成功！${result.msg}`);
      return { success: true, msg: result.msg, traffic, duration };
    }

    // ret=1 是接口的成功标志；重复签到等成功响应可能不再包含奖励明细。
    console.log(`  ✅ 签到接口返回成功：${msg}`);
    return { success: true, msg, traffic, duration };
  }

  const captchaError = isCaptchaError(msg);
  console.log(`  ❌ 签到失败：${msg}`);
  return { success: false, msg, captchaError };
}

async function checkin(cookieJar) {
  console.log("正在签到 ...");

  let result = await submitCheckin(cookieJar);
  if (result.success || !result.captchaError) return result;

  console.warn("  ⚠ 签到端验证码无效，刷新验证码后重试");

  let worker;
  try {
    worker = await createCaptchaWorker();
  } catch (err) {
    console.error(`  ❌ 无法初始化签到验证码 OCR：${err.message}`);
    return result;
  }

  try {
    for (let attempt = 1; attempt <= MAX_CAPTCHA_ATTEMPTS; attempt++) {
      let captchaCode;
      try {
        captchaCode = await fetchCaptcha(worker, cookieJar);
      } catch (err) {
        console.warn(`  ⚠ 获取或识别签到验证码失败：${err.message}（${attempt}/${MAX_CAPTCHA_ATTEMPTS}）`);
        continue;
      }

      console.log(`  第 ${attempt} 次签到验证码尝试，识别结果: ${captchaCode}`);
      result = await submitCheckin(cookieJar, captchaCode);
      if (result.success || !result.captchaError) return result;

      if (attempt < MAX_CAPTCHA_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  } finally {
    try {
      await worker.terminate();
    } catch (_) {
      // 忽略释放错误
    }
  }

  return result;
}

/**
 * 访问用户面板页面，建立服务端会话
 */
async function visitPanel(cookieJar) {
  console.log("正在访问用户面板 ...");

  const res = await request("GET", `${BASE_URL}/user/panel`, {
    headers: {
      Cookie: cookieJar.toHeader(),
      Referer: `${BASE_URL}/auth/login`,
      Origin: BASE_URL,
    },
  });
  cookieJar.update(res.cookies);

  console.log(`  面板响应状态: ${res.status}`);

  if (res.status === 401) {
    console.error("  ❌ 会话未认证：登录状态无效，签到无法继续");
    return false;
  }

  return true;
}

// ========== Server酱3 推送 ==========

/**
 * 通过 Server酱3 发送消息到微信
 * API: POST https://{uid}.push.ft07.com/send/{sendkey}.send
 */
async function sendServerChanMessage(title, message) {
  const uid = process.env.SERVER_UID;
  const sendkey = process.env.SERVER_KEY;

  if (!uid || !sendkey) {
    console.log("  ⚠ 未配置 SERVER_UID 或 SERVER_KEY，跳过推送");
    return { success: false, error: "未配置" };
  }

  console.log("正在通过 Server酱3 推送消息...");

  const body = stringify({ title, desp: message });

  try {
    const res = await request("POST", `https://${uid}.push.ft07.com/send/${sendkey}.send`, {
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
    });

    console.log(`  Server酱3 响应状态: ${res.status}`);

    let result;
    try {
      result = JSON.parse(res.body);
    } catch {
      return { success: false, error: `响应解析失败: ${res.body}` };
    }

    if (result.code === 0) {
      console.log("  ✅ 推送成功");
      return { success: true, data: result };
    } else {
      console.log(`  ❌ 推送失败: ${result.message || "未知错误"}`);
      return { success: false, error: result.message || "未知错误" };
    }
  } catch (err) {
    console.log(`  ❌ 请求失败: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ========== 主流程 ==========

async function main() {
  console.log("========== 豆奶(dounai.win) 自动签到 ==========");
  console.log(`账号配置: ${EMAIL ? "已设置" : "未设置"}`);
  console.log("");

  try {
    // 1. 登录
    const cookieJar = await login();
    if (!cookieJar) {
      console.error("❌ 登录失败：未获取到 cookie，退出");
      process.exit(1);
    }

    await new Promise((r) => setTimeout(r, 1000));

    // 2. 访问面板建立会话
    const panelReady = await visitPanel(cookieJar);
    if (!panelReady) {
      console.error("❌ 会话验证失败，退出");
      process.exit(1);
    }

    await new Promise((r) => setTimeout(r, 500));

    // 3. 签到
    const result = await checkin(cookieJar);

    // 4. 推送结果（简洁，不含时间）
    let pushTitle, pushMessage;
    if (result.success) {
      pushTitle = "✅ 豆奶签到成功";
      pushMessage = `${result.msg}`;
    } else {
      pushTitle = "❌ 豆奶签到失败";
      pushMessage = `${result.msg}`;
    }
    await sendServerChanMessage(pushTitle, pushMessage);

    console.log("");
    console.log("========== 签到结束 ==========");

    if (!result.success) {
      process.exit(1);
    }
  } catch (err) {
    console.error(`❌ 执行出错: ${err.message}`);

    // 推送失败通知
    await sendServerChanMessage("❌ 豆奶签到异常", `执行出错: ${err.message}`);

    process.exit(1);
  }
}

if (path.resolve(process.argv[1] || "") === path.resolve(__filename)) {
  main();
}
