// Guga API Relay
//
// 反代外壳。唯一作用：补上客户端不支持的「pull 协议（每段 ≤240s 短轮询）」机制，
// 让客户端 ↔ 节点的长 HTTPS 不被 *.replit.app 入站 ~300s GFE 墙截断。
//
// 客户端 ──长 HTTP──▶ guga-relay ──pull 协议（每段 ≤240s 短轮询）──▶ 节点
//
// guga-relay 不识别 provider / 模型 / 端点语义。
// 它只把客户端发来的整个 HTTP 请求当作不透明 blob 灌进 pull 协议，
// 把节点回的字节流原封写回客户端。
//
// URL 形式（客户端把这串当 base_url 即可，无需改造）：
//   https://<guga-relay 域名>/<节点域名>/<原本要打节点的路径>

import express, { type Request, type Response } from "express";
import { runPullSession } from "./pullClient.js";

const PORT = parseInt(process.env.PORT ?? "8080", 10);

const app = express();
app.disable("x-powered-by");

// 抓原始字节，不解析。1GB 是 express.raw 的硬性约束（必须有数字），
// 设到这个量级让它不构成业务限制。
app.use(express.raw({ type: "*/*", limit: "1gb" }));

app.use((req, res) => {
  void handle(req, res).catch((err) => {
    console.error("[relay] handler crash:", err);
    if (!res.headersSent) res.status(500).end();
    else if (!res.writableEnded) res.end();
  });
});

async function handle(req: Request, res: Response): Promise<void> {
  // URL 第一段 = 节点域名（纯字符串切分），后面整段（path + query）原样转给节点
  const m = /^\/([^/]+)(\/.*)?$/.exec(req.url);
  if (!m) { res.status(400).end(); return; }
  const peerUrl = `https://${m[1]}`;
  const rest = m[2] ?? "/";
  const qIdx = rest.indexOf("?");
  const upstreamPath = qIdx === -1 ? rest : rest.slice(0, qIdx);
  const query = qIdx === -1 ? undefined : rest.slice(qIdx + 1);

  // headers 原样收，不挑、不过滤、不重命名
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(", ");
    else if (typeof v === "string") headers[k.toLowerCase()] = v;
  }

  const bodyB64 = (Buffer.isBuffer(req.body) && req.body.length > 0)
    ? req.body.toString("base64")
    : undefined;

  // pull 协议 borrower 拿到的是不透明 blob —— 上面这几个字段是节点 lender 端约定的形状，
  // 不是 pull 协议本身的字段。
  const startPayload = {
    method: req.method,
    upstreamPath,
    query,
    headers,
    bodyB64,
  };

  const abort = new AbortController();
  let clientGone = false;
  res.on("close", () => {
    if (!res.writableEnded) {
      clientGone = true;
      abort.abort();
    }
  });

  let headersWritten = false;
  const result = await runPullSession({
    peerUrl,
    startPayload,
    signal: abort.signal,
    onFirst: (status, h) => {
      if (clientGone) return;
      try { res.writeHead(status, h); headersWritten = true; }
      catch (err) { console.warn("[relay] writeHead failed:", (err as Error).message); }
    },
    onChunk: (bytes) => {
      if (clientGone) return;
      try { res.write(bytes); } catch { /* client gone */ }
    },
  });

  if (clientGone) return;
  if (!result.ok && !headersWritten) { res.status(502).end(); return; }
  res.end();
}

const server = app.listen(PORT, () => {
  console.log(`[relay] listening on :${PORT}`);
});
// 关 Node 默认 300s requestTimeout，免得 relay 自己掐死客户端长连接
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 65_000;
