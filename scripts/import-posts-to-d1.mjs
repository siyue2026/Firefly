/**
 * 把 src/content/posts 下的 markdown 文章导入 D1（让后台控制台能管理已有文章）。
 *
 * 用法（任选其一或组合）：
 *   node scripts/import-posts-to-d1.mjs                          # 只打印统计（演练）
 *   node scripts/import-posts-to-d1.mjs --sql out.sql            # 生成 SQL 文件，配合 wrangler d1 execute --file 执行
 *   node scripts/import-posts-to-d1.mjs --json dump.json         # 导出 JSON 数据（供同步脚本离线预览）
 *   ADMIN_TOKEN=xxx node scripts/import-posts-to-d1.mjs --post   # 通过线上接口导入（已存在的 slug 会跳过）
 */
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

const POSTS_DIR = path.resolve("src/content/posts");
const SOURCE = (process.env.PUBLISH_SOURCE || "https://firefly-cv5.pages.dev").replace(/\/+$/, "");
const args = process.argv.slice(2);
const getOpt = (name) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : null;
};

function walk(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (/\.(md|mdx)$/i.test(entry.name)) out.push(full);
	}
	return out;
}

const posts = [];
for (const file of walk(POSTS_DIR).sort()) {
	const rel = path.relative(POSTS_DIR, file).split(path.sep).join("/");
	const slug = rel.replace(/\.(md|mdx)$/i, "");
	const raw = fs.readFileSync(file, "utf8");
	const { data, content } = matter(raw);

	// 其余 frontmatter 字段（tags/category/image/pinned/series 等）存入 meta，发布时还原
	const meta = { ...data };
	delete meta.title;
	delete meta.description;
	delete meta.draft;
	delete meta.published;

	const published =
		data.published instanceof Date
			? data.published.toISOString()
			: data.published
				? new Date(data.published).toISOString()
				: fs.statSync(file).mtime.toISOString();

	posts.push({
		slug,
		title: String(data.title || slug),
		excerpt: String(data.description || ""),
		content,
		status: data.draft === true ? "draft" : "published",
		meta: JSON.stringify(meta),
		file_path: rel,
		published_at: published,
	});
}

console.log(`共找到 ${posts.length} 篇文章：`);
for (const p of posts) {
	console.log(`  - [${p.status}] ${p.slug} | ${p.title} | ${p.published_at.slice(0, 10)}`);
}

const sqlFile = getOpt("--sql");
const jsonFile = getOpt("--json");
const doPost = args.includes("--post");

if (sqlFile) {
	const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
	const lines = posts.map(
		(p) =>
			`INSERT INTO posts (slug, title, excerpt, content, status, meta, file_path, created_at, updated_at, published_at) VALUES (${q(p.slug)}, ${q(p.title)}, ${q(p.excerpt)}, ${q(p.content)}, ${q(p.status)}, ${q(p.meta)}, ${q(p.file_path)}, ${q(p.published_at)}, ${q(p.published_at)}, ${q(p.published_at)}) ON CONFLICT(slug) DO NOTHING;`,
	);
	fs.writeFileSync(sqlFile, `${lines.join("\n")}\n`, "utf8");
	console.log(`SQL 已写入 ${sqlFile}`);
}

if (jsonFile) {
	fs.writeFileSync(jsonFile, JSON.stringify({ posts }, null, 2), "utf8");
	console.log(`JSON 已写入 ${jsonFile}`);
}

if (doPost) {
	const token = process.env.ADMIN_TOKEN;
	if (!token) {
		console.error("缺少 ADMIN_TOKEN 环境变量");
		process.exit(1);
	}
	const res = await fetch(`${SOURCE}/api/admin/import`, {
		method: "POST",
		headers: { Authorization: token, "Content-Type": "application/json" },
		body: JSON.stringify({ posts }),
	});
	console.log(`接口返回 ${res.status}:`, await res.text());
}
