/**
 * 纯数据层：评论记录的结构、规范化、以及导出格式。
 * 不依赖 chrome.* 或 DOM，background / popup / manager 三方共用。
 */

export const STORAGE_KEY = 'bshc:items:v1';
export const SCHEMA_VERSION = 1;
export const MAX_TEXT = 4000;

/** 唯一键：同一条评论在任意页面都对应同一个 id。 */
export function makeId({ type, oid, rpid }) {
  return `${type ?? 1}:${oid ?? ''}:${rpid ?? ''}`;
}

export function makeJumpUrl(source, rpid, root) {
  const base = (source && source.url) || '';
  if (!base) return '';
  // B 站评论组件的官方深链格式：#reply<rpid>（组件内部 regex /^#reply(\d+)$/）。
  const target = rpid || root || '';
  return target ? `${stripHash(base)}#reply${target}` : base;
}

export function stripHash(url) {
  return String(url || '').split('#')[0];
}

function str(v, max = MAX_TEXT) {
  const s = String(v ?? '');
  return s.length > max ? s.slice(0, max) : s;
}

/** 把来自桥接层 / 导入文件的原始数据整理成稳定结构，任何字段缺失都不会抛错。 */
export function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rpid = str(raw.rpid, 32);
  const oid = str(raw.oid, 32);
  const type = Number(raw.type) || 1;
  if (!rpid) return null;

  const source = {
    url: str(raw.source?.url, 512),
    title: str(raw.source?.title, 300),
    bvid: str(raw.source?.bvid, 24),
    kind: str(raw.source?.kind, 16) || 'page',
  };
  const author = {
    mid: str(raw.author?.mid, 32),
    name: str(raw.author?.name, 80),
    avatar: str(raw.author?.avatar, 512),
  };
  const root = str(raw.root, 32) || '0';

  return {
    id: makeId({ type, oid, rpid }),
    rpid,
    oid,
    type,
    root,
    parent: str(raw.parent, 32) || '0',
    isReply: root !== '0',
    text: str(raw.text),
    author,
    ctime: Number(raw.ctime) || 0,
    like: Number(raw.like) || 0,
    source,
    jumpUrl: str(raw.jumpUrl, 600) || makeJumpUrl(source, rpid, root),
    tags: Array.isArray(raw.tags) ? raw.tags.map((t) => str(t, 24)).filter(Boolean).slice(0, 12) : [],
    note: str(raw.note, 2000),
    createdAt: Number(raw.createdAt) || Date.now(),
  };
}

/* ---------------------------------- 搜索 ---------------------------------- */

/** 简易查询语法：普通词做全文匹配，tag:xxx 过滤标签，其余词 AND 组合。 */
export function parseQuery(q) {
  const tokens = String(q || '').trim().split(/\s+/).filter(Boolean);
  const tags = [];
  const words = [];
  for (const t of tokens) {
    const m = t.match(/^(?:tag|标签):(.+)$/i);
    if (m) tags.push(m[1].toLowerCase());
    else if (t.startsWith('#') && t.length > 1) tags.push(t.slice(1).toLowerCase());
    else words.push(t.toLowerCase());
  }
  return { words, tags };
}

export function matchItem(item, query) {
  const { words, tags } = parseQuery(query);
  const itemTags = (item.tags || []).map((t) => t.toLowerCase());
  for (const tag of tags) {
    if (!itemTags.some((t) => t.includes(tag))) return false;
  }
  if (!words.length) return true;
  const hay = [item.text, item.author?.name, item.note, item.source?.title, item.source?.bvid, ...(item.tags || [])]
    .join('\n')
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

/* ---------------------------------- 时间 ---------------------------------- */

const pad = (n) => String(n).padStart(2, '0');

export function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} 天前`;
  return formatTime(ts).slice(0, 10);
}

/* --------------------------------- 导出格式 -------------------------------- */

export function toJSON(items) {
  return JSON.stringify(
    {
      app: 'B站评论收藏夹',
      schema: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      count: items.length,
      items,
    },
    null,
    2
  );
}

/** 按来源页面分组，方便直接贴进笔记软件。 */
export function toMarkdown(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.source?.url || '未知来源';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const lines = [
    '# B站评论收藏',
    '',
    `- 条数：${items.length}`,
    `- 导出时间：${formatTime(Date.now())}`,
    '',
  ];

  for (const [url, list] of groups) {
    const head = list[0];
    const title = head.source?.title || url;
    const bvid = head.source?.bvid ? ` · ${head.source.bvid}` : '';
    lines.push(`## [${title}](${url})${bvid}`, '');
    for (const item of list) {
      const meta = [
        `收藏于 ${formatTime(item.createdAt)}`,
        item.author?.name ? `作者 ${item.author.name}` : '',
        item.ctime ? `发布 ${formatTime(item.ctime * 1000)}` : '',
        item.like ? `赞 ${item.like}` : '',
        item.isReply ? '楼中楼' : '',
      ].filter(Boolean);
      lines.push(`- ${meta.join(' · ')}`);
      if (item.jumpUrl) lines.push(`- [原楼层链接](${item.jumpUrl})`);
      if (item.tags?.length) lines.push(`- 标签：${item.tags.map((t) => `\`${t}\``).join(' ')}`);
      lines.push('', '> ' + String(item.text || '').replace(/\n/g, '\n> '), '');
      if (item.note) lines.push(`备注：${item.note}`, '');
    }
  }
  return lines.join('\n');
}

const CSV_HEAD = [
  '收藏时间',
  '来源标题',
  'BV号/来源',
  '评论链接',
  '作者',
  '作者UID',
  '发布时间',
  '点赞',
  '类型',
  '正文',
  '标签',
  '备注',
];

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(items) {
  const rows = [CSV_HEAD.join(',')];
  for (const item of items) {
    rows.push(
      [
        formatTime(item.createdAt),
        item.source?.title || '',
        item.source?.bvid || item.source?.url || '',
        item.jumpUrl,
        item.author?.name || '',
        item.author?.mid || '',
        formatTime(item.ctime * 1000),
        item.like || 0,
        item.isReply ? '楼中楼' : '评论',
        item.text,
        (item.tags || []).join(' '),
        item.note,
      ]
        .map(csvCell)
        .join(',')
    );
  }
  // 加 BOM，Excel 打开中文不乱码。
  return '\ufeff' + rows.join('\r\n');
}

export const EXPORTERS = {
  json: { label: 'JSON', ext: 'json', mime: 'application/json;charset=utf-8', build: toJSON },
  markdown: { label: 'Markdown', ext: 'md', mime: 'text/markdown;charset=utf-8', build: toMarkdown },
  csv: { label: 'CSV', ext: 'csv', mime: 'text/csv;charset=utf-8', build: toCSV },
};

export function exportFilename(format, count) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `b站评论收藏-${count}条-${stamp}.${EXPORTERS[format]?.ext || 'txt'}`;
}
