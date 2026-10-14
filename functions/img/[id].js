// 图片访问通道：GET /img/<id>.<ext>，从 D1 images 表读取并返回，带一年长缓存。
// 控制台编辑器上传的图片会生成这个地址写进文章正文，任何设备、任何时间都能访问。
export async function onRequestGet(context) {
  const { env, params } = context
  const id = String(params.id || "")
  // 只接受「32位随机hex.扩展名」格式，挡住一切其他路径探测
  if (!/^[a-f0-9]{32}\.[a-z]{3,4}$/.test(id)) {
    return new Response("Not Found", { status: 404 })
  }
  let row = null
  try {
    row = await env.DB.prepare("SELECT mime, data FROM images WHERE id = ?").bind(id).first()
  } catch {
    row = null
  }
  if (!row || !row.data) {
    return new Response("Not Found", { status: 404 })
  }
  let body = row.data
  if (typeof body === "string") {
    // 兜底1：驱动返回 base64 字符串
    try {
      body = Uint8Array.from(atob(body), c => c.charCodeAt(0))
    } catch {
      return new Response("Not Found", { status: 404 })
    }
  } else if (body instanceof ArrayBuffer) {
    body = new Uint8Array(body)
  } else if (Array.isArray(body)) {
    // 实测：D1 读出的 BLOB 在本运行时是普通数字数组，必须转成 Uint8Array 再进 Response，
    // 否则响应体为空（new Response(Array) 不会报错但不会输出字节）。
    body = Uint8Array.from(body)
  } else if (body && typeof body === "object" && Array.isArray(body.data)) {
    // 兜底2：Buffer-like JSON 形状
    body = Uint8Array.from(body.data)
  }
  if (!(body instanceof Uint8Array) && typeof body !== "string") {
    return new Response("Not Found", { status: 404 })
  }
  return new Response(body, {
    headers: {
      "Content-Type": row.mime || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
