// 控制台评论管理接口的共用纯函数（便于单元测试）。

export const COMMENT_STATUSES = ["approved", "waiting", "spam"]
export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 100
export const MAX_SEARCH_LEN = 100
export const MAX_URL_LEN = 500

// 转义 LIKE 通配符（配合 SQL 中的 ESCAPE '\' 使用），防止用户输入 % _ \ 干扰匹配
export function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (c) => `\\${c}`)
}

// 解析并校验列表查询参数。返回校验后的参数对象或 { error }
export function parseCommentQuery(searchParams) {
  const page = Math.max(1, Number.parseInt(searchParams.get("page") || "1", 10) || 1)
  const rawSize = Number.parseInt(searchParams.get("pageSize") || String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, rawSize))

  const status = searchParams.get("status") || "all"
  if (status !== "all" && !COMMENT_STATUSES.includes(status)) {
    return { error: `status 仅支持 all、${COMMENT_STATUSES.join("、")}` }
  }

  const search = (searchParams.get("search") || "").trim().slice(0, MAX_SEARCH_LEN)
  const url = (searchParams.get("url") || "").trim().slice(0, MAX_URL_LEN)
  return { page, pageSize, status, search, url }
}

// 根据筛选条件生成 WHERE 子句与绑定参数。
// status 传 "all" 或不传时不按状态过滤（统计接口用这个特性拿全量状态分布）
export function buildCommentFilters({ status, search, url } = {}) {
  const where = []
  const params = []
  if (status && status !== "all") {
    where.push("status = ?")
    params.push(status)
  }
  if (url) {
    where.push("url = ?")
    params.push(url)
  }
  if (search) {
    where.push("(nick LIKE ? ESCAPE '\\' OR mail LIKE ? ESCAPE '\\' OR comment LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\')")
    const like = `%${escapeLike(search)}%`
    params.push(like, like, like, like)
  }
  return { whereSql: where.length ? "WHERE " + where.join(" AND ") : "", params }
}

// 数据库行 → 管理端 JSON（与前台 formatComment 不同：返回原始 Markdown 内容，不做渲染）
export function toAdminComment(row, { replyTo = null } = {}) {
  return {
    objectId: row.object_id,
    url: row.url,
    nick: row.nick,
    mail: row.mail || "",
    link: row.link || "",
    comment: row.comment || "",
    ua: row.ua || "",
    ip: row.ip || "",
    pid: row.pid ?? null,
    rid: row.rid ?? null,
    like: Number(row.like_count) || 0,
    status: row.status,
    sticky: !!row.sticky,
    insertedAt: row.inserted_at,
    replyTo,
    replyCount: Number(row.reply_count) || 0,
  }
}
