import assert from "node:assert/strict";
import test from "node:test";

import {
  CookieJar,
  isAlreadyCheckedIn,
  isCaptchaError,
  resolveCaptchaValue,
} from "./checkin.mjs";

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
  assert.equal(isAlreadyCheckedIn("验证码错误"), false);
});

test("保留旧式 4 位验证码", () => {
  assert.equal(resolveCaptchaValue("8578"), "8578");
  assert.equal(resolveCaptchaValue(" 90-50 "), "9050");
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
