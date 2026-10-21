# dsh-weknora-hub

一个 DeepSeek Harness 插件：把多个 WeKnora 知识库收进一个入口——**每源可配是否可写**、**可读性验证结果缓存**、**请求前自动检索并注入**，同时提供检索/读取/写入工具。

## 安装

在 DSH profile（`~/.dsh/profiles/<profile>/package.json`）中加依赖与 bundle：

```json
{
  "dependencies": {
    "dsh-weknora-hub": "file:D:/ApqGit/dsh-weknora-hub"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-weknora-hub"]
    }
  }
}
```

装依赖：

```bash
pnpm install --dir ~/.dsh/profiles/<profile>
```

插件在 DSH 启动时加载，**改代码或换版本后需完全退出（含托盘）再启动**。

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖（插件自带行 id 为 `weknora-hub`）：

```yaml
- id: weknora-hub
  config:
    sources:
      - id: personal                 # 工具与注入里显示的源名，唯一
        type: native                 # native = WeKnora 原生部署（可写）；federation = 只读联邦
        baseUrl: https://weknora.example.com
        apiKey: sk-xxxx              # native 用 X-API-Key；federation 用 Bearer
        writable: true               # 仅 native 且显式为 true 才注册写入工具
        knowledgeBaseIds: []         # 空数组 = 全部知识库（自动发现新库）
        defaultKnowledgeBaseId: ''   # 可选：kb_create_note 未指定库时的默认值
      - id: corp
        type: federation
        baseUrl: http://192.168.0.16:18083
        apiKey: xxxxxxxx
        writable: false
    requestTimeoutMs: 20000          # 单次检索超时
    verifyTtlMs: 600000              # 可读性验证成功后的缓存时长（默认 10 分钟）
    verifyFailureTtlMs: 30000        # 验证失败后的缓存时长（默认 30 秒，到期自动重试）
    traceFile: ''                    # 可选：自动检索落盘日志路径；默认写在插件目录 weknora-hub-trace.log
    verifyTimeoutMs: 8000            # 验证探测超时
    auto:
      enabled: true                  # 关掉就只保留工具、不再自动注入
      match: 4                       # 每个源最多取几条
      maxChars: 6000                 # 注入块总字数上限
      minQuery: 4                    # 用户消息短于此长度不检索
      cacheTtl: 300                  # 相同问题的检索结果缓存（秒）
```

改配置后 DSH 会按需重读，无需重启；**改 `index.js` 必须重启**。

## 自动检索

开启后，每次模型请求前会：

1. 取最后一条用户消息作为查询；
2. 只对**已验证可读**的源检索（验证结果按 `verifyTtlMs` 缓存，不会每次验证）；
3. 把命中片段合并进 system 消息，并附加规则：无关片段忽略、相关须以片段为准、**回答末尾必须单列一行「来源：」写实际用到的文件名**（未用到写「来源：无」）、资料不足不得编造；
4. 任一源超时或报错只影响该源，其余照常；全部失败时请求原样放行。

**缓存规则**：验证成功缓存 `verifyTtlMs`（默认 10 分钟）；验证失败只缓存 `verifyFailureTtlMs`（默认 30 秒），到期自动重试，不会因为一次抖动长时间屏蔽该源。**改动任何源的 `baseUrl`/`apiKey`/`writable`/`knowledgeBaseIds` 会让缓存立即失效并重新验证**，不需要重启或等 TTL。

每次自动检索都会写一行日志（`traceFile`，默认插件目录下 `weknora-hub-trace.log`），可据此确认各源是否命中：

```
2026-10-21T10:14:49.798Z query=12c hits=[personal:4 corp:4] injected=1952c
2026-10-21T10:15:03.112Z query=8c hits=[personal:0 corp:4] skipped=[personal:HTTP 401] injected=812c
```

单个源不可读会在日志里提示：`dsh-weknora-hub: source <id> unreadable: ...`。

## 工具

| 工具 | 说明 | 主要参数 |
|---|---|---|
| `weknora_hub_search` | 跨所有可读源检索，返回片段与来源文件名 | `query`、`source`（可选，限定单源）、`match_count`（1–20，默认取 `auto.match`） |
| `weknora_hub_list_sources` | 列出配置的源：类型、是否可写、是否可读、知识库数量、错误信息 | `refresh`（布尔，强制重新探测，忽略缓存） |
| `weknora_hub_read_document` | 按 `knowledge_id` 读取正文（federation 支持分页；native 返回提示改用检索） | `source`、`knowledge_id`、`offset`、`max_chars` |
| `weknora_hub_create_note` | 在可写源里创建 Markdown 笔记（仅 `writable: true` 的源会注册此工具） | `source`、`knowledge_base_id`、`title`、`content`、`published` |

`weknora_hub_create_note` 默认 `published: true` 才会被 WeKnora 解析索引；`published: false` 创建的是草稿，**草稿永远不会进入检索**。

## 常见用法

**只读个人库 + 公司库，全部自动检索**

```yaml
- id: weknora-hub
  config:
    sources:
      - { id: personal, type: native, baseUrl: https://weknora.example.com, apiKey: sk-xxx }
      - { id: corp, type: federation, baseUrl: http://192.168.0.16:18083, apiKey: xxx }
```

**临时关掉自动检索，只保留工具**

```yaml
- id: weknora-hub
  config:
    auto: { enabled: false }
    sources: [ ... ]
```

**只让某个源参与检索**：不配那个源即可；或保留配置但把 `apiKey` 置空——验证会失败并被缓存，该源既不检索也不出现在工具结果里。

## 排查

| 现象 | 处理 |
|---|---|
| 工具列表里没有 `weknora_*` | 检查 profile 的 `bundles` 是否含 `dsh-weknora-hub`，以及 `pnpm install` 是否成功 |
| 有工具但检索结果为空 | 调 `weknora_hub_list_sources` 看 `readable` 与 `error`；密钥/地址错会显示在 `error` |
| 自动注入没生效 | 看日志是否有 `dsh-weknora-hub: injected ...`；`auto.enabled` 是否为 true、用户消息是否短于 `minQuery` |
| 改了配置没变化 | 配置热读；改 `index.js` 需要完全重启 DSH |
| 源暂时故障后一直不恢复 | 失败只缓存 `verifyFailureTtlMs`（默认 30 秒）；也可调 `weknora_hub_list_sources` 传 `refresh: true` 立即重验 |
