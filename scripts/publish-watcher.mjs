/**
 * Firefly 本机发布助手（按需启动模式）
 *
 * 作用：轮询控制台的「发布请求」，自动执行 数据同步 → 构建 → 部署（即 publish-site.mjs 全流程），
 * 并把结果回写到控制台。控制台右上角的「发布博客」按钮需要本助手处于运行状态。
 *
 * 按需使用：平时无需常驻——要发布时双击 scripts/publish-watcher.cmd 启动，
 * 处理完任务后若连续空闲（默认 30 分钟）会自动退出；期间也可随时关闭窗口。
 *
 * 用法：ADMIN_TOKEN=xxx node scripts/publish-watcher.mjs
 * （或直接双击 scripts/publish-watcher.cmd，已内置 token 与运行目录）
 *
 * 可选环境变量：
 *   PUBLISH_API        发布接口地址，默认 https://firefly-cv5.pages.dev/api/admin/publish
 *   POLL_INTERVAL      轮询间隔毫秒，默认 4000
 *   IDLE_EXIT_MINUTES  连续空闲多少分钟后自动退出，默认 30；设为 0 表示不自动退出（一直监听）
 *
 * 参数：
 *   --once  只检查并处理一轮后退出（调试用）
 */
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"

const API = process.env.PUBLISH_API || "https://firefly-cv5.pages.dev/api/admin/publish"
const TOKEN = process.env.ADMIN_TOKEN
const INTERVAL = Math.max(2000, Number(process.env.POLL_INTERVAL) || 4000)
const IDLE_MINUTES = (() => {
  const v = Number(process.env.IDLE_EXIT_MINUTES)
  return Number.isFinite(v) ? v : 30
})()
const IDLE_MS = IDLE_MINUTES > 0 ? IDLE_MINUTES * 60 * 1000 : Infinity
const ONCE = process.argv.includes("--once")
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

if (!TOKEN) {
  console.error("[发布助手] 缺少 ADMIN_TOKEN 环境变量。请使用 scripts/publish-watcher.cmd 启动，或先执行 export ADMIN_TOKEN=xxx。")
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stamp = () => new Date().toLocaleTimeString("zh-CN", { hour12: false })
const log = (msg) => console.log(`[发布助手 ${stamp()}] ${msg}`)

async function api(action, payload) {
  const res = await fetch(API, {
    method: action ? "POST" : "GET",
    headers: { Authorization: TOKEN, "Content-Type": "application/json" },
    body: action ? JSON.stringify({ action, ...payload }) : undefined,
  })
  let data = null
  try {
    data = await res.json()
  } catch {}
  if (!res.ok) {
    const err = new Error((data && data.message) || "HTTP " + res.status)
    err.status = res.status
    throw err
  }
  return data
}

// 执行发布：spawn 子进程并实时转发输出，同时缓存全文用于提取部署地址 / 失败原因
function runPublish() {
  return new Promise((resolve) => {
    log("开始执行：同步线上数据 → 构建 → 部署")
    const child = spawn(process.execPath, ["scripts/publish-site.mjs"], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    const onData = (chunk) => {
      const text = chunk.toString()
      output += text
      process.stdout.write(text)
    }
    child.stdout.on("data", onData)
    child.stderr.on("data", onData)
    child.on("error", (e) => resolve({ code: -1, output: output + "\n" + String(e) }))
    child.on("close", (code) => resolve({ code, output }))
  })
}

function extractDeploymentUrl(output) {
  const m = output.match(/https:\/\/[a-z0-9-]+\.firefly-cv5\.pages\.dev/i)
  return m ? m[0] : ""
}

async function finish(id, status, message, deploymentUrl) {
  try {
    await api("finish", { id, status, message, deploymentUrl })
    log("已将结果回写到控制台")
  } catch (e) {
    log(`回写结果失败：${e.message}`)
  }
}

async function handleRequest(req) {
  try {
    await api("claim", { id: req.id })
    log("已领取发布任务")
  } catch (e) {
    log(`领取任务失败（可能已被处理）：${e.message}`)
    return
  }

  const started = Date.now()
  const { code, output } = await runPublish()
  const seconds = Math.round((Date.now() - started) / 1000)

  if (code === 0) {
    const url = extractDeploymentUrl(output)
    log(`发布成功（耗时 ${seconds} 秒）${url ? "：" + url : ""}`)
    await finish(req.id, "success", "", url)
  } else {
    const tail = output.replace(/\s+/g, " ").trim().slice(-400)
    log(`发布失败（退出码 ${code}，耗时 ${seconds} 秒），请查看上方日志排查`)
    await finish(req.id, "failed", "退出码 " + code + "：" + tail, "")
  }
}

async function tick() {
  const data = await api(null)
  const req = data && data.request
  if (req && req.status === "pending") {
    log(`收到发布请求（提交于 ${req.requestedAt}），处理中…`)
    await handleRequest(req)
    return true
  }
  return false
}

async function main() {
  log(`发布助手已启动，轮询间隔 ${INTERVAL}ms`)
  log(`接口：${API}`)
  log(`仓库目录：${repoRoot}`)
  if (IDLE_MS === Infinity) {
    log("空闲自动退出：已关闭（IDLE_EXIT_MINUTES=0），将持续监听，直到窗口被关闭")
  } else {
    log(`按需模式：连续空闲 ${IDLE_MINUTES} 分钟将自动退出；期间可随时关闭本窗口`)
  }

  if (ONCE) {
    try {
      await tick()
    } catch (e) {
      log(`检查失败：${e.message}`)
    }
    return
  }

  let lastError = ""
  let lastActiveAt = Date.now()
  while (true) {
    try {
      const handled = await tick()
      lastError = ""
      if (handled) lastActiveAt = Date.now()
    } catch (e) {
      // 网络异常降噪：同类错误只提示一次，恢复后重新提示
      const msg = String(e.message || e)
      if (msg !== lastError) {
        log(`检查失败（将自动重试）：${msg}`)
        lastError = msg
      }
    }
    if (Date.now() - lastActiveAt >= IDLE_MS) {
      log(`已连续空闲 ${IDLE_MINUTES} 分钟，自动退出。需要发布时再次双击 scripts\\publish-watcher.cmd 即可。`)
      return
    }
    await sleep(INTERVAL)
  }
}

main()
