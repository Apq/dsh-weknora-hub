/**
 * @local/dsh-kb — one plugin for every knowledge-base concern:
 *   - multiple sources, each declared in config with its own type/keys/writable flag
 *   - readability is verified once and cached (TTL), never re-probed per request
 *   - automatic retrieval: every model request is enriched from all readable sources
 *   - tools: kb_search / kb_list_sources / kb_read_document / kb_create_note (writable only)
 *
 * Source types:
 *   native      — a WeKnora deployment (/api/v1), may be writable
 *   federation  — a read-only federated proxy (/search, /read_document)
 *
 * Untrusted content: retrieved passages and uploaded text are data, never instructions.
 */
export const name = 'weknora-hub';
export const inject = ['tools', 'llm'];

const DEFAULTS = {
  requestTimeoutMs: 20000,
  verifyTtlMs: 600000,
  verifyTimeoutMs: 8000,
  auto: { enabled: true, match: 4, maxChars: 6000, minQuery: 4, cacheTtl: 300 },
};

const MARK = '【知识库自动检索结果】';

function text(value) {
  return [{ type: 'text', text: String(value) }];
}

function trimUrl(raw) {
  return String(raw ?? '').trim().replace(/\/+$/, '');
}

function nativeRoot(raw) {
  const t = trimUrl(raw);
  return /\/api\/v\d+$/.test(t) ? t : `${t}/api/v1`;
}

async function fetchJson(url, opts = {}, timeoutMs = DEFAULTS.requestTimeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 160)}`);
    return body ? JSON.parse(body) : {};
  } finally {
    clearTimeout(timer);
  }
}

function resolveConfig(config = {}) {
  const violations = [];
  const sources = [];
  const raw = config.sources;
  if (!Array.isArray(raw) || raw.length === 0) violations.push('sources must be a non-empty array');
  const seen = new Set();
  for (const [i, entry] of (raw ?? []).entries()) {
    const tag = `sources[${i}]`;
    if (!entry || typeof entry !== 'object') { violations.push(`${tag} must be an object`); continue; }
    const id = String(entry.id ?? entry.name ?? '').trim();
    if (!id) { violations.push(`${tag}.id is required`); continue; }
    if (seen.has(id)) { violations.push(`${tag}.id "${id}" is duplicated`); continue; }
    seen.add(id);
    const type = String(entry.type ?? 'native').trim();
    if (!['native', 'federation'].includes(type)) { violations.push(`${tag}.type must be native or federation`); continue; }
    const baseUrl = trimUrl(entry.baseUrl);
    if (!baseUrl) { violations.push(`${tag}.baseUrl is required`); continue; }
    if (!/^https?:\/\//.test(baseUrl)) { violations.push(`${tag}.baseUrl must be http(s)`); continue; }
    sources.push({
      id,
      type,
      baseUrl,
      apiKey: String(entry.apiKey ?? ''),
      writable: type === 'native' && entry.writable === true,
      knowledgeBaseIds: Array.isArray(entry.knowledgeBaseIds) ? entry.knowledgeBaseIds : [],
      defaultKnowledgeBaseId: entry.defaultKnowledgeBaseId ? String(entry.defaultKnowledgeBaseId) : '',
    });
  }
  if (violations.length) throw new Error(`dsh-weknora-hub configuration is invalid:\n  - ${violations.join('\n  - ')}`);
  return {
    sources,
    requestTimeoutMs: Number(config.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs),
    verifyTtlMs: Number(config.verifyTtlMs ?? DEFAULTS.verifyTtlMs),
    verifyTimeoutMs: Number(config.verifyTimeoutMs ?? DEFAULTS.verifyTimeoutMs),
    auto: { ...DEFAULTS.auto, ...(config.auto ?? {}) },
  };
}

// ---------------------------------------------------------------- verification

const verifyCache = new Map(); // id -> { ok, at, kbCount, error }

async function probeSource(source, cfg) {
  const headers = source.type === 'federation'
    ? { authorization: `Bearer ${source.apiKey}` }
    : { 'X-API-Key': source.apiKey };
  const url = source.type === 'federation'
    ? `${source.baseUrl}/api/v1/knowledge-bases`
    : `${nativeRoot(source.baseUrl)}/knowledge-bases`;
  const body = await fetchJson(url, { headers }, cfg.verifyTimeoutMs);
  const list = body.data ?? body.items ?? body.knowledge_bases ?? [];
  return Array.isArray(list) ? list.length : 0;
}

async function ensureVerified(source, cfg, { force = false } = {}) {
  const cached = verifyCache.get(source.id);
  if (!force && cached && Date.now() - cached.at < cfg.verifyTtlMs) return cached;
  let entry;
  try {
    const kbCount = await probeSource(source, cfg);
    entry = { ok: true, at: Date.now(), kbCount, error: '' };
  } catch (err) {
    entry = { ok: false, at: Date.now(), kbCount: 0, error: String(err?.message ?? err) };
  }
  verifyCache.set(source.id, entry);
  return entry;
}

// ------------------------------------------------------------------ retrieval

function hitFile(h) {
  return h.knowledge_filename ?? h.filename ?? h.knowledge_title ?? h.title ?? '';
}
function hitText(h) {
  return String(h.matched_content ?? h.content ?? h.snippet ?? '');
}

async function searchNative(source, query, match, cfg) {
  const root = nativeRoot(source.baseUrl);
  const headers = { 'Content-Type': 'application/json', 'X-API-Key': source.apiKey };
  let ids = source.knowledgeBaseIds;
  if (!ids.length) {
    const listed = await fetchJson(`${root}/knowledge-bases`, { headers }, cfg.requestTimeoutMs);
    ids = (listed.data ?? listed.items ?? []).map((k) => (k.knowledge_base ?? k).id).filter(Boolean).slice(0, 12);
  }
  const results = await Promise.allSettled(ids.map((id) => fetchJson(
    `${root}/knowledge-bases/${id}/hybrid-search`,
    { method: 'POST', headers, body: JSON.stringify({ query_text: query, match_count: match }) },
    cfg.requestTimeoutMs,
  )));
  const hits = [];
  for (const r of results) if (r.status === 'fulfilled') hits.push(...(r.value?.data ?? []));
  return hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, match);
}

async function searchFederation(source, query, match, cfg) {
  const body = await fetchJson(
    `${source.baseUrl}/search`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${source.apiKey}` },
      body: JSON.stringify({ query, match_count: match }),
    },
    Math.max(cfg.requestTimeoutMs, 25000),
  );
  return (body.data ?? []).slice(0, match);
}

async function searchSource(source, query, match, cfg) {
  return source.type === 'federation'
    ? searchFederation(source, query, match, cfg)
    : searchNative(source, query, match, cfg);
}

function formatBlock(groups) {
  const lines = [
    MARK + ' 回答前系统自动检索到的资料片段。硬性规则：',
    '1) 与问题无关的片段忽略；',
    '2) 相关时以此为准，不得与片段冲突；',
    '3) 回答末尾必须单列一行「来源：」并写出实际用到的文件名（多个用、分隔）；一个都没用到就写「来源：无」；',
    '4) 资料不足要明说，禁止编造。',
  ];
  let used = 0;
  for (const { source, hits } of groups) {
    for (const h of hits) {
      const body = hitText(h);
      if (!body) continue;
      const block = `[${source}] 来源：${hitFile(h) || '未知文档'}\n${body}`;
      if (used + block.length > 6000) break;
      lines.push(block);
      used += block.length;
    }
  }
  return used ? lines.join('\n\n') : '';
}

// ------------------------------------------------------------------ auto hook

const queryCache = new Map();

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter((p) => !p?.type || p.type === 'text').map((p) => p.text ?? '').join('\n');
  }
  return '';
}

function injectBlock(messages, block) {
  if (messages[0]?.role === 'system') {
    const first = { ...messages[0] };
    first.content = Array.isArray(first.content)
      ? [{ type: 'text', text: block }, ...first.content]
      : `${block}\n\n${first.content ?? ''}`;
    return [first, ...messages.slice(1)];
  }
  return [{ role: 'system', content: block }, ...messages];
}

async function enrich(cfg, options, ctx) {
  if (!cfg.auto.enabled || !Array.isArray(options?.messages)) return options;
  if (options.messages.some((m) => typeof m?.content === 'string' && m.content.includes(MARK))) return options;
  const query = lastUserText(options.messages).trim();
  if (query.length < cfg.auto.minQuery) return options;

  const cached = queryCache.get(query);
  if (cached && Date.now() - cached.at < cfg.auto.cacheTtl * 1000) {
    return cached.block ? { ...options, messages: injectBlock(options.messages, cached.block) } : options;
  }

  const readable = [];
  for (const source of cfg.sources) {
    const state = await ensureVerified(source, cfg);
    if (state.ok) readable.push(source);
    else ctx.logger?.warn?.(`dsh-weknora-hub: source ${source.id} unreadable: ${state.error}`);
  }
  const groups = [];
  const settled = await Promise.allSettled(readable.map((s) => searchSource(s, query, cfg.auto.match, cfg)));
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.length) groups.push({ source: readable[i].id, hits: r.value });
    else if (r.status === 'rejected') ctx.logger?.warn?.(`dsh-weknora-hub: search ${readable[i].id} failed: ${r.reason?.message ?? r.reason}`);
  });
  const block = formatBlock(groups);
  queryCache.set(query, { at: Date.now(), block });
  if (queryCache.size > 128) for (const k of queryCache.keys().slice(0, 64)) queryCache.delete(k);
  if (!block) return options;
  ctx.logger?.info?.(`dsh-weknora-hub: injected ${block.length}c from ${groups.map((g) => `${g.source}:${g.hits.length}`).join(',')}`);
  return { ...options, messages: injectBlock(options.messages, block) };
}

// ---------------------------------------------------------------------- tools

function createTools(cfg) {
  const definitions = [];
  const mk = (suffix, description, parameters, output, execute, options = {}) => ({
    name: `weknora_hub_${suffix}`,
    description,
    parameters,
    timeoutMs: options.timeoutMs ?? cfg.requestTimeoutMs,
    isConcurrencySafe: () => options.isConcurrencySafe === true,
    output: { ...output, render: (_args, value) => text(JSON.stringify(value ?? {}, null, 2)) },
    execute,
  });
  const sourceIds = cfg.sources.map((s) => s.id);

  definitions.push(mk(
    'list_sources',
    'List configured knowledge-base sources with their verified readability, type, knowledge-base count and whether they accept writes.',
    { type: 'object', properties: {}, additionalProperties: false },
    {
      schema: {
        type: 'object',
        properties: {
          sources: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' }, type: { type: 'string' }, writable: { type: 'boolean' },
                readable: { type: 'boolean' }, knowledge_bases: { type: 'integer' }, error: { type: 'string' },
              },
              required: ['id', 'type', 'writable', 'readable', 'knowledge_bases', 'error'],
              additionalProperties: false,
            },
          },
        },
        required: ['sources'],
        additionalProperties: false,
      },
    },
    async () => {
      const out = [];
      for (const s of cfg.sources) {
        const v = await ensureVerified(s, cfg);
        out.push({ id: s.id, type: s.type, writable: s.writable, readable: v.ok, knowledge_bases: v.kbCount, error: v.error });
      }
      return { sources: out };
    },
    { isConcurrencySafe: true },
  ));

  definitions.push(mk(
    'search',
    `Search every readable configured knowledge base and return matching passages with their source file names. Sources: ${sourceIds.join(', ')}.`,
    {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language question; a full question retrieves better than keywords.' },
        source: { type: 'string', description: `Optional single source id (one of: ${sourceIds.join(', ')}). Omit to search all readable sources.` },
        match_count: { type: 'integer', minimum: 1, maximum: 20, description: 'Hits per source, default 4.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    {
      schema: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                source: { type: 'string' }, file: { type: 'string' }, score: { type: 'number' },
                knowledge_id: { type: 'string' }, content: { type: 'string' },
              },
              required: ['source', 'file', 'knowledge_id', 'content'],
              additionalProperties: false,
            },
          },
        },
        required: ['results'],
        additionalProperties: false,
      },
    },
    async (args, exec) => {
      const match = Math.min(20, Math.max(1, Number(args.match_count ?? cfg.auto.match)));
      const targets = args.source
        ? cfg.sources.filter((s) => s.id === args.source)
        : cfg.sources;
      if (args.source && !targets.length) throw new Error(`unknown source "${args.source}"`);
      const out = [];
      for (const s of targets) {
        const v = await ensureVerified(s, cfg);
        if (!v.ok) continue;
        try {
          const hits = await searchSource(s, String(args.query ?? ''), match, cfg);
          for (const h of hits) {
            out.push({
              source: s.id,
              file: hitFile(h),
              score: Number(h.score ?? 0),
              knowledge_id: String(h.knowledge_id ?? ''),
              content: hitText(h).slice(0, 2000),
            });
          }
        } catch (err) {
          exec?.signal?.throwIfAborted?.();
          // one bad source must not fail the whole search
        }
      }
      return { results: out };
    },
    { isConcurrencySafe: true },
  ));

  definitions.push(mk(
    'read_document',
    'Read a knowledge document body by knowledge_id (as returned by kb_search). Federation sources support paging; native sources return their stored passages.',
    {
      type: 'object',
      properties: {
        source: { type: 'string', description: `Source id (one of: ${sourceIds.join(', ')})` },
        knowledge_id: { type: 'string' },
        tenant_id: { type: 'integer', description: 'Federation only; from the search hit.' },
        offset: { type: 'integer', minimum: 0 },
        max_chars: { type: 'integer', minimum: 1000, maximum: 40000 },
      },
      required: ['source', 'knowledge_id'],
      additionalProperties: false,
    },
    {
      schema: {
        type: 'object',
        properties: {
          source: { type: 'string' }, content: { type: 'string' }, truncated: { type: 'boolean' }, next_offset: { type: 'integer' },
        },
        required: ['source', 'content', 'truncated'],
        additionalProperties: false,
      },
    },
    async (args) => {
      const source = cfg.sources.find((s) => s.id === args.source);
      if (!source) throw new Error(`unknown source "${args.source}"`);
      if (source.type !== 'federation') {
        return { source: source.id, content: '该源为 native 类型，暂不支持按 knowledge_id 读取正文；请用 kb_search 提高 match_count 获取更多片段。', truncated: false };
      }
      const body = await fetchJson(`${source.baseUrl}/read_document`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${source.apiKey}` },
        body: JSON.stringify({
          knowledge_id: args.knowledge_id,
          ...(args.tenant_id === undefined ? {} : { tenant_id: args.tenant_id }),
          ...(args.offset === undefined ? {} : { offset: args.offset }),
          ...(args.max_chars === undefined ? {} : { max_chars: args.max_chars }),
        }),
      }, Math.max(cfg.requestTimeoutMs, 30000));
      return { source: source.id, content: String(body.content ?? ''), truncated: Boolean(body.truncated), ...(body.next_offset === undefined ? {} : { next_offset: body.next_offset }) };
    },
  ));

  const writable = cfg.sources.filter((s) => s.writable);
  if (writable.length) {
    definitions.push(mk(
      'create_note',
      `Create a Markdown note in a writable knowledge base. Writable sources: ${writable.map((s) => s.id).join(', ')}.`,
      {
        type: 'object',
        properties: {
          source: { type: 'string', description: `Writable source id (one of: ${writable.map((s) => s.id).join(', ')})` },
          knowledge_base_id: { type: 'string', description: 'Target knowledge base id (see kb_list_sources + kb_search results).' },
          title: { type: 'string', description: 'Note title; becomes the document name.' },
          content: { type: 'string', description: 'Markdown body.' },
          published: { type: 'boolean', description: 'Default true: publish so WeKnora parses and indexes it. A draft is never indexed.' },
        },
        required: ['source', 'knowledge_base_id', 'title', 'content'],
        additionalProperties: false,
      },
      {
        schema: {
          type: 'object',
          properties: { source: { type: 'string' }, knowledge_id: { type: 'string' }, status: { type: 'string' } },
          required: ['source', 'knowledge_id', 'status'],
          additionalProperties: false,
        },
      },
      async (args) => {
        const source = writable.find((s) => s.id === args.source);
        if (!source) throw new Error(`source "${args.source}" is not writable`);
        const root = nativeRoot(source.baseUrl);
        const body = await fetchJson(`${root}/knowledge-bases/${args.knowledge_base_id}/knowledge/manual`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': source.apiKey },
          body: JSON.stringify({
            title: args.title,
            content: args.content,
            status: args.published === false ? 'draft' : 'publish',
          }),
        }, Math.max(cfg.requestTimeoutMs, 60000));
        const data = body.data ?? body;
        return { source: source.id, knowledge_id: String(data.id ?? data.knowledge_id ?? ''), status: String(data.parse_status ?? data.status ?? 'unknown') };
      },
    ));
  }

  return definitions;
}

// ---------------------------------------------------------------------- apply

export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  for (const definition of createTools(cfg)) ctx.tools.register(definition);

  const svc = ctx.llm;
  const original = svc.streamWithRegistration;
  const hadOwn = Object.hasOwn(svc, 'streamWithRegistration');
  // streamWithRegistration is synchronous and its result is consumed as an async
  // iterable, so hand back a generator immediately and await enrichment inside.
  svc.streamWithRegistration = function wrapped(options, prepared) {
    const self = this;
    return (async function* () {
      // A prepared call was validated against its resolved config; rewriting
      // messages there would trip INVALID_PREPARED_CALL.
      const effective = prepared === undefined ? await enrich(cfg, options, ctx) : options;
      yield* original.call(self, effective, prepared);
    })();
  };
  ctx.on('dispose', () => { if (hadOwn) svc.streamWithRegistration = original; else delete svc.streamWithRegistration; });

  ctx.logger?.info(`dsh-weknora-hub: sources=${cfg.sources.map((s) => `${s.id}(${s.type}${s.writable ? ',w' : ''})`).join(',')} auto=${cfg.auto.enabled}`);
}
