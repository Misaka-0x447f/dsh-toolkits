# dsh-cloudflare-tunnel-gateway

为 DeepSeek Harness Web 指定固定的启动 token。包名保留是为了兼容已经安装到 Web profile 的插件；当前插件不运行网关，也不修改 Cloudflare 配置。

DSH Web 仍只监听 `127.0.0.1`。现有 Cloudflare Tunnel Published application 可以继续指向 `http://localhost:3080`。远程浏览器访问 `https://你的域名/?token=<固定 UUID>`，DSH 会签发浏览器会话 Cookie，随后重定向到不含 token 的 `/`。

## 安装

本包位于 `dsh-toolkits` monorepo 的 `packages/dsh-cloudflare-tunnel-gateway`。以 `link:` 方式挂到 Web profile：

```json
{
  "dependencies": {
    "dsh-cloudflare-tunnel-gateway": "link:/home/misaka/git/dsh-toolkits/packages/dsh-cloudflare-tunnel-gateway"
  },
  "dsh": {
    "profile": { "bundles": ["...", "dsh-cloudflare-tunnel-gateway"] }
  }
}
```

`pnpm install` 后重启 DSH host（host 端插件在启动时装配）。

### 包目录内必须有 `node_modules` 软链

```bash
ln -sfn ~/.dsh/profiles/node_modules packages/dsh-cloudflare-tunnel-gateway/node_modules
```

`link:` 是符号链接，Node 按 realpath 解析，会把本包当成位于 `packages/` 下，于是 `import '@deepseek-ai/schemastery'` 一路向上都找不到（实测 `ERR_MODULE_NOT_FOUND`）。`lib/index.js` 依赖这个软链才能解析运行时包。软链被 gitignore，**重新 clone 后必须手动重建**。

漏建的后果不是可见降级，而是 host 启动时该插件加载失败 → 固定 token 不生效；若你正是通过 tunnel 访问 GUI，会直接进不去。

### 测试

```bash
node --test test/*.test.mjs
```

只依赖 node 内置模块，不需要上面的软链。

## 配置

创建仅运行 DSH 的用户可读的绝对路径文件，写入一个 UUIDv4 并设为 `0600`。在 Web profile 的 `cordis.patch.yml` 中配置：

```yaml
- id: dsh-cloudflare-tunnel-gateway
  config:
    enabled: true
    fixedLaunchTokenFile: /home/USER/.dsh/cloudflare-gateway/launch-token
```

安装或更新插件后重启 DSH。插件会在启动时读取该文件，确认其为当前用户拥有的普通文件、没有组或其他用户访问权限，并检查 UUIDv4 格式。插件不在日志中输出 token。DSH 升级后若内部认证接口改变，插件会拒绝启动，以免误以为固定 token 已生效。

## 安全与轮换

任何拿到启动 token 且可以访问 DSH 域名的人都能获取 DSH 会话。建议用 Cloudflare Access 保护该域名；Access 是独立的一道认证。token 出现在 URL 时，可能被浏览器历史记录、代理和访问日志保存。

换一个 UUIDv4、覆盖 token 文件并重启 DSH，即可使旧启动链接失效。**已有的 DSH 会话 Cookie 仍可继续有效，直到到期或单独轮换 DSH 的 Cookie 签名密钥。**
