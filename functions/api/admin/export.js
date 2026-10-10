import { authCheck } from "./_auth.js"

// 导出全部文章（含草稿、回收站）与站点设置（相册/留言板/音乐/动态/背景图片），供构建期同步脚本拉取
export async function onRequestGet(context) {
  const { request, env } = context
  const authFail = await authCheck(request, env)
  if (authFail) return authFail

  const { results } = await env.DB.prepare(
    "SELECT id, slug, title, excerpt, content, status, meta, file_path, published_at, created_at, updated_at FROM posts ORDER BY COALESCE(published_at, created_at) DESC"
  ).all()

  const settings = { gallery: null, guestbook: null, music: null, dynamic: null, background: null }
  try {
    const rows = await env.DB.prepare("SELECT key, value FROM settings").all()
    for (const row of rows.results) {
      if (!(row.key in settings)) continue
      try {
        settings[row.key] = JSON.parse(row.value)
      } catch {
        // 忽略损坏的数据
      }
    }
  } catch {
    // settings 表尚未创建时返回空设置
  }

  return Response.json({ posts: results, settings })
}
