// Pull 协议 borrower 端 —— 纯传输层。
//
// 不知道、也不需要知道 startPayload 里装的是什么。它只做三件事：
//   1. POST /cluster/pull/start  → 拿 sessionId
//   2. 循环 POST /cluster/pull/:id/poll（每段 ≤240s）→ 收 first / chunks
//   3. 客户端断开 → POST /cluster/pull/:id/cancel
//
// 不参与 HTTP 语义、不感知 provider / 模型 / 端点；这些是 index.ts（反代外壳）
// 的事。

const logger = {
  warn: (obj: unknown, msg: string): void => console.warn(`[pullClient] ${msg}`, obj),
};

export interface RunOpts {
  peerUrl: string;
  startPayload: unknown;        // 不透明 JSON blob，原样喂给 lender
  signal?: AbortSignal;
  pollWaitMs?: number;
  onFirst?: (status: number, headers: Record<string, string>) => void;
  onChunk?: (bytes: Buffer, seq: number) => void;
}

export interface RunResult {
  ok: boolean;
  errorMessage?: string;
}

interface PollResultWire {
  first?: { status: number; headers: Record<string, string> };
  chunks: { seq: number; dataB64: string }[];
  done: boolean;
  error?: { message: string };
  nextSeq: number;
}

const DEFAULT_POLL_WAIT_MS = 240_000;
const RETRY_BACKOFF_MS = [200, 500, 1500, 4000, 8000];

export async function runPullSession(opts: RunOpts): Promise<RunResult> {
  const peer = opts.peerUrl.replace(/\/+$/, "");

  let sessionId: string;
  try {
    const resp = await fetch(`${peer}/cluster/pull/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts.startPayload),
      signal: opts.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { ok: false, errorMessage: `start failed: ${resp.status} ${text.slice(0, 200)}` };
    }
    const body = await resp.json() as { sessionId: string };
    sessionId = body.sessionId;
  } catch (err) {
    return { ok: false, errorMessage: `start network error: ${(err as Error).message}` };
  }

  let since = 0;
  let ack = 0;
  let firstSeen = false;
  let backoffIdx = 0;

  while (true) {
    if (opts.signal?.aborted) {
      void sendCancel(peer, sessionId);
      return { ok: false, errorMessage: "borrower aborted" };
    }

    let result: PollResultWire;
    try {
      const resp = await fetch(`${peer}/cluster/pull/${sessionId}/poll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ since, ack, maxWaitMs: opts.pollWaitMs ?? DEFAULT_POLL_WAIT_MS }),
        signal: opts.signal,
      });
      if (!resp.ok) {
        if (resp.status === 404) {
          return { ok: false, errorMessage: "session expired (404)" };
        }
        await backoff(backoffIdx++);
        continue;
      }
      result = await resp.json() as PollResultWire;
      backoffIdx = 0;
    } catch (err) {
      if (opts.signal?.aborted) {
        void sendCancel(peer, sessionId);
        return { ok: false, errorMessage: "borrower aborted during poll" };
      }
      logger.warn({ err: (err as Error).message }, "poll network error, retrying");
      await backoff(backoffIdx++);
      continue;
    }

    if (!firstSeen && result.first) {
      firstSeen = true;
      opts.onFirst?.(result.first.status, result.first.headers);
    }

    for (const c of result.chunks) {
      const bytes = Buffer.from(c.dataB64, "base64");
      try { opts.onChunk?.(bytes, c.seq); } catch { /* receiver error: ignore */ }
      since = c.seq + 1;
    }
    ack = since;

    if (result.error) return { ok: false, errorMessage: result.error.message };
    if (result.done) return { ok: true };
  }
}

async function sendCancel(peer: string, id: string): Promise<void> {
  try {
    await fetch(`${peer}/cluster/pull/${id}/cancel`, { method: "POST" });
  } catch { /* swallow */ }
}

function backoff(idx: number): Promise<void> {
  const ms = RETRY_BACKOFF_MS[Math.min(idx, RETRY_BACKOFF_MS.length - 1)];
  return new Promise((resolve) => setTimeout(resolve, ms));
}
