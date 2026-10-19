# 验证与边界

基线：Linux、Node 24.19.0、npm 11.9.0、DSH/dsh-llm 0.2.1-rc.2（源码参照 687f282e8625c6b8d11ff58211a90524be2e4317），Cordis 4.0.5、OpenAI SDK 7.19.0、jose 6.2.12。精确依赖见 package-lock.json。

`npm test` 运行严格 TypeScript、预编译浏览器 bundle 构建和 53 项测试。保留原 44 项协议/工具/reasoning replay/OAuth/刷新安全回归，新增真实 loopback 取消及迟到回调拒绝、脱敏状态、重复授权和取消、失败重试、A/B 持久化、写盘失败、会话/fork 默认、请求冻结及 SDK wire 参数断言。全部使用合成账号、临时目录和响应，无真实登录或额度调用。

`npm run test:ui` 先打 tgz，通过官方 dsh plugin CLI 在临时 DSH_HOME 全新安装 bundle，再启动真实 DSH web 与系统 Chromium/Playwright。实际页面验证 Models 状态和取消/重新授权 UI（浏览器层合成回调）、原生模型/effort 选择器与并列 session speed、真实 DSH 主循环发出合成请求、high+priority / low+default 精确参数、按钮与原生模型控件的高度/字号/行高/内边距一致、菜单键盘关闭、同会话两页面双向同步并从两页发出匹配的 tier、断线重连及迟到保存响应保护、A/B 切换、刷新恢复、生成中取消后继续发消息、写入失败不更新选中值、无页面脚本错误。脚本还完整重启 Host，并用全新浏览器验证两会话的 effort/speed 恢复。OAuth UI 点击由浏览器截获，不访问真实授权服务；Host 登录取消另有真实 loopback 测试。

生产实现 4 文件，未修改 DSH 主循环或工具。npm 包含已编译 Host/client、源码、测试、构建脚本、bundle 与安装文档；不包含账号、node_modules、缓存或个人 profile。源码 zip 包含锁文件，可重建。

## 复现

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm test
npm pack --ignore-scripts
npm install --prefix /tmp/cleangpt-test-runtime --ignore-scripts --registry=https://registry.npmjs.org @deepseek-ai/dsh@0.2.1-rc.2 playwright@1.64.1 pnpm@11.19.0
node /tmp/cleangpt-test-runtime/node_modules/playwright/cli.js install chromium
DSH_TEST_RUNTIME=/tmp/cleangpt-test-runtime npm run test:ui
# 已安装 Chromium 时可加 DSH_TEST_BROWSER=/usr/bin/chromium
```

CI 配置运行 unit/type/build/pack 和同一隔离浏览器集成脚本。以对应提交的 GitHub Actions 终态为远端结果，不以本地通过冒充远端成功。

## 尚未验证

真实 SIWC 动态注册开放资格、真实 OAuth/refresh/revoke、真实账号的模型/effort/tier 授权及订阅多轮推理；macOS 完整 UI；Windows（当前 Unix 凭据权限检查不支持）。Models 入口打开的是 Host 系统浏览器，远程使用需能操作 Host 浏览器及 loopback 回调。候选 effort/tier 绝不表示账号已获资格。

`allowUncappedAuxiliary` 默认 false，只有显式接受无服务端输出硬上限后才启用。测试 profile 显式 true 仅用于合成标题/辅助请求，不改变安装默认。用户个人 profile 未安装、配置未修改。
