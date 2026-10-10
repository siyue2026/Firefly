import { authCheck } from "./_auth.js"

// 「快捷发布」请求状态接口。
// 控制台点击「发布博客」→ POST {action:"request"} 写入发布请求；
// 随后通知云端发布通道（GitHub Actions，见 .github/workflows/cloud-publish.yml）领取任务并执行
// 同步→构建→部署，回写结果；云端未配置时，本机发布助手（scripts/publish-watcher.mjs）仍可领取。
// 控制台通过 GET 轮询展示进度。状态存放在 settings 表 key = publish_request。
//
// POST 动作：
//   { action:"request" }                                    创建发布请求（pending），已有进行中的任务时返回 409
//   { action:"claim", id }                                 发布通道领取任务（pending → running）
//   { action:"finish", id, status, message, deploymentUrl } 发布通道回写结果（running → success/failed）
//   { action:"cancel" }                                     重置卡住的请求（pending/running → cancelled）

const KEY = "publish_request"
const ACTIVE = new Set(["pending", "running"])
const MAX_MESSAGE = 500
const MAX_URL = 300

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  })
}

function str(v, max) {
  return typeof v === "string" ? v.replace(/[\r\n\t]+/g, " ").trim().slice(0, max) : ""
}

async function readState(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(KEY).first()
    if (!row) return { raw: null, state: null }
    let state = null
    try {
      const parsed = JSON.parse(row.value)
      if (parsed && typeof parsed === "object") state = parsed
    } catch {
      // 忽略损坏的数据
    }
    return { raw: row.value ?? null, state }
  } catch {
    return { raw: null, state: null }
  }
}

// 乐观并发写入：仅当当前值与读取时一致才更新，避免并发请求互相覆盖
async function casWrite(env, nextState, expectedRaw) {
  const serialized = JSON.stringify(nextState)
  if (expectedRaw === null) {
    const r = await env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO NOTHING"
    ).bind(KEY, serialized).run()
    return r.meta.changes === 1
  }
  const r = await env.DB.prepare(
    "UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ? AND value = ?"
  ).bind(serialized, KEY, expectedRaw).run()
  return r.meta.changes === 1
}

export async function onRequestGet(context) {
  const { request, env } = context
  const authFail = await authCheck(request, env)
  if (authFail) return authFail

  const { state } = await readState(env)
  return json({ request: state })
}

export async function onRequestPost(context) {
  const { request, env } = context
  const authFail = await authCheck(request, env)
  if (authFail) return authFail

  let body = {}
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const action = body.action || "request"
  const { raw, state } = await readState(env)

  if (action === "request") {
    if (state && ACTIVE.has(state.status)) {
      return json({ success: false, message: "已有发布任务正在进行中", request: state }, 409)
    }
    const next = { id: crypto.randomUUID(), status: "pending", requestedAt: new Date().toISOString() }
    const ok = await casWrite(env, next, raw)
    if (!ok) {
      const fresh = await readState(env)
      return json({ success: false, message: "发布状态已变化，请稍后重试", request: fresh.state }, 409)
    }
    // 云端发布：配置了 GitHub 令牌时，通知 GitHub Actions 领取任务；失败不阻塞，本机助手仍可作为备用通道
    let cloud = false
    const ghToken = env.GH_DISPATCH_TOKEN
    if (ghToken) {
      try {
        const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO || "siyue2026/Firefly"}/dispatches`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ghToken}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "firefly-admin-console",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({ event_type: "publish", client_payload: { id: next.id } }),
          signal: AbortSignal.timeout(8000),
        })
        cloud = res.ok
      } catch {
        cloud = false
      }
    }
    return json({ success: true, request: next, cloud })
  }

  if (action === "claim") {
    if (!state || state.id !== body.id || state.status !== "pending") {
      return json({ success: false, message: "该发布请求不存在或已被处理", request: state }, 409)
    }
    const next = { ...state, status: "running", startedAt: new Date().toISOString() }
    const ok = await casWrite(env, next, raw)
    if (!ok) {
      const fresh = await readState(env)
      return json({ success: false, message: "领取失败（状态已变化）", request: fresh.state }, 409)
    }
    return json({ success: true, request: next })
  }

  if (action === "finish") {
    if (!state || state.id !== body.id || state.status !== "running") {
      return json({ success: false, message: "该发布任务不存在或已被处理", request: state }, 409)
    }
    const next = {
      ...state,
      status: body.status === "success" ? "success" : "failed",
      finishedAt: new Date().toISOString(),
      message: str(body.message, MAX_MESSAGE),
      deploymentUrl: str(body.deploymentUrl, MAX_URL),
    }
    const ok = await casWrite(env, next, raw)
    if (!ok) {
      const fresh = await readState(env)
      return json({ success: false, message: "回写失败（状态已变化）", request: fresh.state }, 409)
    }
    return json({ success: true, request: next })
  }

  if (action === "cancel") {
    if (!state || !ACTIVE.has(state.status)) {
      return json({ success: true, request: state })
    }
    const next = { ...state, status: "cancelled", finishedAt: new Date().toISOString() }
    const ok = await casWrite(env, next, raw)
    if (!ok) {
      const fresh = await readState(env)
      return json({ success: false, message: "重置失败（状态已变化）", request: fresh.state }, 409)
    }
    return json({ success: true, request: next })
  }

  return json({ success: false, message: "未知操作：" + action }, 400)
}
