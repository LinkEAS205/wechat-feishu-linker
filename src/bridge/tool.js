/**
 * Model-facing `wechat_send` tool: lets an agent push text to a WeChat contact
 * through the channel service.
 *
 * Registered as a **raw tool definition object** — this plugin must not import
 * `@deepseek-ai/dsh-tools`, so `defineTool` is unavailable and the structural
 * shape the registry consumes is built by hand (same pattern as the
 * `dsh-wechat` precedent). The tool is registered only when the host has
 * composed a `tools` service; its absence is a degradation, never a load
 * failure.
 *
 * @module wechat-feishu-linker/bridge/tool
 */

/** Prompt section name for the tool guidance. */
export const TOOL_PROMPT_SECTION = 'tool:wechat_send'

/** Prompt section order — after the channel note. */
export const TOOL_PROMPT_ORDER = 120

/** Model-facing tool name. */
export const TOOL_NAME = 'wechat_send'

/**
 * Build the `wechat_send` tool definition.
 *
 * @param {object} options - registration inputs.
 * @param {object} options.service - channel service exposing `sendText`.
 * @param {string} [options.defaultToUserId] - peer used when the model omits one.
 * @param {(level: string, message: string) => void} [options.log] - logger.
 * @returns {object} the registry-ready definition.
 */
export function createWechatSendTool({ service, defaultToUserId, log }) {
  return {
    name: TOOL_NAME,
    description:
      'Send a text message to a WeChat contact through the connected WeChat (iLink) channel. ' +
      'Use it only for proactive messages — a reply to an inbound WeChat message is delivered ' +
      'automatically and does not need this tool.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        toUserId: {
          type: 'string',
          description:
            'Target WeChat peer id (the iLink user id the contact messaged from). ' +
            'Omit it to send to the only known contact of this deployment.',
        },
        text: {
          type: 'string',
          description: 'Message text. Long text is chunked automatically.',
        },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const text = typeof args?.text === 'string' ? args.text.trim() : ''
      const explicit = typeof args?.toUserId === 'string' ? args.toUserId.trim() : ''
      const toUserId = explicit || defaultToUserId || ''
      if (!toUserId) {
        return { ok: false, message: 'wechat_send: no target peer; pass toUserId explicitly.' }
      }
      if (!text) {
        return { ok: false, message: 'wechat_send: text is required.' }
      }
      try {
        const result = await service.sendText(toUserId, text)
        const ids = Array.isArray(result?.messageIds) ? result.messageIds.filter((id) => id) : []
        return {
          ok: true,
          message:
            `Sent ${ids.length || 1} message(s) to ${toUserId}` +
            (ids.length > 0 ? ` (ids: ${ids.join(', ')})` : ''),
        }
      } catch (error) {
        log?.('warn', `wechat_send failed: ${String(error)}`)
        return { ok: false, message: `wechat_send failed: ${String(error)}` }
      }
    },
  }
}

/**
 * Register the `wechat_send` tool and its prompt guidance.
 *
 * Every step is optional: a missing `tools` service skips registration, and a
 * missing `systemPrompt` service skips the guidance. Returns whether the tool
 * itself was registered.
 *
 * @param {object} options - registration inputs.
 * @param {object | undefined} options.tools - host `tools` service.
 * @param {object | undefined} options.systemPrompt - host `systemPrompt` service.
 * @param {object} options.service - channel service exposing `sendText`.
 * @param {string} [options.defaultToUserId] - peer used when the model omits one.
 * @param {(level: string, message: string) => void} [options.log] - logger.
 * @returns {boolean} true when the tool was registered.
 */
export function registerWechatSendTool({ tools, systemPrompt, service, defaultToUserId, log }) {
  try {
    systemPrompt?.section?.({
      name: TOOL_PROMPT_SECTION,
      order: TOOL_PROMPT_ORDER,
      text:
        'Use the wechat_send tool to push a text message to a WeChat contact. It only reaches ' +
        'contacts that have already messaged this bot; ordinary replies to an inbound WeChat ' +
        'message are sent automatically and do not need this tool.',
    })
  } catch (error) {
    log?.('warn', `wechat_send prompt section not installed: ${String(error)}`)
  }
  if (!tools || typeof tools.register !== 'function') {
    log?.('warn', 'wechat_send tool not registered: the tools service is unavailable')
    return false
  }
  try {
    tools.register(createWechatSendTool({ service, defaultToUserId, log }))
    return true
  } catch (error) {
    log?.('warn', `wechat_send tool registration failed: ${String(error)}`)
    return false
  }
}
