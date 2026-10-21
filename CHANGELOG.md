# Changelog

## 1.0.0

- 首个版本：多源知识库统一入口
- 每个源独立配置 `id / type / baseUrl / apiKey / writable / knowledgeBaseIds`
- 可读性验证结果缓存（`verifyTtlMs`），不在每次使用时重复验证
- 请求前自动检索所有可读源并注入 system 消息，强制回答标注「来源：」
- 工具：`weknora_hub_search`、`weknora_hub_list_sources`、`weknora_hub_read_document`、`weknora_hub_create_note`（仅可写源）
- 单源故障隔离，整体 fail-open
