export function isValidSlug(slug) {
  if (typeof slug !== "string" || !slug || slug.length > 200) return false
  if (slug.includes("..") || slug.startsWith("/") || slug.includes("\\")) return false
  return /^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5./-]*$/.test(slug)
}

// ---------- 文章 meta（控制台管理：访问密码 / 密码提示 / 封面图片） ----------
// 其余 meta 键（tags、category 等）不在此接口管理，写入时原样保留
export const POST_META_MANAGED_KEYS = ["password", "passwordHint", "image"]

const META_LIMITS = { password: 200, passwordHint: 500, image: 2000 }
const META_LABELS = { password: "访问密码", passwordHint: "密码提示", image: "封面图片" }

// 校验控制台提交的 meta：仅接收受管键，值统一为字符串（空字符串表示清除该键）
// 返回 { updates }（未提交 meta 时为 { updates: null }）或 { error }
export function sanitizePostMetaUpdates(input) {
  if (input === undefined || input === null) return { updates: null }
  if (typeof input !== "object" || Array.isArray(input)) return { error: "meta 必须是对象" }
  const updates = {}
  for (const key of POST_META_MANAGED_KEYS) {
    if (!(key in input)) continue
    const raw = input[key]
    const value = typeof raw === "string" ? raw.trim() : ""
    if (value.length > META_LIMITS[key]) {
      return { error: `${META_LABELS[key]}过长（最多 ${META_LIMITS[key]} 字符）` }
    }
    updates[key] = value
  }
  return { updates }
}

// 把受管字段合并进既有 meta（空字符串删除对应键），返回新的 meta JSON 字符串
export function mergePostMeta(existingMetaJson, updates) {
  let base = {}
  try {
    const parsed = JSON.parse(existingMetaJson || "{}")
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed
  } catch {
    // 损坏的 meta 按空对象处理
  }
  if (updates) {
    for (const [key, value] of Object.entries(updates)) {
      if (value) base[key] = value
      else delete base[key]
    }
  }
  return JSON.stringify(base)
}
