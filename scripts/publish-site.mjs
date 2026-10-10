/**
 * 一键发布：同步线上数据库内容（文章/相册/留言板）→ 构建 → 部署到 Cloudflare Pages。
 *
 * 用法：ADMIN_TOKEN=xxx node scripts/publish-site.mjs
 * （也可以先 export ADMIN_TOKEN=xxx 再运行 npm run publish）
 */
import { execSync } from "node:child_process";

function run(cmd) {
	console.log(`\n==== ${cmd}\n`);
	execSync(cmd, { stdio: "inherit", env: process.env });
}

if (!process.env.ADMIN_TOKEN) {
	console.error("缺少 ADMIN_TOKEN 环境变量，无法从线上同步内容。");
	process.exit(1);
}

run("node scripts/sync-d1-posts.mjs --strict");
run("npm run build");
run("npx wrangler pages deploy dist --project-name firefly --branch master --commit-dirty=true");
console.log("\n发布完成：https://firefly-cv5.pages.dev （CDN 生效约需 1 分钟）");
