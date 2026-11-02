# 来源与独立维护

2026-09-21 从 R2-rebuild-v4-img 主线拆出。

来源提交：`3257d7c1d7bf5f032700bedba9fffb89f1eeccac`。

| 原位置 | 当前文件 |
| --- | --- |
| `mirror/worker.mjs` | `worker.mjs` |
| `mirror/wrangler.toml` | `wrangler.toml` |
| `DB/app-patches.mjs` | `lib/app-patches.mjs` |
| `scripts/package-mirror.mjs` | `scripts/package.mjs` |
| `tests/mirror-worker.test.mjs` | `tests/mirror-worker.test.mjs`、`tests/r2.mjs` |

共享补丁复制时的 SHA-256：

`e2251abf702975ac3cc1b4aba9713917c4f269bdcce476265b36e067fe4e2a00`

补丁版本：`r2-character-split-e2b-v4`（2026-11-02 起同时给上游 2.0.4+ 的 assets/js/cloud-backup.js 打补丁）。该文件按确定版本保存在本仓库，不通过相邻目录或运行时网络加载。以后升级上游页面补丁时，应同时核对主站与分发端的补丁版本，运行分发测试后再部署。

本次功能改动仅在公开版本页增加公告入口和展示。版本获取、预检、发布、回滚相关数据格式以及原管理权限保持原有流程。

上游原项目：https://github.com/STA1N156/RP-Hub
