## 修复计划：签到登录验证码问题（tesseract.js 方案）

### 根因
`dounai.win` 登录新增 4 位图形验证码：`POST /auth/login` 必须携带 `captcha_code`（来源 `GET /auth/captcha`）。当前脚本不带验证码登录 → 服务器返回 `{"ret":0,"msg":"验证码错误"}` 但仍设置 PHPSESSID cookie → `login()`（scripts/checkin.mjs:126）只看有无 cookie 误判成功 → 带未认证访客会话签到被拒。

### 改动
1. **添加依赖**：`npm install tesseract.js`（v6，纯 Node/WASM，Windows 本地无需 Python）
2. **改造 `scripts/checkin.mjs`**：
   - 新增 `recognizeCaptcha()`：tesseract.js worker + 字符白名单 + PSM.SINGLE_LINE，输出清洗后的 4 位字符串，重试循环内复用 worker
   - 改造 `login()`（最多 3 次重试）：GET /auth/captcha 取验证码（保留 PHPSESSID cookie）→ 识别 → POST /auth/login 带 `captcha_code`；校验响应体 `ret === 1` 才算成功；验证码错误则刷新重试，其他错误（密码错误等）报错退出
   - 加固：`visitPanel`/`checkin` 检查 HTTP 状态码，401 明确报"会话未认证"
3. **更新 `.github/workflows/checkin.yml`**：加 `npm install` 步骤（首次运行下载 OCR 模型约 15MB）
4. **更新 `README.md`**：本地调试 `npm install` 即可

### 验证
- `node --check` 语法检查
- 本地实跑 `node scripts/checkin.mjs`（若有 .env 真实账号验证全链路；识别率不达标时备用加 jimp 预处理）
- 推送后 workflow_dispatch 手动触发验证