# 验证与限制

验证基线：Node 24.14.1、DSH / dsh-llm 0.2.1-rc.2、Cordis 4.0.5、Schemastery 3.18.5、OpenAI SDK 7.19.0、jose 6.2.12、TypeScript 5.9.3。精确依赖与 integrity 见 package-lock.json。

## 本地验证

`npm test` 在严格 TypeScript 编译后运行 Node test runner。当前 44 项测试全部通过，含包名、插件名、CLI 与 lockfile 的一致性回归。覆盖 Responses/SSE 与完整历史、namespace 工具往返及重复/缺失项、encrypted reasoning replay、取消恢复、跨 provider 历史、错误与用量、原生 Cordis 注册/卸载、DSH 调用准备、OAuth state/PKCE/nonce/签名、独立目录权限、refresh single-flight/轮换/锁、首调用者取消以及辅助调用的输出预算策略。测试数据全部合成，不连接真实推理或登录服务。

生产源码集中在 src/index.ts 与 src/auth.ts；构建后 `npm pack --ignore-scripts` 包含 dist、源码、测试、使用说明与配置示例，不包含账号、缓存、个人配置或 node_modules。Git 仓库不跟踪构建产物。

## 已知边界

- 仅验证原生 Cordis/LLM 服务挂载和调用准备，尚未在完整个人 DSH profile 安装并端到端运行。
- 官方动态注册是否对特定账号开放、真实 OAuth/refresh/revoke、模型与 effort/tier 的 plan 资格及真实多轮推理均未验证。
- 本地验证平台为 macOS；CI 使用 Linux。Windows 尚不支持当前 Unix 凭据权限检查。
- `allowUncappedAuxiliary` 默认 false。显式 true 才允许压缩/标题省略不支持的 maxTokens；会逐次警告，不保证原 token 上限，详见 README。
- 模型目录不是权限证明；只有真实 response.completed 能验证该次请求成功。

## 复现

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm test
npm pack --ignore-scripts
```

GitHub CI 运行同样的安装、严格编译、测试与打包步骤；不使用任何账号凭据，也不做真实 OAuth 或推理。
