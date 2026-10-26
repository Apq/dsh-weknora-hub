# Changelog

## 1.0.1

- 修 `auto.enabled` 在**热重读配置后不彻底**：每次 apply 都会在 `streamWithRegistration` 外面再套一层，旧层仍按它自己那份 `cfg` 继续注入，所以把开关设成 `false` 在重启前会继续注入、且多层叠加。现在每个 llm service 只保留一个 wrapper，配置重载只更新共享状态；被取代的实例 dispose 不再拆掉线上 seam。
- 修缓存驱逐崩溃：`queryCache.keys().slice()` 对迭代器调 `slice` 会抛错，缓存超过 128 条后**每次新查询都静默跳过自动检索**（日志里的 `error: queryCache.keys.slice is not a function`）。改为先展开再切片。
- 跳过原因写清楚：`auto.enabled=false` 与"没有 messages"不再共用同一条含混日志。

## 1.0.0

- 首个版本：多源知识库统一入口
- 每个源独立配置 `id / type / baseUrl / apiKey / writable / knowledgeBaseIds`
- 可读性验证结果缓存（`verifyTtlMs`），不在每次使用时重复验证
- 请求前自动检索所有可读源并注入 system 消息，强制回答标注「来源：」
- 工具：`weknora_hub_search`、`weknora_hub_list_sources`、`weknora_hub_read_document`、`weknora_hub_create_note`（仅可写源）
- 单源故障隔离，整体 fail-open
- 缓存策略：验证成功缓存 `verifyTtlMs`，失败仅缓存 `verifyFailureTtlMs`（默认 30 秒）自动重试
- 配置指纹：源配置变化立即失效缓存，无需重启
- `weknora_hub_list_sources` 支持 `refresh: true` 强制重验
- 自动检索落盘日志（`traceFile`），记录各源命中数与被跳过原因
- 每个源可配 `timeoutMs` 覆盖全局超时；全局 `requestTimeoutMs` 默认 45 秒（工具与检索），`verifyTimeoutMs` 默认 30 秒
