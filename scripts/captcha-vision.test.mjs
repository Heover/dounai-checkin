import assert from "node:assert/strict";
import test from "node:test";
import { parseCaptchaPrediction, solveCaptchaImage, VISION_MODEL } from "./captcha-vision.mjs";

test("中文及大写数字的加减乘除可以独立复算", () => {
  for (const [expression, answer] of [["玖加3", "12"], ["六 加 7", "13"], ["贰÷壹", "2"],
    ["8乘以7", "56"], ["2－8＝", "-6"]]) {
    assert.equal(parseCaptchaPrediction(JSON.stringify({ expression, answer, uncertain: false })), answer);
  }
});

test("拒绝不确定、答案矛盾、除零、非整数和任意代码", () => {
  for (const value of ["not json", '{"uncertain":true}',
    ...[["2+3", "6"], ["2/0", "0"], ["3/2", "1.5"], ["process.exit()", "1"]]
      .map(([expression, answer]) => JSON.stringify({ expression, answer, uncertain: false }))]) {
    assert.throws(() => parseCaptchaPrediction(value));
  }
});

test("只向 DeepSeek 官方端点发送验证码图片，关闭重定向", async () => {
  const result = await solveCaptchaImage(Buffer.from("fixture-image"), {
    apiKey: "test-only", fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.deepseek.com/chat/completions");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, "Bearer test-only");
      const body = JSON.parse(options.body);
      assert.equal(body.model, VISION_MODEL);
      assert.equal(body.messages.length, 1);
      assert.ok(body.messages[0].content[1].image_url.url.startsWith("data:image/png;base64,"));
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"expression":"2/1","answer":"2","uncertain":false}' } }] }) };
    },
  });
  assert.equal(result, "2");
});

test("缺少密钥不发请求，API 失败不会泄露密钥或原始报错", async () => {
  await assert.rejects(solveCaptchaImage(Buffer.from("image"), { apiKey: "" }), /缺少/);
  await assert.rejects(solveCaptchaImage(Buffer.from("image"), {
    apiKey: "test-only", fetchImpl: async () => ({ ok: false, status: 401 }),
  }), /HTTP 401/);
  await assert.rejects(solveCaptchaImage(Buffer.from("image"), {
    apiKey: "test-only", fetchImpl: async () => { throw new Error("secret-value"); },
  }), (error) => !error.message.includes("secret-value"));
});
