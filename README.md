# RP-Hub Update Mirror

RP-Hub 独立更新分发端。它从上游获取版本，检查兼容性后保存到 R2，向站点提供版本清单、快照文件和公告。

- [公开版本列表](https://update.rph.mornye.uk/)
- [管理后台](https://update.rph.mornye.uk/admin)
- 上游：[STA1N156/RP-Hub](https://github.com/STA1N156/RP-Hub)

## 普通访客查看公告

公开首页每个版本旁都有“查看公告”。点击后直接读取该版本公告，显示在版本列表上方；无需管理员口令，也不依赖浏览器 JavaScript。链接可复制分享。

公告原文按纯文本显示，保留换行。暂无公告会显示说明；读取失败会显示重试入口，并保留版本列表。后台的同步、删除版本、修改配置仍要求管理员口令。

现有 `/announcements.json` 和 `/announcements.json?tag=版本` 继续可用。公告索引由既有定时同步或后台同步生成，查看公告不会触发上游同步或写入 R2。

## 本地开发

Node.js 22.22.2、Git。ZIP 打包使用 Windows PowerShell。

```powershell
npm ci
npm test
npx playwright install chromium
npm run test:browser
npm run test:package
npm run build
```

测试准备脚本把上游提交下载到 `.cache/upstream/`：“通过”锚点取线上分发端已收录的最新两个正式版本，自动跟随上游，不用手工更新（分发端连不上时沿用上次的锚点，可用 `MIRROR_BASE` 改地址）；“拒绝”锚点是固定的历史提交。不依赖 RP-Hub 主站目录。测试使用模拟 R2 和数据，不需要生产密钥。浏览器测试覆盖桌面、手机视口及禁用 JavaScript 的访问。

`worker.mjs` 是分发端入口，`lib/app-patches.mjs` 是上游页面兼容性检查依赖。来源和维护方式见 [ORIGIN.md](ORIGIN.md)。

## 部署

本项目从已有服务独立出来，保留现有 Worker 名 `rp-hub-update-mirror`、R2 binding `MIRROR_BUCKET`、bucket 名及定时任务。

先运行 `npm run build`，生成 `dist/` 和 `release/` 中的 ZIP。ZIP 内为独立的 `worker.js`、`wrangler.toml`、部署说明；无需主站文件。

维护现有部署时，在源码根目录执行 `npx wrangler deploy`，或进入解压后的部署包执行同一命令。部署前确认项目配置对应目标 Cloudflare 账号，继续使用原 R2 bucket 和 secrets。

首次部署需配置：
- 私有 R2 bucket，binding 为 `MIRROR_BUCKET`。
- Secrets：`GITHUB_TOKEN`、`ADMIN_TOKEN`；使用通知时另设 `WEBHOOK_URL`、`WEBHOOK_TOKEN`。
- 自定义域名 `update.rph.mornye.uk`，由 Cloudflare 控制台绑定。
- 使用后台同步或等待定时同步，生成版本与公告清单。

密钥通过 `npx wrangler secret put 名称` 交互设置。GitHub Actions 只做测试和打包，不自动部署。

## 许可

保留上游 [CC BY-NC 4.0 许可证](LICENSE) 和原有署名。
