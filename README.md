# ST Memory Lite Server 0.2

为小说叙事 RP 设计的轻量 SillyTavern 剧情记忆服务端插件。模型被视作作者、共同著作者或导演；摘要和记忆统一使用客观第三人称。

## 功能

- 手动分段总结；自动总结可选，默认关闭。
- 最近 2 层始终保留原文。
- 手动与自动总结成功后，均通过 UI 扩展同步执行 ST 原生 `/hide x-x`。
- 被隐藏剧情以连续摘要重新注入；当前可见楼层不会重复注入。
- 向量 + 中文关键词直接召回。
- 人物、关系变化、情绪效价/唤醒度、标签与 importance 参与筛选和排序。
- 直接命中后最多一跳的受限关系扩散，防止无关记忆连锁蔓延。
- 软冷却；强相关直接命中可覆盖冷却。
- 可选查询改写与 reranker；服务失败时安静降级，不阻断正文生成。
- 角色头像键 + 聊天文件双重隔离，不跨窗口串记忆。
- 独立响应式控制台；聊天页只保留一个入口按钮。

## 安装

把本目录放到 SillyTavern 的 `plugins/ST-Memory-Lite-Server`，确认 `config.yaml` 中启用了 `enableServerPlugins: true`，然后重启 SillyTavern。再通过扩展安装器安装配套 UI。

需要 Node.js 18 或更高版本，无 npm 运行时依赖。

## API

控制台需要兼容以下路径的服务：

- 总结/可选查询改写：`POST {base_url}/chat/completions`
- 向量：`POST {base_url}/embeddings`
- 可选精排：`POST {base_url}/rerank`

总结请求只发送一个 system 消息和一个 user 消息，并只设置 `temperature`，不同时强制发送 `top_p`。

## 数据与安全

默认数据文件：`SillyTavern/data/default-user/st-memory-lite/memory.json`。可用 `ST_MEMORY_LITE_DATA_DIR` 改路径。文件权限为 `0600`，已保存的 API Key 不会返回给控制台。

0.1 数据会就地迁移。旧版没有连续摘要层，因此不会因迁移而自动隐藏旧楼层；只有 0.2 新生成且完整落盘的摘要覆盖范围才会进入隐藏计划。

## 测试

```bash
npm test
```
