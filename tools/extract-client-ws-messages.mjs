import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outputPath = path.join(root, "CLIENT_WEBSOCKET_MESSAGES.md");
const assetsRoot = path.join(root, "static/client/2.0.1168/assets");

function listJavaScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listJavaScriptFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(entryPath);
  }
  return files;
}

const sourceUnits = listJavaScriptFiles(assetsRoot).map((filePath) => ({
  relativePath: path.relative(root, filePath).replaceAll("\\", "/"),
  source: fs.readFileSync(filePath, "utf8"),
}));
const mainUnit = sourceUnits.find((unit) => unit.relativePath === "static/client/2.0.1168/assets/main/index.33b28.js");
if (!mainUnit) throw new Error("Could not locate the main client bundle");

const source = mainUnit.source;
const enumStart = source.indexOf("var g,h,j,k,m,p;cc['_RF']");
const enumEnd = source.indexOf(
  "var q=function(){function u(){}return u['SEND']",
  enumStart,
);

if (enumStart < 0 || enumEnd < 0) {
  throw new Error("Could not locate the GameMessageEvent enums in the bundle");
}

const groups = new Map([
  ["g", { name: "SEND", title: "游戏消息发送", direction: "客户端 -> 服务端", entries: [] }],
  ["h", { name: "PUSH", title: "游戏消息推送", direction: "服务端 -> 客户端", entries: [] }],
  ["j", { name: "CHAT_SEND", title: "聊天消息发送", direction: "客户端 -> 服务端", entries: [] }],
  ["k", { name: "CHAT_PUSH", title: "聊天消息推送", direction: "服务端 -> 客户端", entries: [] }],
  ["m", { name: "ROOM_SEND", title: "房间服消息发送", direction: "客户端 -> 服务端", entries: [] }],
  ["p", { name: "ROOM_PUSH", title: "房间服消息推送", direction: "服务端 -> 客户端", entries: [] }],
]);

const block = source.slice(enumStart, enumEnd);
const enumPattern = /function\(u\)\{([^{}]*)\}\(([a-z])\|\|\(([a-z])=\{\}\)\)/g;
const entryPattern = /u\[u\['([^']+)'\]=([^\]]+)\]='([^']+)'/g;

function findMatchingBrace(text, start) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") quote = character;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  return -1;
}

function splitTopLevel(text) {
  const parts = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") quote = character;
    else if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "," && braces === 0 && brackets === 0 && parentheses === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (text.slice(start).trim()) parts.push(text.slice(start).trim());
  return parts;
}

function inferJsonExample(value) {
  const trimmed = value.trim();
  if (/^['"`]/.test(trimmed)) return "";
  if (/^(true|false)$/.test(trimmed)) return false;
  if (/^null$/.test(trimmed)) return null;
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) return 0;
  if (trimmed.startsWith("[") || trimmed.includes("Array[")) return [];
  if (trimmed.startsWith("{")) return {};
  return null;
}

function objectSchema(objectText) {
  const schema = {};
  for (const part of splitTopLevel(objectText.slice(1, -1))) {
    const separator = part.indexOf(":");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim().replace(/^['"]|['"]$/g, "");
    schema[key] = inferJsonExample(part.slice(separator + 1));
  }
  return JSON.stringify(schema);
}

function findSendPayload(family, messageName) {
  const reference = `['${family}']['${messageName}']`;
  const schemas = new Set();
  const evidence = new Set();
  for (const unit of sourceUnits) {
    let cursor = 0;
    while ((cursor = unit.source.indexOf(reference, cursor)) >= 0) {
      const callStart = unit.source.lastIndexOf("['send'](", cursor);
      if (callStart >= 0 && cursor - callStart < 1200) {
        const firstComma = unit.source.indexOf(",", cursor + reference.length);
        if (firstComma >= 0 && firstComma - cursor < 180) {
          evidence.add(unit.relativePath);
          let payloadStart = firstComma + 1;
          while (/\s/.test(unit.source[payloadStart] || "")) payloadStart += 1;
          if (unit.source[payloadStart] === "{") {
            const payloadEnd = findMatchingBrace(unit.source, payloadStart);
            if (payloadEnd >= 0) schemas.add(objectSchema(unit.source.slice(payloadStart, payloadEnd + 1)));
          } else {
            const payloadMatch = unit.source.slice(payloadStart).match(/^([A-Za-z_$][\w$]*)/);
            if (payloadMatch) {
              const variable = payloadMatch[1];
              const assignment = unit.source.lastIndexOf(`${variable}= {`.replace("= {", "={"), firstComma);
              if (assignment >= callStart - 6000) {
                const payloadObjectStart = assignment + variable.length + 1;
                const payloadEnd = findMatchingBrace(unit.source, payloadObjectStart);
                if (payloadEnd >= 0) schemas.add(objectSchema(unit.source.slice(payloadObjectStart, payloadEnd + 1)));
              }
              const assignedFields = new Set();
              const fieldPattern = new RegExp(`\\b${variable.replace(/[$\\]/g, "\\\\$&")}\\['([A-Za-z_$][\\w$]*)'\\]\\s*=`, "g");
              const assignmentText = unit.source.slice(Math.max(callStart - 6000, 0), firstComma);
              for (const field of assignmentText.matchAll(fieldPattern)) assignedFields.add(field[1]);
              if (assignedFields.size) {
                schemas.add(JSON.stringify(Object.fromEntries([...assignedFields].sort().map((field) => [field, null]))));
              }
            }
          }
        }
      }
      cursor += reference.length;
    }
  }
  const schema = schemas.size === 1
    ? [...schemas][0]
    : schemas.size > 1
      ? JSON.stringify([...schemas].map((item) => JSON.parse(item)))
      : '{ "payload": null }';
  return { schema, evidence: [...evidence].sort() };
}

function findReceiveSchema(family, messageName, id) {
  const reference = `['${family}']['${messageName}']`;
  const fields = new Set();
  let referenceCount = 0;
  const evidence = new Set();

  function addVariableFields(text, variable) {
    if (!variable) return;
    const pattern = new RegExp(`\\b${variable.replace(/[$\\]/g, "\\\\$&")}\\['([A-Za-z_$][\\w$]*)'\\]`, "g");
    for (const match of text.matchAll(pattern)) fields.add(match[1]);
  }

  for (const unit of sourceUnits) {
    let cursor = 0;
    while ((cursor = unit.source.indexOf(reference, cursor)) >= 0) {
    referenceCount += 1;
    evidence.add(unit.relativePath);
    const before = unit.source.slice(Math.max(0, cursor - 180), cursor);
    const messageBranch = before.match(/([A-Za-z_$][\w$]*)\['msgid'\]/);
    if (messageBranch) {
      const branchText = unit.source.slice(cursor, cursor + 900);
      const candidates = new Map();
      const accessPattern = /\b([a-z][A-Za-z0-9_$]*)\['([A-Za-z_$][\w$]*)'\]/g;
      for (const match of branchText.matchAll(accessPattern)) {
        if (match[1] === "this") continue;
        if (!candidates.has(match[1])) candidates.set(match[1], []);
        candidates.get(match[1]).push(match[2]);
      }
      const selected = [...candidates.entries()].sort((left, right) => right[1].length - left[1].length)[0];
      if (selected) selected[1].forEach((field) => fields.add(field));
    }

    const callbackText = unit.source.slice(cursor, cursor + 400);
    const callback = callbackText.match(/function\(([^)]*)\)\{/);
    if (callback && callback[1].trim()) {
      const bodyStart = callbackText.indexOf("{", callback.index);
      const bodyEnd = findMatchingBrace(callbackText, bodyStart);
      if (bodyEnd >= 0) {
        for (const variable of callback[1].split(",").map((value) => value.trim())) {
          addVariableFields(callbackText.slice(bodyStart, bodyEnd + 1), variable);
        }
      }
    }

    const handler = callbackText.match(/,this\['([^']+)'\]/);
    if (handler) {
      const handlerStart = unit.source.indexOf(`['${handler[1]}']=function(`);
      if (handlerStart >= 0) {
        const handlerHeaderEnd = unit.source.indexOf("{", handlerStart);
        const handlerHeader = unit.source.slice(handlerStart, handlerHeaderEnd);
        const handlerArgs = handlerHeader.match(/function\(([^)]*)\)/);
        const handlerEnd = findMatchingBrace(unit.source, handlerHeaderEnd);
        if (handlerArgs && handlerEnd >= 0) {
          const handlerBody = unit.source.slice(handlerHeaderEnd, handlerEnd + 1);
          for (const variable of handlerArgs[1].split(",").map((value) => value.trim())) {
            addVariableFields(handlerBody, variable);
          }
        }
      }
    }
    cursor += reference.length;
    }
  }

  if (referenceCount === 0) {
    return {
      schema: JSON.stringify({
        msgid: id,
        content: null,
        _schema: "未在客户端处理代码中找到字段访问",
      }),
      evidence: [],
    };
  }

  const content = Object.fromEntries([...fields].sort().map((field) => [field, null]));
  if (fields.size === 0) {
    return {
      schema: JSON.stringify({
        msgid: id,
        content: null,
        _schema: "客户端有消息引用，但未静态识别到字段访问",
      }),
      evidence: [...evidence].sort(),
    };
  }
  return {
    schema: JSON.stringify({ msgid: id, content }),
    evidence: [...evidence].sort(),
  };
}

for (const match of block.matchAll(enumPattern)) {
  const group = groups.get(match[2]);
  if (!group) continue;

  for (const entry of match[1].matchAll(entryPattern)) {
    const value = entry[2];
    const id = value.startsWith("0x") ? Number.parseInt(value.slice(2), 16) : Number(value);
    const analysis = group.name.endsWith("SEND")
      ? findSendPayload(group.name, entry[1])
      : findReceiveSchema(group.name, entry[1], id);
    group.entries.push({
      name: entry[1],
      id,
      hex: `0x${id.toString(16).toUpperCase()}`,
      schema: analysis.schema,
      evidence: analysis.evidence,
    });
  }
}

for (const group of groups.values()) {
  if (group.entries.length === 0) {
    throw new Error(`No message entries extracted for ${group.name}`);
  }
}

const total = [...groups.values()].reduce((count, group) => count + group.entries.length, 0);
const lines = [
  "# 客户端 WebSocket 消息协议清单",
  "",
  "## 来源",
  "",
  "客户端版本：`2.0.1168`。协议枚举来自 `static/client/2.0.1168/assets/main/index.33b28.js`；消息发送、WebSocket 事件回调注册和字段访问会扫描 `static/client/2.0.1168/assets/**/*.js` 全部 bundle。",
  "",
  `共提取 ${total} 条消息定义。下表中的“消息实体名”是客户端协议枚举中的实体标识，可用于在客户端代码中搜索对应消息。`,
  "",
  "说明：表中结构使用合法 JSON 示例格式。字符串用空字符串、数字用 `0`、布尔值用 `false`、未知类型用 `null` 表示占位，不代表实际默认值；对象和数组只展示已静态识别的层级。多个发送结构以 JSON 数组列出，数组元素表示候选包体，不代表实际 payload 是数组。服务端推送结构中的 `msgid` 和 `content` 为包体外层；`content` 字段从客户端处理逻辑提取。当前 bundle 未包含 `.proto` 文件或字段必填规则。",
  "消息 ID 按消息族和收发方向区分。同一个 ID 可能在不同消息族或游戏协议中复用，清单会分别保留。",
  "",
  "## 消息统计",
  "",
  "| 消息族 | 方向 | 数量 |",
  "| --- | --- | ---: |",
];

for (const group of groups.values()) {
  lines.push(`| ${group.name}（${group.title}） | ${group.direction} | ${group.entries.length} |`);
}

for (const group of groups.values()) {
  lines.push(
    "",
    `## ${group.name}：${group.title}`,
    "",
    `收发方向：${group.direction}。`,
    "",
    "| 十进制 ID | 十六进制 ID | 消息实体名（客户端协议标识） | JSON 结构示例（payload / 包体） | 证据文件/回调 |",
    "| ---: | ---: | --- | --- | --- |",
  );
  for (const entry of group.entries) {
    const evidence = entry.evidence.length
      ? entry.evidence.map((file) => `\`${file}\``).join(", ")
      : "未找到发送调用或事件回调";
    lines.push(`| ${entry.id} | ${entry.hex} | \`${entry.name}\` | \`${entry.schema.replaceAll("`", "'")}\` | ${evidence} |`);
  }
}

lines.push(
  "",
  "## 消息实体说明",
  "",
  "- 消息实体名是客户端枚举中的协议名称，例如 `SEND_JOIN_ROOM`、`ROOM_TYPE_RESULT`。表格的证据列记录全量 bundle 中找到的发送调用或事件回调文件。",
  "- 游戏消息 `SEND/PUSH` 使用游戏/API socket；聊天消息 `CHAT_SEND/CHAT_PUSH` 使用聊天 socket；房间服消息 `ROOM_SEND/ROOM_PUSH` 使用辅助房间 socket。",
  "- 游戏和聊天 payload 会被序列化为 JSON UTF-8 后放入自定义二进制帧。",
  "- 发送消息的 JSON 示例来自静态发送调用；占位值仅用于表达字段类型或未知状态，不是协议默认值。多个候选结构以 JSON 数组列出，需根据实际调用场景选择。",
  "- 推送消息以 `msgid + content` JSON 包体表示；能识别字段时，字段值以 `null` 占位。若 `content` 为 `null` 且带 `_schema`，表示当前 bundle 没有足够的客户端字段访问证据，不能把它当作真实空对象。",
  "- 本清单来自协议枚举定义；列入清单不代表当前运行流程一定会发送或收到该消息。",
  "",
);

fs.writeFileSync(outputPath, lines.join("\n"), "utf8");
console.log(`Wrote ${total} message entries to ${path.relative(root, outputPath)}`);
