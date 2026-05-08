# Guga API Relay

部署在 **Replit 外面**（render.com / Fly / VPS）的哑管道，唯一职责是**配合 Replit 节点反 300s 截断**。

## 为什么需要它

Replit Autoscale GFE 对入站 HTTPS 连接强制 300 秒上限。客户端 ↔ 节点的长流（思考型大模型、大段生成）会在 5 分钟整点被悄悄掐掉。

加上 relay 后链路变成：

```
客户端 ──长 HTTP（Render 上无 300s 墙）──▶ guga-relay ──pull 协议(每次轮询 < 240s)──▶ Replit 节点 ──▶ (节点内部链路：p2p 借调 / 上游)
```

每一段都不会被 300s 杀。

## guga-relay 不做什么

它是**哑管道**——和"哑配额管道"同一种思路。**所有业务语义都不参与**：

- ❌ 不识别 provider、不带 provider 字段
- ❌ 不做节点白名单 / 鉴权 / `COMM_KEY`
- ❌ 不过滤 header（节点侧自己有黑名单）
- ❌ 不做 CORS / `/health` / 任何额外端点
- ❌ 不知道客户端发了什么、节点返回了什么

## guga-relay 只做什么

1. 监听端口
2. 把入站 URL 第一段当节点域名（纯字符串切分）
3. 把 method / 剩余 path / query / headers / body 原封塞进 `runPullSession` 的 start payload
4. 通过 pull 协议（多次短 HTTP 长轮询）把响应字节按序拉回，原封写回客户端
5. 客户端断开 → cancel 上游

## URL 形式

```
https://<relay-域名>/<节点域名>/<原本要打节点的路径>
```

例：客户端原本打 `https://my-node.replit.app/v1/messages`，加上 relay 后改打 `https://my-relay.onrender.com/my-node.replit.app/v1/messages`。客户端代码除了 base_url 之外**不需要任何改动**。

## 部署

### Render（Blueprint）

1. push 到 GitHub
2. Render → New → Blueprint → 连仓库
3. Render 自动读 `render.yaml`

### 手动

- Build Command: `npm install`
- Start Command: `npm start`
- 无强制环境变量

## 本地调试

```bash
pnpm --filter @workspace/relay dev
# relay 监听 :8080
```

## 备注

- `src/pullClient.ts` 与 `artifacts/api-server/src/lib/pullClient.ts` 同源但**裁剪了 provider 字段**（哑管道不带业务字段）。两边以后要共用就提到 `lib/*`。
- `express.raw` 的 `limit` 字段是库的硬性约束（必须有数字），设到 1GB 让它实际不构成限制——这不是 relay 的策略选择。
