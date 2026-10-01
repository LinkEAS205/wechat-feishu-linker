/**
 * Host compatibility self-check.
 *
 * The plugin reads every host capability structurally, so a DSH update that
 * renames or drops one does not raise an error anywhere — the affected feature
 * simply stops working, and the symptom ("why doesn't /model answer?") is a long
 * way from the cause. This module probes the surfaces the plugin actually uses
 * and reports which are present, so an incompatible host is visible immediately
 * instead of being reverse-engineered from behaviour.
 *
 * Every probe is read-only and guarded: probing a missing service must never be
 * the thing that breaks the load it is meant to protect.
 *
 * Zero `@deepseek-ai/*` imports (docs/INTERFACES.md §2.0).
 *
 * @module wechat-feishu-linker/bridge/compat
 */

/**
 * Host surfaces this plugin reads.
 *
 * `kind` distinguishes a Cordis service (`ctx.get(name)`) from a context
 * capability read directly on `ctx`. `affects` is written for the person reading
 * the report: it says what stops working, not what the API is called.
 */
export const HOST_SURFACES = Object.freeze([
  { name: 'agents', kind: 'service', affects: '创建与恢复会话 —— 缺了整个桥接不可用' },
  { name: 'sessionPersistence', kind: 'service', affects: '重启后接着原会话（会改为新建）' },
  { name: 'agentDefaultModel', kind: 'service', affects: '未显式指定模型时的部署默认模型' },
  { name: 'tools', kind: 'service', affects: 'wechat_send 工具' },
  { name: 'systemPrompt', kind: 'service', affects: '通道提示词注入' },
  { name: 'sessionQuery', kind: 'service', affects: '/peek 查看历史' },
  { name: 'sessionProjectionCache', kind: 'service', affects: '会话标题等界面提示' },
  { name: 'workspaceRegistry', kind: 'service', affects: '/workspaces、/cwd' },
  { name: 'configEditor', kind: 'service', affects: '设置写回配置文件（否则只生效到重启）' },
  { name: 'llm', kind: 'service', affects: '/model、/effort' },
  { name: 'permissionPresets', kind: 'service', affects: '/permission' },
  { name: 'on', kind: 'ctx', affects: '事件监听 —— 缺了整个桥接不可用' },
  { name: 'waterfall', kind: 'ctx', affects: '审批卡 / 选择卡镜像' },
])

/**
 * Read one host surface without letting the probe itself throw.
 *
 * `ctx.get` may throw for a service the host never provided, which is exactly
 * the case this check exists to report.
 *
 * @param {object} ctx - plugin context.
 * @param {{ name: string, kind: string }} surface - the surface to read.
 * @returns {unknown} the surface, or undefined when it is absent.
 */
function probe(ctx, surface) {
  try {
    if (surface.kind === 'ctx') return typeof ctx?.[surface.name] === 'function' ? ctx[surface.name] : undefined
    return ctx?.get?.(surface.name)
  } catch {
    return undefined
  }
}

/**
 * Probe every host surface this plugin depends on.
 *
 * @param {object} ctx - plugin context.
 * @returns {{ ok: boolean, available: string[], missing: { name: string, affects: string }[], total: number }}
 * the report.
 */
export function checkHostCompat(ctx) {
  const available = []
  const missing = []
  for (const surface of HOST_SURFACES) {
    if (probe(ctx, surface) === undefined) missing.push({ name: surface.name, affects: surface.affects })
    else available.push(surface.name)
  }
  return { ok: missing.length === 0, available, missing, total: HOST_SURFACES.length }
}

/**
 * Render a compatibility report as one log line.
 *
 * A full report is only worth a single line when everything is present; anything
 * missing is spelled out, because that is the line somebody will actually need.
 *
 * @param {object} report - a report from {@link checkHostCompat}.
 * @returns {string} the line.
 */
export function describeCompat(report) {
  if (report?.ok) return `host compatibility: ${report.total}/${report.total} surfaces available`
  const detail = (report?.missing ?? []).map((entry) => `${entry.name} (${entry.affects})`).join('; ')
  return `host compatibility: ${report?.available?.length ?? 0}/${report?.total ?? 0} surfaces available — missing: ${detail}`
}
