import assert from "node:assert/strict";
import test from "node:test";
import { Jimp } from "jimp";
import * as checkinModule from "./checkin.mjs";

import {
  captchaRetryDelayMs,
  CookieJar,
  isAlreadyCheckedIn,
  isCaptchaError,
  resolveCaptchaValue,
} from "./checkin.mjs";

test("登录验证码重试采用有上限的递增退避", () => {
  assert.equal(captchaRetryDelayMs(1), 1000);
  assert.equal(captchaRetryDelayMs(4), 8000);
  assert.equal(captchaRetryDelayMs(7), 30000);
  assert.equal(captchaRetryDelayMs(99), 30000);
});

test("CookieJar 用最新值覆盖同名会话 Cookie", () => {
  const jar = new CookieJar();
  jar.update([
    "PHPSESSID=old-session; path=/; HttpOnly",
    "uid=123; path=/",
  ]);
  jar.update(["PHPSESSID=new-session; path=/; HttpOnly"]);

  assert.equal(jar.size, 2);
  assert.equal(jar.toHeader(), "PHPSESSID=new-session; uid=123");
});

test("识别签到端验证码错误与超时消息", () => {
  assert.equal(isCaptchaError("验证码错误或已超时，请刷新重试"), true);
  assert.equal(isCaptchaError("验证码已过期"), true);
  assert.equal(isCaptchaError("会话未认证，登录状态无效"), false);
});

test("重复签到响应视为幂等成功", () => {
  assert.equal(isAlreadyCheckedIn("今天已经签到过了"), true);
  assert.equal(isAlreadyCheckedIn("今日已签到"), true);
  assert.equal(isAlreadyCheckedIn("您今天已经续过命了。"), true);
  assert.equal(isAlreadyCheckedIn("验证码错误"), false);
});

test("保留旧式 4 位验证码", () => {
  assert.equal(resolveCaptchaValue("8578"), "8578");
  assert.equal(resolveCaptchaValue(" 90-50 "), "9050");
});

test("明确的算式优先于误识别的四位字符", () => {
  assert.equal(resolveCaptchaValue("8s2s", "8+2="), "10");
  assert.equal(resolveCaptchaValue("543s", "5+3="), "8");
});

test("当前算术验证码支持减法及乘法，不再默认相加", () => {
  assert.equal(resolveCaptchaValue("412", "4-1="), "3");
  assert.equal(resolveCaptchaValue("7x8z", "7x8="), "56");
  assert.equal(resolveCaptchaValue("", "9 × 5 ="), "45");
  assert.equal(resolveCaptchaValue("", "2-8="), "-6");
});

test("OCR 在字符模式产生四位结果后仍运行算术模式", async () => {
  const png = await new Jimp({ width: 140, height: 44, color: 0xffffffff }).getBuffer("image/png");
  let whitelist;
  const calls = [];
  const worker = {
    async setParameters(params) { whitelist = params.tessedit_char_whitelist; },
    async recognize() {
      calls.push(whitelist);
      return { data: { text: whitelist.includes("a") ? "8s2s" : "8+2=" } };
    },
  };
  assert.equal(await checkinModule.recognizeCaptcha(worker, `data:image/png;base64,${png.toString("base64")}`), "10");
  assert.ok(calls.some((value) => value.includes("+") && value.includes("=")));
});

test("OCR 字符集保留减号和乘号", async () => {
  const png = await new Jimp({ width: 140, height: 44, color: 0xffffffff }).getBuffer("image/png");
  let whitelist;
  const worker = {
    async setParameters(params) { whitelist = params.tessedit_char_whitelist; },
    async recognize() {
      return { data: { text: whitelist.includes("-") && whitelist.includes("*") ? "4-1=" : "41" } };
    },
  };
  assert.equal(await checkinModule.recognizeCaptcha(worker, `data:image/png;base64,${png.toString("base64")}`), "3");
});

test("计算新式单数字加法验证码", () => {
  assert.equal(resolveCaptchaValue("54"), "9");
  assert.equal(resolveCaptchaValue("84a"), "12");
  assert.equal(resolveCaptchaValue("", "8+9="), "17");
  assert.equal(resolveCaptchaValue("6xg", "9="), "15");
});

test("忽略被误识别成数字的加号并取首尾操作数", () => {
  assert.equal(resolveCaptchaValue("845"), "13");
  assert.equal(resolveCaptchaValue("348"), "11");
  assert.equal(resolveCaptchaValue("", "323="), "6");
});

test("无法确定两个操作数时拒绝提交", () => {
  assert.equal(resolveCaptchaValue("m", "="), null);
});
