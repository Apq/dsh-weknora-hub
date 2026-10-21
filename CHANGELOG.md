# Changelog

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
- 每个源可配 `timeoutMs` 覆盖全局超时；全局默认由 20 秒放宽到 30 秒（含验证探测）
