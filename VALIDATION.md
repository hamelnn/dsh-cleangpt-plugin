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

## 真实授权后调用修复（2026-10-20）

使用本机用户已完成的授权，以最小合成提示验证官方 public Responses 路由：显式 `service_tier: auto` 返回 HTTP 400 / `Unsupported service_tier: auto`；省略该字段后收到 HTTP 200 与 `response.completed`。修复后通过 DSH 自身代理初始化和完整 adapter 流式调用返回 `OK` 与 finish。Auto 现在表示省略字段；其他显式选择仍原样提交，不自动降级。

新增默认 Auto 请求、非标准 `{detail: ...}` 错误和网络连接失败回归。63 项本机测试通过。该验证仅覆盖此账号的单轮文本调用，不代表所有候选模型、effort、tier 或真实工具执行均已验证；未提交或打包任何凭据。直接联网超时、使用本机已有 HTTP/HTTPS 代理成功。

独立模型代理：`proxyUrl` 使用插件自己的 HTTP/HTTPS CONNECT dispatcher，仅覆盖 catalog/Responses，Host 全局设置不变。Windows 上不启用全局代理初始化，直接设置 `http://127.0.0.1:7897` 后成功获取 7 个可见模型，并完成 `gpt-6.1-sol` 单轮真实调用，输出 `OK`。本机 65 项测试通过，包含代理参数校验与 catalog/Responses 共用私有 dispatcher。

## 工具调用终态兼容修复（2026-10-20）

真实调用复现：function_call 的 output_item.added、参数增量及 output_item.done 均完整，response.completed.output 却为 []。原实现因此误报 Missing or duplicate tool items in completed response。现在仅在终态快照为空时，使用按 output_index 排序的完整 item.done 快照恢复输出与 replay；工具名称、namespace、ID、参数及完成状态仍核验，非空终态的缺失或冲突仍拒绝。

本机 65 项测试通过，覆盖空终态工具快照及后续 replay。真实 gpt-6.1-sol 通过本机 HTTP 代理完成两轮合成 ping 工具往返：首轮 tool-calls，提交合成 OK 结果后第二轮 stop 并回复 The tool returned: OK。没有执行真实业务工具。

## 中文模型页及代理设置（0.1.2）

模型页授权状态、按钮、提示以及加速菜单完成中文适配；推理档位通过原生模型元数据提供中文名称，请求标识保持原值。模型页新增可编辑的 HTTP/HTTPS 代理地址（含端口），读取现有 profile 默认值，持久保存到独立 cleangpt_network 域，并在下一次请求动态使用。

67 项本机测试通过，覆盖无效代理拒绝、存储重新打开后恢复、空值覆盖以及模型请求切换代理。已在本机 DSH 模型页验证显示原有 7897 地址、点击保存得到成功提示，原生模型按钮显示中文推理等级。
