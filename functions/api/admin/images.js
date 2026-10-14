import { authCheck } from "./_auth.js"

// 编辑器图片上传：POST multipart/form-data，字段名 file。
// 图片存入 D1 images 表（BLOB），返回 /img/<id> 网址；
// 由 functions/img/[id].js 对外提供访问，上传后立即可用、无需重新构建，任何设备都能显示。
// 前端（控制台编辑器）会先把大图压缩到 1600px / 700KB 以内再上传。

const MAX_FILE = 1.2 * 1024 * 1024 // 单张图片上限 1.2MB

const MIME_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  })
}

export async function onRequestPost(context) {
  const { request, env } = context
  const authFail = await authCheck(request, env)
  if (authFail) return authFail

  let form
  try {
    form = await request.formData()
  } catch {
    return json({ success: false, message: "请求格式不正确，应为 multipart/form-data" }, 400)
  }
  const file = form.get("file")
  if (!file || typeof file === "string") {
    return json({ success: false, message: "未收到图片文件" }, 400)
  }
  const mime = String(file.type || "").toLowerCase()
  const ext = MIME_EXT[mime]
  if (!ext) {
    return json({ success: false, message: "仅支持 PNG / JPG / WebP / GIF 图片" }, 400)
  }
  const buf = await file.arrayBuffer()
  if (!buf.byteLength) {
    return json({ success: false, message: "文件内容为空" }, 400)
  }
  if (buf.byteLength > MAX_FILE) {
    return json({ success: false, message: "图片过大（超过 1.2MB），请压缩后再试" }, 413)
  }

  const id = crypto.randomUUID().replace(/-/g, "") + "." + ext
  await env.DB.prepare(
    "INSERT INTO images (id, filename, mime, size, data, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)"
  ).bind(id, String(file.name || "").slice(0, 120), mime, buf.byteLength, buf).run()

  return json({ success: true, url: "/img/" + id, size: buf.byteLength })
}
