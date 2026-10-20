# dsh-cleangpt-plugin

DSH 原生模型插件，通过 OpenAI 官方 Sign in with ChatGPT（SIWC）使用自己授权的 ChatGPT plan。请求直达 `https://api.openai.com/v1/responses`；保留 DeepSeek Harness 的主循环、工具执行、会话日志与取消机制。

**当前状态：实验性实现，严格编译与 mock 测试通过；真实注册、登录、模型资格与订阅推理尚未验证。** 不包含任何真实凭据。

## 架构与范围

核心是 `src/index.ts` 一个文件：继承官方 `LlmAdapter`，用官方 `openai` SDK 处理 HTTP/SSE，再映射 DSH 消息与流事件。`src/auth.ts` 是独立认证文件：Node 内置 PKCE/loopback 与成熟 `jose` 验签。没有 Codex 子进程、代理服务器、网页 cookie 或私有 `backend-api`。

验证基线：Node 24.14.1、npm 11.11.0、DSH / `@deepseek-ai/dsh-llm` 0.2.1-rc.2。运行依赖：`openai` 7.19.0、`jose` 6.2.12；Cordis 与 LLM 接口作为 peer dependencies。依赖来自 npm 官方注册源，安装时禁用生命周期脚本。没有抄用第三方 ChatGPT 插件。

优先评估过官方 DSH `PiAiAdapter`：其公开构造参数没有暴露本路由需要的请求转换钩子。直接使用 OpenAI SDK 的薄适配层比引入并改造整个 pi-ai 路由更小，也能明确处理 namespace、完整历史和流中失败。

## 源码检查与构建

在解压的源码目录运行（只安装开发依赖，不启用 DSH 插件）：

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm test
npm pack --ignore-scripts
```

Git 仓库与源码包保留 `package-lock.json`，可用 `npm ci` 重建。可安装 tgz 同时包含已编译 `dist`、源码、测试和配置示例；npm 打包规则不包含 package-lock。要求 Node 24+。支持 Linux、macOS 和 Windows；Windows 使用系统自带的 Windows PowerShell 5.1 检查 NTFS ACL，无需管理员权限。CI 在三个系统运行编译与 mock 测试，真实账号授权与推理仍需单独验证。

## 手动安装与授权

先审阅代码。只有决定安装时，才运行如下命令，将本地包加到你选定的 DSH profile：

```sh
dsh plugin --profile web add /ABSOLUTE/PATH/dsh-cleangpt-plugin-0.1.1.tgz
```

安装会自动加入插件 bundle，挂载 Host provider 和预编译浏览器 UI；内部模型 route 保持 `chatgpt-plan`。

重启 DSH，打开 Settings → Models → ChatGPT subscription。点击 Continue with ChatGPT 会在 **Host 电脑的系统浏览器**打开官方授权页；等待期间可取消，已登录可重新授权。远程浏览器用户需要能够操作 Host 浏览器及其 loopback 回调。前端不会获得 token、OAuth URL 或 ID-token hint。若需要改账号标签或 authDir，参考 `example.cordis.patch.yml` 覆盖该 profile 配置；config 整体替换，保留你需要的其他字段。

登录与创建注册会产生**持续访问权限**：可在当前登录用户的本机保存和刷新你明确授予的 ChatGPT plan 权限。运行前须由你具体批准。开发过程中不执行以下命令：

```sh
# 在源码目录使用自己的独立认证 CLI；ACCOUNT 为本插件的本地标签。
node dist/auth.js login default --approve-access
```

CLI 在系统浏览器展示官方授权页。`--approve-access` 是显式操作门槛，不表示开发者或测试已获授权。首次以 `dynamic_agent_client` 注册真实名称 `dsh-cleangpt-plugin`，生成并持久保存此插件的 `urn:uuid:…` host ID；回调取得 issued client ID 后，用它换码和复用后续登录。不需要 client secret、partner API key 或付费 API key。如果官方动态注册尚未对你的账号/部署开放，应停止并报告官方拒绝，不改走其他客户端 ID 或非公开端点。

默认凭据目录 `~/.config/dsh-cleangpt-plugin`，Unix 目录 0700、文件 0600。Windows 新目录以受保护的 DACL 创建，仅授予当前用户访问权，凭据文件继承此权限；读取时校验所有者和 ACL（提升权限的管理员进程也接受 Administrators 组所有权），只允许当前用户、SYSTEM 和 Administrators，拒绝其他主体、符号链接和重解析点。已有不安全目录会报错，不会自动改写权限。`DSH_CLEANGPT_AUTH_DIR` 只控制登录 CLI；若改变它，provider 的 `authDir` 必须设置为同一绝对路径。`host` 为保留标签，不能作为账号名，以免与 host ID 文件冲突。每个账号/工作区注册使用不同本地标签，分别保存 client ID、已验证 subject、scope 和 token；切换 provider 的 `account` 后重载配置，模型目录重新从该账号获取。相同邮箱不合并注册。活动标签在 provider 名称中显示。

```sh
node dist/auth.js accounts
node dist/auth.js login work --approve-access
node dist/auth.js logout default
```

`logout` 撤销本插件的 renewable session 并清除本地 token，保留 client/account 映射与 host ID。撤销失败时仍会明确说明“仅本地退出”，可在 ChatGPT Settings 断开应用。不会修改其他应用的登录。

## 模型、思考强度与加速模式

- 模型：用相同 OAuth access token 读取官方 `/v1/models` 的 `models` 数组，按服务端顺序展示 `visibility: list`，显示 `display_name`，请求用 `slug`。不硬编码模型名单。底层也允许显式模型 ID，由服务端验证。
- 思考强度：`reasoningEffort` 默认省略；任意显式字符串原样作为 `reasoning.effort`。`reasoningEfforts` 默认列出公开 Responses 候选 `none/minimal/low/medium/high/xhigh/max`，也允许任意未来字符串；这是放进 DSH 原生选择器的候选列表，**不是已验证的服务端能力**。可填写服务端正式支持的新值；插件不改写、不降档。配置默认强度会注册并在 DSH 准备请求时记录。
- 加速：输入框旁的同一个 DSH 原生 Speed 菜单默认提供 `auto/default/fast/ultrafast/priority/flex/scale`，Auto 省略 `service_tier`，由服务器选择；其余选项原样发送。Auto 是新会话及无 sessionId 调用的默认值；其他选项均标明 server validates。Fast 使用 `fast`，Priority 使用 `priority`，保留两种写法而不改写；Ultrafast 使用 `ultrafast`。`serviceTiers` 可配置其他/未来字符串；兼容的 `serviceTier` 单值也会加入同一菜单候选，不再作为全局默认。已保存的候选即使随后从配置移除，仍按原字符串显示和恢复。插件不新增 effort 控件。
- 官方 SIWC 文档目前没有定义完整 effort/tier 能力目录 schema，因此不猜测 catalog 中的未文档化字段，也不声称“所有账号支持所有模型和强度”。只有收到真实 `response.completed` 才算本次资格与推理成功。目录出现模型、成功登录、或 mock 通过均不能证明有资格。

可选配置示例：

```yaml
config:
  account: default
  reasoningEffort: high
  reasoningEfforts: [none, minimal, low, medium, high, xhigh, max]
  serviceTiers: [auto, default, fast, ultrafast, priority, flex, scale, future-tier]
  # serviceTier: legacy-tier  # 兼容旧配置：加入菜单候选，默认仍 Auto
```

speed 使用 DSH 自带紧凑按钮/菜单，与原生模型/effort 控件同高。Host 的 cleangpt storage domain 以 sessionId 为键持久化，成功落盘后 UI 才更新。同会话的多个 tab 通过 Host 持久化变更通知同步；断线重连重新读取，旧会话/旧读取及迟到保存响应不会覆盖较新状态。A/B 会话互不影响；切回、刷新和重启恢复同一会话的值，新会话和 fork 默认 Auto，不自动继承。无 sessionId 的辅助调用也明确使用 Auto。一次请求及同 turn/step 的内部重试冻结首次档位，用户切换影响后续新请求。取消不会自动重发任务，之后仍可继续发消息；插件不回滚工具的外部副作用。effort 的保存和恢复完全由 DSH 原生会话选择机制承担。

## 协议、错误与数据处理

每次请求强制 `store: false` / `stream: true`，把完整历史放入 `input`，把 system 转成 developer，不使用 `previous_response_id`。只显式构造支持的字段；`temperature`、`stop` 或普通聊天显式 `maxTokens` 会在发送前报 `UNSUPPORTED_OPTION`，避免静默忽略。压缩/标题的 maxTokens 采用下一节的显式兼容策略。其他禁止字段不会生成。

DSH function tools 放在 `dsh` namespace；函数名保持原值，返回的 `namespace` 单独校验，`call_id` 关联结果。工具只由 DSH 执行，provider 不执行代码。支持流式文本、refusal、推理摘要、工具参数、usage、用户取消和消费者提前退出。原生 reasoning 与 encrypted_content 跟随成功响应保存到 DSH replayState，下一轮在同模型同路由且内容未改变时完整重放。内容被改写时不重放旧内容。取消或跨 provider 导致没有原生 replay 时，保留可见 reasoning 摘要为带 `[Prior reasoning summary]` 标记的 assistant 文本；不伪造 encrypted_content，不提升为 system 指令。不可恢复的隐藏推理不会被杜撰。默认未请求 reasoning summary，但服务端若返回仍能恢复。

用量遵循 DSH 的不重叠计数：从 input 总数扣除 cache hit，再单列 cacheReadTokens；保留 output、total 与 reasoning tokens。它不是账号余额、剩余额度或费用承诺。

`response.failed`、`response.incomplete`、显式 error、断流、未声明工具、缺失/重复/乱序的工具项与空响应均失败；不会把部分文本当成功。HTTP status、code、param、request ID 保留，SDK 原始结构在 error cause 中。默认不打印响应正文或凭据。`unsupported_capability`、403、额度限制不自动换模型/强度/计费路径，不循环登录。SDK 自己不重试；DSH 的标准 retry 插件若启用，只对初始 HTTP 503 的 `SERVER_UNAVAILABLE` 最多退避重试两次，其他失败直接返回。没有 retry 插件时 503 也直接返回。

OAuth 使用 state、nonce、PKCE S256、`127.0.0.1` 随机端口 `/auth/callback`，严格验证返回 ID 与首次 nonce、签名、issuer、audience、有效期和原账号 subject。只信任 OpenAI OIDC discovery 的同域 HTTPS 端点。请求不跟随重定向，也不继承环境中的 OpenAI organization/project。scope 缺少 `chatgpt.tokens.use.direct` 时保留身份但阻止推理。

刷新在同进程合并并发调用，共享轮换使用独立的 30 秒超时；取消调用只退出自身等待，不中断其他调用者的刷新。跨进程用目录锁排他，轮换 token 与 expiry/scope 一起原子写入。另一个进程占锁时明确失败并提示稍后重试。请求发送前记录 refresh_pending；若断网/崩溃导致刷新结果不确定，保留记录并停止重放旧 refresh token，须主动重新授权。锁因进程崩溃残留时，确认没有本插件/登录进程在运行后才手动删除 `.lock`。不自动删锁，不盲目重试旋转 token。

## 原生压缩与标题的输出上限

已核对本机 DSH 0.2.1-rc.2：`compaction-basic` 的 summarizer 与 `session-title-llm` 都会无条件传 `maxTokens`；LLM 元数据接口没有“不支持输出上限”的能力协商字段。官方订阅路由禁止 `max_output_tokens`，因此无法等价执行这个上限。

默认 `allowUncappedAuxiliary: false`：辅助调用带上限时明确拒绝；自动压缩和标题不会由此 provider 成功完成。要在此协议上使用这两项辅助功能，需要明确选择：

```yaml
config:
  account: default
  allowUncappedAuxiliary: true
```

只有 `purpose: compaction` / `session-title` 会采用该选择：省略不受支持的上限，同时通过 DSH 日志逐次警告“请求的 maxTokens 未执行”。没有增加指令假装强制长度，没有切换模型/付费路径；普通聊天仍不接受带 maxTokens 的请求。

**预算边界：开启后辅助生成不受原 maxTokens 服务端硬上限约束，可能产生更多输出并消耗更多 plan 额度。** DSH 请求日志中的 maxTokens 保留为原始请求值，不代表服务端已执行；必须连同本策略与警告解读。模型自身限制、调用方 deadline、SDK 超时和取消仍有效，但不是 token 预算保证。若必须遵守精确输出预算，请保持 false；本协议没有等价能力，不能声称全部原生辅助功能在默认配置下可用。压缩后的结果大小仍由 DSH 自己处理，本插件不修改主循环。

## 当前未验证与限制

真实 OAuth 注册/浏览器回调、refresh 生产行为、模型/强度/tier 权限、真实 function tools、多轮 encrypted reasoning，以及完整已安装 DSH UI 的体验仍须在明确批准后验证；当前没有索取或使用真实凭据。没有客户端注册 ID 阻塞代码，因为官方允许动态首登；真实能力开放状态仍未知。

这是刻意精简的**文本 + DSH function tools** provider；不宣称图像/音频/视频或 hosted tools。遇到未支持内容会明确失败。模型目录不会自动猜测上下文长度或推理能力；DSH 原生思考选择器需要显式 `reasoningEfforts` 候选。未实现订阅余额查询、hosted MCP、上传文件或跨设备凭据迁移。CLI 超时/网络失败会停止，不在后台维持登录或继续额度请求。已启动的共享 token 轮换可在调用方取消后继续，最长 30 秒，以安全保存结果；它不发起模型推理。

## 官方依据

- [OpenAI：Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [OpenAI：Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [OpenAI：Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [OpenAI：Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [OpenAI：Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
- [OpenAI：Token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)
- [OpenAI：OIDC/JWKS 示例](https://developers.openai.com/siwc/website)（只复用验签指导，注册采用上面的 OSS 专门流程）
- [DSH 官方仓库](https://github.com/deepseek-ai/deepseek-harness)：参考本机 0.2.1-rc.2 发布包的 `LlmAdapter` / Cordis / Schemastery 类型，并核对官方 architecture、AGENTS、package-surface、general 与错误处理指南。精确依赖见 package-lock。

测试结果、LOC 和打包证据见 `VALIDATION.md`。

## 测试数据与公开发布

测试中的 bearer/token/client ID/subject 全部是带 mock 标记的合成值，RSA 密钥仅在测试进程中临时生成；不包含保存的账号文件或真实授权。Git 公开范围为源码、测试、锁文件、MIT LICENSE 与使用配置；dist、安装包、认证目录、研究下载与本机日志均忽略。仓库未发布 npm，也不会自动安装 DSH profile 或自动发起登录。

## 升级与卸载

升级：保存需要的 profile 覆盖配置，执行同一 `dsh plugin --profile web add /ABSOLUTE/PATH/新包.tgz` 并重启。旧版若手工插入过同 id 的条目，请先移除重复 insert，保留 `- id: dsh-cleangpt-plugin` 配置覆盖。安装和升级不会发起真实授权。

卸载：如需撤销授权，先显式执行 `dsh-cleangpt-plugin logout ACCOUNT`；随后 `dsh plugin --profile web remove dsh-cleangpt-plugin`，移除该 profile 中插件的配置覆盖并重启。卸载不自动删除独立凭据目录或持久化会话偏好；确认不再使用后可手动清理插件专属数据。不会改动其他应用凭据。

公开候选依据（2026-10-19 核对）：[Reasoning guide](https://developers.openai.com/api/docs/guides/reasoning)、[Fast mode](https://developers.openai.com/api/docs/guides/fast-mode)、[Ultrafast mode（含 HTTP）](https://developers.openai.com/api/docs/guides/ultrafast-mode)，以及已锁定官方 OpenAI SDK 7.19.0 的 Responses ServiceTier 类型。API 文档不是 SIWC/plan 资格证明；每个模型可能拒绝部分 effort/tier。`ultra` 不在默认 effort 候选中，不声称官方 SIWC 支持。服务端拒绝时保留实际错误码、参数和请求 ID，不做候选降档或静默替换。

### 独立模型代理

可在目标 profile 的 `cordis.patch.yml` 设置：

```yaml
- id: dsh-cleangpt-plugin
  config:
    proxyUrl: http://127.0.0.1:7897
```

该配置仅用于本插件的模型列表与 Responses 推理请求，优先于 DSH 的全局代理。留空沿用 Host 网络设置；支持 HTTP/HTTPS 代理，不接受 SOCKS URL、内嵌凭据或路径。OAuth 登录和续期仍使用 Host 网络设置。插件卸载时关闭自己的连接池，不修改其他插件的代理。代理连接失败会报错，不自动改为直连。
