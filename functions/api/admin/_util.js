export function isValidSlug(slug) {
  if (typeof slug !== "string" || !slug || slug.length > 200) return false
  if (slug.includes("..") || slug.startsWith("/") || slug.includes("\\")) return false
  return /^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5./-]*$/.test(slug)
}

// ---------- 文章 meta（控制台管理：访问密码 / 密码提示 / 封面图片 / 标签 / 置顶 / 合集） ----------
// 其余 meta 键（category 等）不在此接口管理，写入时原样保留
export const POST_META_MANAGED_KEYS = ["password", "passwordHint", "image", "tags", "pinned", "series", "seriesOrder"]

const META_LIMITS = { password: 200, passwordHint: 500, image: 2000, series: 100 }
const META_LABELS = { password: "访问密码", passwordHint: "密码提示", image: "封面图片", series: "合集名称", tags: "标签", pinned: "置顶", seriesOrder: "合集序号" }
const MAX_TAGS = 20
const MAX_TAG_LENGTH = 50
const MAX_SERIES_ORDER = 999

// 校验控制台提交的 meta：仅接收受管键。
// 字符串类键的空字符串、tags 的空数组、pinned=false、seriesOrder 的空值均表示清除对应键。
// 返回 { updates }（未提交 meta 时为 { updates: null }）或 { error }
export function sanitizePostMetaUpdates(input) {
  if (input === undefined || input === null) return { updates: null }
  if (typeof input !== "object" || Array.isArray(input)) return { error: "meta 必须是对象" }
  const updates = {}
  for (const key of POST_META_MANAGED_KEYS) {
    if (!(key in input)) continue
    const raw = input[key]

    if (key === "tags") {
      let items = []
      if (raw === "" || raw === null || raw === undefined) items = []
      else if (typeof raw === "string") items = raw.split(/[,，]/)
      else if (Array.isArray(raw)) items = raw
      else return { error: "标签格式不正确（应为字符串数组）" }
      const tags = [...new Set(items.map((t) => String(t).trim()).filter(Boolean))]
      if (tags.length > MAX_TAGS) return { error: `${META_LABELS.tags}最多 ${MAX_TAGS} 个` }
      if (tags.some((t) => t.length > MAX_TAG_LENGTH)) {
        return { error: `单个${META_LABELS.tags}最长 ${MAX_TAG_LENGTH} 字符` }
      }
      updates.tags = tags
      continue
    }

    if (key === "pinned") {
      if (raw === true || raw === "true" || raw === 1 || raw === "1") updates.pinned = true
      else if (raw === false || raw === "false" || raw === 0 || raw === "0" || raw === "" || raw === null || raw === undefined) updates.pinned = false
      else return { error: "置顶字段格式不正确（应为布尔值）" }
      continue
    }

    if (key === "seriesOrder") {
      if (raw === "" || raw === null || raw === undefined) {
        updates.seriesOrder = ""
        continue
      }
      const n = Number(raw)
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > MAX_SERIES_ORDER) {
        return { error: `${META_LABELS.seriesOrder}应为 0~${MAX_SERIES_ORDER} 的整数` }
      }
      updates.seriesOrder = n
      continue
    }

    const value = typeof raw === "string" ? raw.trim() : ""
    if (value.length > META_LIMITS[key]) {
      return { error: `${META_LABELS[key]}过长（最多 ${META_LIMITS[key]} 字符）` }
    }
    updates[key] = value
  }
  return { updates }
}

// 把受管字段合并进既有 meta；空值（空字符串 / 空数组 / false / null）删除对应键
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
      const isEmpty =
        value === "" ||
        value === null ||
        value === undefined ||
        value === false ||
        (Array.isArray(value) && value.length === 0)
      if (isEmpty) delete base[key]
      else base[key] = value
    }
  }
  return JSON.stringify(base)
}
