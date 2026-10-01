/**
 * Bridge-local slash commands.
 *
 * Only a small, closed set is owned here. Anything else that merely *looks*
 * like a command is forwarded to the agent unchanged, so the host's own
 * command surface (`/compact`, `/plan`, `/goal`, …) and a user's literal text
 * both keep working.
 *
 * Zero `@deepseek-ai/*` imports (docs/INTERFACES.md §2.0).
 *
 * @module wechat-feishu-linker/bridge/commands
 */

import { clip, shortPath } from './host.js'

/** Command names the bridge handles itself. */
export const COMMAND_NAMES = Object.freeze([
  'new',
  'status',
  'stop',
  'help',
  'workspaces',
  'cwd',
  'sessions',
  'use',
  'peek',
  'current',
  'model',
  'effort',
  'permission',
])

/** Shown when the deployment does not mount the service a command needs. */
export const UNAVAILABLE_TEXT = '⚠️ 当前宿主不提供该能力（相关服务未挂载）。'

/** Rows rendered by `/sessions` before truncation. */
export const SESSION_ROW_LIMIT = 10

/** Rows rendered by `/workspaces` before truncation. */
export const WORKSPACE_ROW_LIMIT = 10

/**
 * Parse one inbound line as a bridge command.
 *
 * @param {unknown} text - inbound message text.
 * @param {string} [prefix] - command prefix (config `commandPrefix`, default `/`).
 * @returns {{ name: string, args: string, raw: string } | null} the parsed command, or null.
 */
export function parseCommand(text, prefix = '/') {
  if (typeof text !== 'string' || typeof prefix !== 'string' || prefix.length === 0) return null
  const raw = text.trim()
  if (!raw.startsWith(prefix)) return null
  const body = raw.slice(prefix.length).trim()
  if (!body) return null
  const parts = body.split(/\s+/)
  const name = parts[0].toLowerCase()
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) return null
  return { name, args: parts.slice(1).join(' ').trim(), raw }
}

/**
 * Whether the bridge owns this command name.
 *
 * @param {string} name - parsed command name.
 * @returns {boolean} true when the bridge must handle it.
 */
export function isKnownCommand(name) {
  return COMMAND_NAMES.includes(name)
}

/**
 * Usage text for `/help`.
 *
 * @param {string} [prefix] - command prefix.
 * @returns {string} the help body.
 */
export function helpText(prefix = '/') {
  return [
    '📖 DSH 微信助手命令：',
    `${prefix}new — 开启一个新会话（当前会话保留在 DSH 中，工作区不变）`,
    `${prefix}status — 查看当前会话与模型状态`,
    `${prefix}current — 查看当前绑定的工作区与会话`,
    `${prefix}workspaces — 列出 DSH 已有工作区`,
    `${prefix}cwd <路径> — 选择工作区（之后新建的会话在此目录）`,
    `${prefix}sessions — 列出 DSH 已有会话`,
    `${prefix}use <会话id> — 把本对话绑定到已有会话（接着聊）`,
    `${prefix}peek [会话id] — 查看某会话最近的对话内容`,
    `${prefix}stop — 中断正在运行的回合`,
    `${prefix}model [序号|provider/model] — 查看/切换本对话使用的模型`,
    `${prefix}effort [档位] — 查看/切换本对话的思考档位`,
    `${prefix}permission [预设] — 查看/切换本对话的权限预设（沙箱 + 审批）`,
    `${prefix}help — 显示本帮助`,
    '',
    '切换只影响本对话，并且 DSH 界面会同步跟着变。',
    '其它消息会作为普通对话发给 DSH agent；其它斜杠命令会原样转发。',
  ].join('\n')
}

/**
 * Render `/status`.
 *
 * @param {object} info - status inputs.
 * @param {string | undefined} info.sessionId - session backing this conversation.
 * @param {string | undefined} info.agentStatus - `idle` / `running`, when an agent is live.
 * @param {{ provider?: string, model?: string, reasoningEffort?: string } | undefined} info.selection - resolved model.
 * @param {object} info.config - resolved bridge config.
 * @param {boolean} [info.channelReady] - whether the channel service is live.
 * @param {boolean} [info.agentPresent] - whether a live agent was found.
 * @param {string} [info.workspace] - the working directory new sessions use.
 * @returns {string} the status body.
 */
export function statusText(info) {
  const config = info?.config ?? {}
  const lines = ['📊 DSH 微信助手状态：']
  lines.push(`• 会话：${info?.sessionId ?? '（尚未创建，发送任意消息即可创建）'}`)
  lines.push(`• 工作区：${info?.workspace ? shortPath(info.workspace) : '（默认）'}`)
  lines.push(`• 运行状态：${describeAgentStatus(info)}`)
  const selection = info?.selection
  lines.push(
    `• 模型：${selection?.provider && selection?.model ? `${selection.provider}/${selection.model}` : '（使用 DSH 默认模型）'}` +
      (selection?.reasoningEffort ? `（reasoning: ${selection.reasoningEffort}）` : ''),
  )
  lines.push(`• 会话模式：${config.sessionMode ?? 'per-peer'}（私聊策略 ${config.dmPolicy ?? 'open'}）`)
  lines.push(`• 通道：${info?.channelReady ? '已连接' : '未就绪（未登录或未启动）'}`)
  return lines.join('\n')
}

/**
 * Human-readable agent status for `/status`.
 *
 * @param {object} info - status inputs.
 * @returns {string} the description.
 */
function describeAgentStatus(info) {
  if (!info?.sessionId) return '空闲'
  if (!info?.agentPresent) return '空闲（会话未在此进程打开）'
  if (info?.agentStatus === 'running') return '正在处理'
  return '空闲'
}

/**
 * Render `/workspaces`.
 *
 * @param {object} info - listing inputs.
 * @param {{ available: boolean, items: Array<object> }} info.listing - `HostAccess.listWorkspaces()`.
 * @param {string} [info.current] - the conversation's current workspace path.
 * @param {string} [info.prefix] - command prefix.
 * @returns {string} the reply body.
 */
export function workspacesText({ listing, current, prefix = '/' }) {
  if (!listing?.available) return UNAVAILABLE_TEXT
  const items = Array.isArray(listing.items) ? listing.items : []
  if (items.length === 0) {
    return `📁 DSH 暂无已注册的工作区。发送 ${prefix}cwd <绝对路径> 添加一个。`
  }
  const lines = [`📁 DSH 工作区（${items.length} 个）：`]
  for (const item of items.slice(0, WORKSPACE_ROW_LIMIT)) {
    const mark = current && item.path === current ? '✅ ' : '• '
    lines.push(`${mark}${shortPath(item.path)}${item.sessionCount ? `（${item.sessionCount} 个会话）` : ''}`)
  }
  if (items.length > WORKSPACE_ROW_LIMIT) lines.push(`…另有 ${items.length - WORKSPACE_ROW_LIMIT} 个未显示`)
  lines.push('', `用 ${prefix}cwd <路径> 切换工作区。`)
  return lines.join('\n')
}

/**
 * Render `/sessions`.
 *
 * @param {object} info - listing inputs.
 * @param {{ available: boolean, items: Array<object> }} info.listing - `HostAccess.listSessions()`.
 * @param {string} [info.current] - the conversation's current session id.
 * @param {string} [info.workspace] - the workspace the listing was filtered by.
 * @param {string} [info.prefix] - command prefix.
 * @returns {string} the reply body.
 */
export function sessionsText({ listing, current, workspace, prefix = '/' }) {
  if (!listing?.available) return UNAVAILABLE_TEXT
  const items = Array.isArray(listing.items) ? listing.items : []
  if (items.length === 0) {
    const scope = workspace ? `（工作区 ${shortPath(workspace)}）` : ''
    return `🗂 DSH 暂无已有会话${scope}。直接发消息即可新建一个。`
  }
  const lines = [`🗂 DSH 已有会话${workspace ? `（工作区 ${shortPath(workspace)}）` : ''}：`]
  for (const item of items.slice(0, SESSION_ROW_LIMIT)) {
    const mark = current && item.id === current ? '✅ ' : '• '
    const title = item.title ? clip(item.title, 24) : '（未命名）'
    const where = item.cwd ? ` @${shortPath(item.cwd)}` : ''
    lines.push(`${mark}${title}${where}\n   ${item.id}${item.live ? '（进行中）' : ''}`)
  }
  if (items.length > SESSION_ROW_LIMIT) lines.push(`…另有 ${items.length - SESSION_ROW_LIMIT} 个未显示`)
  lines.push('', `用 ${prefix}use <会话id> 绑定到某个会话，或 ${prefix}peek [会话id] 查看内容。`)
  return lines.join('\n')
}

/**
 * Render `/peek`.
 *
 * @param {object} info - history inputs.
 * @param {string} info.sessionId - the session that was read.
 * @param {{ available: boolean, items: Array<object>, source?: string }} info.history - `HostAccess.readHistory()`.
 * @param {string} [info.prefix] - command prefix.
 * @returns {string} the reply body.
 */
export function peekText({ sessionId, history, prefix = '/' }) {
  if (!history?.available) return UNAVAILABLE_TEXT
  const items = Array.isArray(history.items) ? history.items : []
  if (items.length === 0) {
    return `🕳 会话 ${sessionId} 没有可显示的对话内容（可能尚未开始，或内容不可读）。`
  }
  const lines = [`👀 会话 ${sessionId} 最近 ${items.length} 条${history.source === 'live' ? '（进行中）' : ''}：`]
  for (const entry of items) {
    lines.push(`${entry.role === 'user' ? '🙋 用户' : '🤖 助手'}：${clip(entry.text, 200)}`)
  }
  lines.push('', `用 ${prefix}use ${sessionId} 接着这个会话聊。`)
  return lines.join('\n')
}

/**
 * Render `/current`.
 *
 * @param {object} info - binding inputs.
 * @param {{ sessionId?: string, cwd?: string }} info.binding - the conversation binding.
 * @param {string} info.fallbackCwd - the directory new sessions would use.
 * @param {{ provider?: string, model?: string } | undefined} info.selection - resolved model.
 * @param {{ workspaces: boolean, sessions: boolean }} info.capabilities - mounted host capabilities.
 * @returns {string} the reply body.
 */
export function currentText({ binding, fallbackCwd, selection, capabilities }) {
  const lines = ['📍 当前绑定：']
  lines.push(`• 工作区：${binding?.cwd ? shortPath(binding.cwd) : `（未选择，使用 ${shortPath(fallbackCwd)}）`}`)
  lines.push(`• 会话：${binding?.sessionId ?? '（尚未创建，发送任意消息即可创建）'}`)
  lines.push(
    `• 模型：${selection?.provider && selection?.model ? `${selection.provider}/${selection.model}` : '（使用 DSH 默认模型）'}`,
  )
  const caps = capabilities ?? {}
  lines.push(
    `• 宿主能力：工作区${caps.workspaces ? '✅' : '❌'} 会话${caps.sessions ? '✅' : '❌'}`,
  )
  return lines.join('\n')
}

/**
 * Render a `/cwd` failure.
 *
 * @param {string} path - the requested path.
 * @param {string | undefined} reason - the failure reason.
 * @returns {string} the reply body.
 */
export function cwdFailureText(path, reason) {
  if (reason === 'workspace-registry-unavailable' || reason === 'workspace-create-unavailable') {
    return UNAVAILABLE_TEXT
  }
  return `⚠️ 无法把工作区切换为 ${clip(path, 120)}（${reason ?? '未知原因'}）。请确认该路径是 DSH 可访问的绝对路径。`
}

/** Model rows a listing renders before truncation. */
export const MODEL_ROW_LIMIT = 30

/**
 * Flatten a model catalog into one addressable list.
 *
 * Numbering is flat rather than per provider because the contact replies with a
 * number, and `provider/model` is always available as the unambiguous form.
 *
 * @param {object} catalog - a catalog from `readModelCatalog`.
 * @returns {{ provider: string, providerName: string, model: object }[]} the flat list.
 */
export function flattenModels(catalog) {
  const rows = []
  for (const group of catalog?.groups ?? []) {
    for (const model of group.models ?? []) {
      rows.push({ provider: group.id, providerName: group.name, model })
    }
  }
  return rows
}

/**
 * Parse the argument of `/model`.
 *
 * @param {unknown} arg - the raw argument.
 * @returns {{ index: number } | { provider: string, model: string } | null} the choice.
 */
export function parseModelChoice(arg) {
  const raw = typeof arg === 'string' ? arg.trim() : ''
  if (!raw) return null
  if (/^\d+$/.test(raw)) return { index: Number(raw) }
  const slash = raw.indexOf('/')
  if (slash <= 0 || slash === raw.length - 1) return null
  return { provider: raw.slice(0, slash).trim(), model: raw.slice(slash + 1).trim() }
}

/**
 * One-line description of a selection.
 *
 * @param {{ provider?: string, model?: string, reasoningEffort?: string } | null | undefined} selection - the selection.
 * @returns {string} the description.
 */
export function describeSelection(selection) {
  if (!selection?.provider || !selection?.model) return '（DSH 默认模型）'
  return `${selection.provider}/${selection.model}${selection.reasoningEffort ? `（思考：${selection.reasoningEffort}）` : ''}`
}

/**
 * Render `/model` with no argument.
 *
 * @param {object} catalog - a catalog from `readModelCatalog`.
 * @param {{ provider?: string, model?: string } | null} current - the conversation's current selection.
 * @param {string} [prefix] - command prefix.
 * @returns {string} the reply body.
 */
export function modelListText(catalog, current, prefix = '/') {
  const lines = ['🤖 可用模型']
  if (catalog?.available === false) {
    lines.push('⚠️ 当前宿主不提供模型目录，无法列出或切换。')
    return lines.join('\n')
  }
  const rows = flattenModels(catalog)
  if (rows.length === 0) {
    lines.push('（没有可列出的模型）')
    return lines.join('\n')
  }
  lines.push(`本对话当前：${describeSelection(current)}`, '')
  rows.slice(0, MODEL_ROW_LIMIT).forEach((row, index) => {
    lines.push(`${index + 1}. ${row.provider}/${row.model.id}`)
  })
  if (rows.length > MODEL_ROW_LIMIT) lines.push(`…另有 ${rows.length - MODEL_ROW_LIMIT} 个未列出`)
  lines.push('', `回复 ${prefix}model <序号> 或 ${prefix}model <provider>/<model> 切换。`)
  return lines.join('\n')
}

/**
 * Render `/effort` with no argument.
 *
 * @param {object | undefined} entry - the current model's catalog entry.
 * @param {{ provider?: string, model?: string, reasoningEffort?: string } | null} current - the current selection.
 * @param {string} [prefix] - command prefix.
 * @returns {string} the reply body.
 */
export function effortListText(entry, current, prefix = '/') {
  const efforts = entry?.reasoning?.efforts ?? []
  const lines = ['🧠 思考档位']
  if (efforts.length === 0) {
    lines.push(
      `当前模型 ${describeSelection(current)} 不支持思考档位切换`,
      '（可以用 /model 换一个支持思考的模型）',
    )
    return lines.join('\n')
  }
  const active = current?.reasoningEffort ?? entry?.reasoning?.defaultEffort ?? ''
  lines.push(`当前模型：${entry.provider}/${entry.model}`, `当前档位：${active || '（模型默认）'}`, '')
  for (const effort of efforts) {
    lines.push(`${effort.id === active ? '▶ ' : '  '}${effort.id}${effort.name && effort.name !== effort.id ? ` — ${effort.name}` : ''}`)
  }
  lines.push('', `回复 ${prefix}effort <档位> 切换。`)
  return lines.join('\n')
}

/**
 * Render `/permission`.
 *
 * @param {object} state - a state from `readPermissionState`.
 * @param {string} [prefix] - command prefix.
 * @returns {string} the reply body.
 */
export function permissionText(state, prefix = '/') {
  const lines = ['🔐 权限预设']
  if (state?.available === false) {
    lines.push('⚠️ 当前宿主不提供权限预设，无法列出或切换。')
    return lines.join('\n')
  }
  lines.push(`本对话当前：${state?.current || '（未知）'}`, '')
  for (const preset of state?.presets ?? []) {
    const mark = preset.name === state?.current ? '▶ ' : '  '
    lines.push(`${mark}${preset.name}${preset.label && preset.label !== preset.name ? ` — ${preset.label}` : ''}`)
    if (preset.description) lines.push(`    ${preset.description}`)
  }
  lines.push('', `回复 ${prefix}permission <预设名> 切换（沙箱模式与审批策略一起变）。`)
  return lines.join('\n')
}

/**
 * Render the confirmation for a switch.
 *
 * @param {'模型' | '思考档位' | '权限预设'} what - what was switched.
 * @param {string} detail - the new value.
 * @returns {string} the reply body.
 */
export function switchedText(what, detail) {
  return `✅ 已切换${what}：${detail}\n（只影响本对话；DSH 界面会同步显示。）`
}
