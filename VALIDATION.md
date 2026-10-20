# 验证与边界

基线：Linux、Node 24.19.0、npm 11.9.0、DSH/dsh-llm 0.2.1-rc.2（源码参照 687f282e8625c6b8d11ff58211a90524be2e4317），Cordis 4.0.5、OpenAI SDK 7.19.0、jose 6.2.12。精确依赖见 package-lock.json。

`npm test` 运行严格 TypeScript、预编译浏览器 bundle 构建和 56 项测试。保留原 44 项协议/工具/reasoning replay/OAuth/刷新安全回归，新增真实 loopback 取消及迟到回调拒绝、脱敏状态、重复授权和取消、失败重试、A/B 持久化、写盘失败、会话/fork 默认、请求冻结、安装 bundle 全部默认候选、任意未来/旧配置候选及 SDK wire 参数断言。loopback 测试使用隔离 PATH 中的 `open` / `xdg-open` 替身，禁止真实浏览器与外部网络调用；无论断言是否失败，均先取消并等待 login 结束，再恢复全局状态。额外回归在主动制造断言失败后检查 listener、凭据锁及全局状态清理。全部使用合成账号、临时目录和响应，无真实登录或额度调用。

`npm run test:ui` 先打 tgz，通过官方 dsh plugin CLI 在临时 DSH_HOME 全新安装 bundle，再启动真实 DSH web 与系统 Chromium/Playwright。实际页面验证 Models 状态和取消/重新授权 UI（浏览器层合成回调）、原生模型/effort 选择器与并列 session speed、真实 DSH 主循环发出合成请求、所有默认 effort/tier、Ultrafast、显式未来/旧配置候选的菜单到 SDK 精确参数、按钮与原生模型控件的高度/字号/行高/内边距一致、菜单键盘关闭、同会话两页面双向同步并从两页发出匹配的 tier、断线重连及迟到保存响应保护、A/B 切换、刷新恢复、生成中取消后继续发消息、写入失败不更新选中值、无页面脚本错误。脚本还完整重启 Host，并用全新浏览器验证两会话的 effort/speed 恢复。OAuth UI 点击由浏览器截获，不访问真实授权服务；Host 登录取消另有真实 loopback 测试。

生产实现 5 文件（含跨平台凭据权限模块），未修改 DSH 主循环或工具。npm 包含已编译 Host/client、源码、测试、构建脚本、bundle 与安装文档；不包含账号、node_modules、缓存或个人 profile。源码 zip 包含锁文件，可重建。

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

CI 在 Linux、macOS 与 Windows 上运行 unit/type/build/pack（包括各平台浏览器替身及失败清理回归），Linux 另运行同一隔离浏览器集成脚本。以对应提交的 GitHub Actions 终态为远端结果，不以本地通过冒充远端成功。

## 尚未验证

真实 SIWC 动态注册开放资格、真实 OAuth/refresh/revoke、真实账号的模型/effort/tier 授权及订阅多轮推理；macOS 完整 UI；Windows 完整 UI 与真实账号登录。Models 入口打开的是 Host 系统浏览器，远程使用需能操作 Host 浏览器及 loopback 回调。候选 effort/tier 绝不表示账号已获资格。

`allowUncappedAuxiliary` 默认 false，只有显式接受无服务端输出硬上限后才启用。测试 profile 显式 true 仅用于合成标题/辅助请求，不改变安装默认。用户个人 profile 未安装、配置未修改。

## Windows 适配验证（0.1.1）

本机 Node 24.22.0 / Windows：严格编译与 60 项合成测试。新增 NTFS 私有 DACL 创建、Unicode 与特殊字符路径、Everyone 可读文件拒绝、继承权限拒绝、目录 junction 拒绝。Windows 浏览器启动由合成子进程替身验证；没有真实登录、注册或推理。Unix 保留原有 uid、0700/0600 和 O_NOFOLLOW 检查。
