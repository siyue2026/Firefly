import { authCheck } from "../_auth.js"

export async function onRequestGet(context) {
  const { request, env, params } = context
  const authFail = await authCheck(request, env)
  if(authFail) return authFail
  const postId = Number(params.id)
  if(!postId) return new Response("文章ID非法", {status:400})
  
  const { results } = await env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(postId).all()
  if(results.length === 0) return new Response("文章不存在", {status:404})
  return Response.json(results[0])
}

export async function onRequestPut(context) {
  const { request, env, params } = context
  const authFail = await authCheck(request, env)
  if(authFail) return authFail
  const postId = Number(params.id)
  if(!postId) return new Response("文章ID非法", {status:400})

  const { slug, title, excerpt, content, status = "published" } = await request.json()
  await env.DB.prepare(`
    UPDATE posts SET slug=?, title=?, excerpt=?, content=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).bind(slug, title, excerpt, content, status, postId).run()

  return Response.json({success: true, message: "文章更新成功"})
}

export async function onRequestDelete(context) {
  const { request, env, params } = context
  const authFail = await authCheck(request, env)
  if(authFail) return authFail
  const postId = Number(params.id)
  if(!postId) return new Response("文章ID非法", {status:400})

  await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(postId).run()
  return Response.json({success: true, message: "文章删除成功"})
}
