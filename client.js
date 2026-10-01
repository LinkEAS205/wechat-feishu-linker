/**
 * wechat-feishu-linker — client half (Settings → 微信 ClawBot).
 *
 * Authored directly in the DSH client module format (`window.__ModuleLoader__`),
 * the same delivery shape as the shipped `dsh-wechat` settings page: the host's
 * client-modules service serves this file at `/plugins/wechat-feishu-linker/client.js`
 * and the browser kernel loads it.
 *
 * Hard rules this file keeps:
 *   - `react` is the only module required; **no `@deepseek-ai/*` import** (those
 *     packages are not resolvable from a third-party plugin and change without
 *     notice — see the plugin-development `references/practices.md`, UI section).
 *   - The factory is lazy and side-effect free: it touches no DOM and performs no
 *     network request. Everything happens in `apply`/render.
 *   - One `settings.section` registration, through `ctx.slots.inject`, so the
 *     entry is installed when the declaration exists and disposed with it.
 *   - Styles are rendered as part of the component subtree (never appended to
 *     `document.head`) and reference only `--dsw-alias-*` theme tokens.
 *
 * All host communication goes through this plugin's own HTTP API under
 * `/wechat-ilink/api` (see `src/web/routes.js`).
 */
window.__ModuleLoader__.load({
	id: 'wechat-feishu-linker',
	factory: (require) => {
		const React = require('react')
		const h = React.createElement
		const { useCallback, useEffect, useState } = React

		/** Base path of the plugin's host API. */
		const API = '/wechat-ilink/api'

		/** Slot this entry occupies. */
		const SLOT = 'settings.section'

		/** Registration id (nav key) and label. */
		const SECTION_ID = 'wechat-ilink'
		const SECTION_LABEL = 'ClawBot 设置'

/** How each channel is named in the UI. */
const CHANNEL_LABELS = { 'wechat-ilink': '微信', feishu: '飞书' }

		const CSS = [
			'.wil_root{display:flex;flex-direction:column;gap:16px;padding:4px 0 8px;font-size:13px;color:var(--dsw-alias-label-primary)}',
			// The two channels are independent rows with independent credentials and
			// independent defaults, so the page groups their cards under one heading
			// each rather than interleaving them.
			'.wil_section{display:flex;flex-direction:column;gap:12px}',
			'.wil_section_title{font-size:15px;font-weight:600;padding:2px 0;color:var(--dsw-alias-label-primary)}',
			'.wil_card{border:0.5px solid var(--dsw-alias-border-l3);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-1)}',
			'.wil_row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
			'.wil_col{display:flex;flex-direction:column;gap:6px}',
			'.wil_title{font-weight:600;font-size:14px}',
			'.wil_actions{margin-left:auto;display:flex;gap:8px;align-items:center}',
			'.wil_badge{font-size:11px;line-height:1.7;padding:0 8px;border-radius:999px;border:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}',
			'.wil_badge.ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}',
			'.wil_badge.wait{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent)}',
			'.wil_badge.err{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}',
			'.wil_meta{font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all}',
			'.wil_err{font-size:12px;color:var(--dsw-alias-state-error-primary);word-break:break-all}',
			'.wil_ok{font-size:12px;color:var(--dsw-alias-state-success-primary);word-break:break-all}',
			'.wil_btn{cursor:pointer;font:inherit;font-size:12px;padding:5px 12px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
			'.wil_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
			'.wil_btn:disabled{opacity:.5;cursor:default}',
			'.wil_btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
			'.wil_btn.primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
			'.wil_btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
			'.wil_btn.danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);color:var(--dsw-alias-state-error-primary)}',
			'.wil_qr{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}',
			'.wil_qr img{width:220px;height:220px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3)}',
			'.wil_qr_side{display:flex;flex-direction:column;gap:6px;min-width:200px;max-width:360px}',
			'.wil_count{font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
			'.wil_select{font:inherit;font-size:12px;padding:5px 8px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);max-width:100%}',
			'.wil_select:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
			'.wil_link{font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all;user-select:all}',
			'.wil_sep{height:1px;background:var(--dsw-alias-border-l2)}',
			'.wil_hint{border:0.5px solid var(--dsw-alias-border-l3);border-radius:12px;padding:12px 16px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
		].join('')

		/**
		 * Call the host API.
		 *
		 * @param {string} path - path below `/wechat-ilink/api`.
		 * @param {object} [options] - fetch options.
		 * @returns {Promise<{ok:boolean,status:number,body:object,json:boolean}>}
		 * the parsed response; `json` is false when the body was not a JSON object
		 * (which is how a missing host API looks: the SPA fallback answers HTML).
		 */
		async function request(path, options) {
			const response = await fetch(API + path, {
				cache: 'no-store',
				headers: { 'Content-Type': 'application/json' },
				...options,
			})
			let body = null
			try {
				body = await response.json()
			} catch {
				body = null
			}
			const json = body !== null && typeof body === 'object'
			return {
				ok: response.ok && json,
				status: response.status,
				body: json ? body : {},
				json,
			}
		}

		/** Human label for a login phase. */
		const LOGIN_LABEL = {
			pending: '等待扫码',
			scanned: '已扫码，待确认',
			success: '绑定成功',
			expired: '二维码已过期',
			error: '绑定失败',
		}

		/** One-line guidance for a login phase. */
		const LOGIN_HINT = {
			pending: '用手机微信扫描二维码，确认后自动完成绑定。',
			scanned: '已扫描，请在手机上点击确认。',
			success: '绑定成功，凭据已写入本机。',
			expired: '二维码已过期，请重新点击「扫码绑定」。',
			error: '绑定失败，请重试或查看下方错误信息。',
		}

		/**
		 * @param {string} phase - login phase.
		 * @returns {'ok'|'wait'|'err'} the badge class.
		 */
		function loginBadgeClass(phase) {
			if (phase === 'success') return 'ok'
			if (phase === 'expired' || phase === 'error') return 'err'
			return 'wait'
		}

		/**
		 * @param {unknown} value - candidate.
		 * @returns {string} the string when non-empty, else `''`.
		 */
		function text(value) {
			return typeof value === 'string' ? value : ''
		}

		/** Settings → 微信 ClawBot. */
		function WechatIlinkSection() {
			const [status, setStatus] = useState(null)
			const [hostMissing, setHostMissing] = useState(false)
			const [busy, setBusy] = useState('')
			const [note, setNote] = useState({ kind: '', text: '' })
			const [login, setLogin] = useState(null)
			const [remaining, setRemaining] = useState(0)
			const [workspaces, setWorkspaces] = useState(null)
			const [sessions, setSessions] = useState(null)
			const [choice, setChoice] = useState({ workspace: '', sessionId: '' })
			const [bindNote, setBindNote] = useState({ kind: '', text: '' })
			// The Feishu channel is a separate service row, so it has its own
			// status and its own binding form. `mounted: false` means the row is
			// absent — a different problem from "unbound", and only one of them is
			// fixed by typing credentials.
			const [feishu, setFeishu] = useState(null)
			const [feishuForm, setFeishuForm] = useState({ appId: '', appSecret: '', domain: 'feishu' })
			const [feishuLogin, setFeishuLogin] = useState(null)
			const [feishuManual, setFeishuManual] = useState(false)

			const beginFeishuLogin = useCallback(async () => {
				setBusy('feishu')
				setBindNote({ kind: '', text: '' })
				try {
					const result = await request('/feishu/login/begin', { method: 'POST', body: '{}' })
					if (!result.ok) {
						setBindNote({ kind: 'err', text: text(result.body?.message) || `发起扫码失败 (HTTP ${result.status})` })
						return
					}
					setFeishuLogin(result.body)
				} catch (error) {
					setBindNote({ kind: 'err', text: String(error?.message ?? error) })
				} finally {
					setBusy('')
				}
			}, [])

			const refreshFeishu = useCallback(async () => {
				try {
					const result = await request('/feishu/status')
					if (!result.json) {
						setFeishu({ mounted: false, status: null })
						return
					}
					setFeishu(result.body ?? { mounted: false, status: null })
				} catch (error) {
					setFeishu({ mounted: false, status: null })
				}
			}, [])

			// Poll the registration while a QR is showing, at the cadence the
			// platform asked for — including its `slow_down`.
			useEffect(() => {
				if (!feishuLogin || !feishuLogin.qrcode) return undefined
				let cancelled = false
				let timer
				const tick = async () => {
					try {
						const result = await request(`/feishu/login/poll?qrcode=${encodeURIComponent(feishuLogin.qrcode)}`)
						if (cancelled) return
						const status = result.body?.status
						if (status === 'pending') {
							timer = setTimeout(tick, Math.max(1000, feishuLogin.interval || 5000))
							return
						}
						setFeishuLogin(null)
						if (status === 'success') {
							setBindNote({ kind: 'ok', text: `已创建并绑定应用 ${result.body.appId}` })
							refreshFeishu()
							return
						}
						const known = { expired: '二维码已过期，请重新生成', access_denied: '你取消了授权' }
						setBindNote({ kind: 'err', text: known[status] || text(result.body?.message) || '扫码绑定失败' })
					} catch (error) {
						if (!cancelled) setBindNote({ kind: 'err', text: String(error?.message ?? error) })
					}
				}
				timer = setTimeout(tick, Math.max(1000, feishuLogin.interval || 5000))
				return () => {
					cancelled = true
					clearTimeout(timer)
				}
			}, [feishuLogin, refreshFeishu])

			const bindFeishu = useCallback(async () => {
				setBusy('feishu')
				setBindNote({ kind: '', text: '' })
				try {
					const result = await request('/feishu/bind', {
						method: 'POST',
						body: JSON.stringify(feishuForm),
					})
					if (!result.ok) {
						setBindNote({ kind: 'err', text: text(result.body?.message) || `绑定失败 (HTTP ${result.status})` })
						return
					}
					setFeishu({ mounted: true, status: result.body.status })
					setFeishuForm((previous) => ({ ...previous, appSecret: '' }))
					setBindNote({ kind: 'ok', text: '飞书应用已绑定，长连接正在建立' })
				} catch (error) {
					setBindNote({ kind: 'err', text: String(error?.message ?? error) })
				} finally {
					setBusy('')
				}
			}, [feishuForm])

			const unbindFeishu = useCallback(async () => {
				setBusy('feishu')
				try {
					const result = await request('/feishu/logout', { method: 'POST' })
					if (result.ok) setFeishu({ mounted: true, status: result.body.status })
				} finally {
					setBusy('')
				}
			}, [])

			const refreshStatus = useCallback(async () => {
				try {
					const result = await request('/status')
					if (!result.json || result.status === 404) {
						setHostMissing(true)
						return
					}
					setHostMissing(false)
					if (!result.ok) {
						setNote({ kind: 'err', text: text(result.body.message) || `读取状态失败 (HTTP ${result.status})` })
						return
					}
					setStatus(result.body)
				} catch (error) {
					setHostMissing(true)
				}
			}, [])

			const refreshWorkspaces = useCallback(async () => {
				try {
					const result = await request('/workspaces')
					if (!result.json) {
						setHostMissing(true)
						return
					}
					setWorkspaces(
						result.ok
							? result.body
							: { available: false, items: [], message: text(result.body.message) || `读取工作区失败 (HTTP ${result.status})` },
					)
				} catch (error) {
					setHostMissing(true)
				}
			}, [])

			const refreshSessions = useCallback(async (workspace) => {
				try {
					const suffix = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''
					const result = await request('/sessions' + suffix)
					if (!result.json) {
						setHostMissing(true)
						return
					}
					setSessions(
						result.ok
							? result.body
							: { available: false, items: [], message: text(result.body.message) || `读取会话失败 (HTTP ${result.status})` },
					)
				} catch (error) {
					setHostMissing(true)
				}
			}, [])

			/**
			 * Write one runtime setting, then re-render from what the bridge reports.
			 *
			 * The response body is rendered rather than the value that was asked
			 * for: if the bridge clamps or refuses it, the page has to show what
			 * the bridge actually holds, not what the click intended. That is also
			 * what keeps this page and the relay from ever disagreeing — there is
			 * one value, and this component only ever displays it.
			 *
			 * @param {object} patch - the settings to change.
			 * @returns {Promise<void>}
			 */
			const changeSetting = useCallback(
				async (patch) => {
					setBusy('settings')
					setNote({ kind: '', text: '' })
					try {
						const result = await request('/settings', { method: 'POST', body: JSON.stringify(patch) })
						if (!result.json || result.status === 404) {
							setHostMissing(true)
							return
						}
						if (!result.ok || result.body.ok !== true) {
							setNote({
								kind: 'err',
								text: text(result.body.message) || `设置失败 (HTTP ${result.status})`,
							})
							// The write may have half-applied, so re-read the truth.
							refreshStatus()
							return
						}
						setStatus((previous) =>
							previous ? { ...previous, settings: result.body.settings } : previous,
						)
						setNote(
							result.body.persisted === false
								? { kind: 'ok', text: '已立即生效；但没能写入配置文件，重启后会恢复原值。' }
								: { kind: 'ok', text: '已保存，重启后仍然生效。' },
						)
					} catch (error) {
						setHostMissing(true)
					} finally {
						setBusy('')
					}
				},
				[refreshStatus],
			)

			// Initial load: status + workspaces + the Feishu row.
			useEffect(() => {
				refreshStatus()
				refreshWorkspaces()
				refreshFeishu()
			}, [refreshStatus, refreshWorkspaces, refreshFeishu])

			// Sessions follow the selected workspace.
			useEffect(() => {
				refreshSessions(choice.workspace)
			}, [choice.workspace, refreshSessions])

			const loginActive = Boolean(login) && (login.status === 'pending' || login.status === 'scanned')

			// Poll `/login/poll` until the QR reaches a terminal phase. Keyed on the
			// QR id and on "still active", so a locally expired countdown stops it.
			useEffect(() => {
				const qrcode = login && login.qrcode
				if (!qrcode || !loginActive) return undefined
				const interval = (login && login.intervalMs) || 3000
				let cancelled = false
				let timer
				const tick = async () => {
					let result
					try {
						result = await request(`/login/poll?qrcode=${encodeURIComponent(qrcode)}`)
					} catch (error) {
						result = null
					}
					if (cancelled) return
					if (result === null) {
						timer = setTimeout(tick, interval)
						return
					}
					const body = result.body || {}
					const phase = text(body.status) || 'error'
					setLogin((previous) =>
						previous && previous.qrcode === qrcode
							? { ...previous, status: phase, message: text(body.message) }
							: previous,
					)
					if (phase === 'success') {
						setNote({ kind: 'ok', text: text(body.botId) ? `绑定成功：${body.botId}` : '绑定成功' })
						refreshStatus()
						refreshWorkspaces()
						return
					}
					if (phase === 'expired') {
						setNote({ kind: 'err', text: '二维码已过期，请重新获取' })
						return
					}
					if (phase === 'error') {
						setNote({ kind: 'err', text: text(body.message) || '绑定失败' })
						return
					}
					timer = setTimeout(tick, interval)
				}
				timer = setTimeout(tick, interval)
				return () => {
					cancelled = true
					clearTimeout(timer)
				}
			}, [login && login.qrcode, loginActive, refreshStatus, refreshWorkspaces])

			// Countdown, and local expiry when the host never answers again.
			useEffect(() => {
				if (!login) return undefined
				const expiresAt = login.expiresAt
				const update = () => {
					const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
					setRemaining(left)
					if (left <= 0) {
						setLogin((previous) =>
							previous && (previous.status === 'pending' || previous.status === 'scanned')
								? { ...previous, status: 'expired', message: '二维码已过期' }
								: previous,
						)
					}
				}
				update()
				const id = setInterval(update, 1000)
				return () => clearInterval(id)
			}, [login && login.qrcode, login && login.expiresAt])

			const startLogin = useCallback(async () => {
				setBusy('begin')
				setNote({ kind: '', text: '' })
				setLogin(null)
				try {
					const result = await request('/login/begin', { method: 'POST' })
					if (!result.ok || !text(result.body.qrcode)) {
						setNote({ kind: 'err', text: text(result.body.message) || `获取二维码失败 (HTTP ${result.status})` })
						return
					}
					const expiresAt = Number(result.body.expiresAt) || Date.now() + 120000
					setLogin({
						qrcode: result.body.qrcode,
						qrUrl: text(result.body.qrUrl),
						qrImageUrl: text(result.body.qrImageUrl),
						expiresAt,
						intervalMs: Number(result.body.intervalMs) || 3000,
						status: 'pending',
						message: '',
					})
					setRemaining(Math.max(0, Math.round((expiresAt - Date.now()) / 1000)))
				} catch (error) {
					setNote({ kind: 'err', text: `无法连接宿主接口：${error && error.message ? error.message : String(error)}` })
				} finally {
					setBusy('')
				}
			}, [])

			const logout = useCallback(async () => {
				if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
					if (!window.confirm('确定解绑微信 ClawBot？解绑后需要重新扫码才能继续使用。')) return
				}
				setBusy('logout')
				setNote({ kind: '', text: '' })
				try {
					const result = await request('/logout', { method: 'POST' })
					if (!result.ok) {
						setNote({ kind: 'err', text: text(result.body.message) || `解绑失败 (HTTP ${result.status})` })
						return
					}
					setNote({ kind: 'ok', text: text(result.body.message) || '已解绑' })
					setLogin(null)
					refreshStatus()
					refreshSessions(choice.workspace)
				} catch (error) {
					setNote({ kind: 'err', text: error && error.message ? error.message : String(error) })
				} finally {
					setBusy('')
				}
			}, [choice.workspace, refreshSessions, refreshStatus])

			const applyBinding = useCallback(async () => {
				if (!choice.workspace && !choice.sessionId) {
					setBindNote({ kind: 'err', text: '请先选择工作区或会话' })
					return
				}
				setBusy('bind')
				setBindNote({ kind: '', text: '' })
				try {
					const payload = {}
					if (choice.workspace) payload.workspace = choice.workspace
					if (choice.sessionId) payload.sessionId = choice.sessionId
					const result = await request('/bind', { method: 'POST', body: JSON.stringify(payload) })
					if (!result.json) {
						setBindNote({ kind: 'err', text: `切换失败 (HTTP ${result.status})` })
						return
					}
					const ok = result.ok && result.body.ok !== false
					setBindNote({ kind: ok ? 'ok' : 'err', text: text(result.body.message) || (ok ? '已切换' : '切换失败') })
					if (ok) {
						refreshWorkspaces()
						refreshSessions(choice.workspace)
					}
				} catch (error) {
					setBindNote({ kind: 'err', text: error && error.message ? error.message : String(error) })
				} finally {
					setBusy('')
				}
			}, [choice.workspace, choice.sessionId, refreshSessions, refreshWorkspaces])

			const styleTag = h('style', { key: 'wil-style' }, CSS)

			if (hostMissing) {
				return h(
					'div',
					{ className: 'wil_root' },
					styleTag,
					h(
						'div',
						{ className: 'wil_hint' },
						h('div', { className: 'wil_title' }, '微信'),
						h('div', null, '当前宿主未启用 Web 服务，无法在界面内扫码绑定。'),
						h('div', null, '请在 DSH profile 的 cordis.patch.yml 中启用 webServer 后重启，或改用命令行：node scripts/login.mjs'),
					),
				)
			}

			const bound = Boolean(status && status.bound)
			const badge = !status
				? { label: '加载中', cls: 'wait' }
				: bound
					? { label: '已绑定', cls: 'ok' }
					: { label: '未绑定', cls: 'wait' }
			const pollBadge = !status
				? null
				: status.polling || status.connected
					? { label: '轮询中', cls: 'ok' }
					: { label: '未连接', cls: 'wait' }
			const errorText = text(status && status.lastError)

			const workspaceItems = workspaces && workspaces.available && Array.isArray(workspaces.items) ? workspaces.items : []
			const sessionItems = sessions && sessions.available && Array.isArray(sessions.items) ? sessions.items : []

			// Rendered straight from the last `/status` payload, with no copy kept
			// here: reopening this page (or pressing 刷新) therefore always shows
			// what the bridge is really relaying with, no matter which surface
			// changed it last.
			const live = status && status.settings ? status.settings : null
			// A DSH update that renames or drops a host surface raises no error
			// anywhere — the feature just stops working — so the bridge's probe
			// result is shown here rather than left in a log nobody reads.
			const compat = status && status.hostCompat ? status.hostCompat : null
			const compatLine = compat
				? compat.ok
					? h('div', { className: 'wil_meta' }, `宿主兼容性：${compat.total}/${compat.total} 项可用`)
					: h(
						'div',
						{ className: 'wil_err' },
						`宿主兼容性：${compat.available.length}/${compat.total} 项可用；缺少 ` +
							compat.missing.map((entry) => `${entry.name}（${entry.affects}）`).join('、'),
					)
				: null
			// A reply the closed conversation window is holding is otherwise
			// invisible: the notice that would report it travels the same closed
			// channel, so the contact sees half an answer and nothing says why.
			// This line is the only place they can learn it exists — and that a
			// single message from WeChat flushes it.
			const waiting = status && status.undelivered ? status.undelivered : null
			const undeliveredLine =
				waiting && waiting.count > 0
					? h(
						'div',
						{ className: 'wil_err' },
						`⚠️ 有 ${waiting.count} 条回复因微信会话窗口关闭未能送达（共 ${waiting.chars} 字）——` +
							'在微信里随便发一条消息即可补发。',
					)
					: null
			// Defaults for sessions this bridge creates — a different thing from the
			// WeChat commands, which switch the *current* conversation. This page is
			// global and has no "current conversation", so it can only set defaults;
			// and because a session's own choice always wins, changing these can
			// never undo a switch made from WeChat.
			const catalog = status && status.catalog ? status.catalog : null
			const permissions = status && status.permissions ? status.permissions : null
			const modelRows = []
			for (const group of (catalog && catalog.groups) || []) {
				for (const model of group.models || []) modelRows.push({ provider: group.id, model })
			}
			/**
			 * One group of "new session defaults" controls.
			 *
			 * With no `channelName` this renders the fallback every channel
			 * inherits. With one it renders that channel's *overrides*, where an
			 * empty value means "inherit" — the option label names what is being
			 * inherited, so the page never shows a blank where a value is in use.
			 */
			const defaultsGroup = (label, overrides, channelName, inherited) => {
				const own = overrides ?? {}
				const modelValue = own.provider && own.model ? `${own.provider}/${own.model}` : ''
				const entry = modelRows.find((row) => `${row.provider}/${row.model.id}` === modelValue)
				const efforts = (entry && entry.model.reasoning && entry.model.reasoning.efforts) || []
				const write = (patch) =>
					channelName ? changeSetting({ channels: { [channelName]: patch } }) : changeSetting(patch)
				const setModel = (value) => {
					if (!value) {
						void write({ provider: '', model: '' })
						return
					}
					const slash = value.indexOf('/')
					void write({ provider: value.slice(0, slash), model: value.slice(slash + 1) })
				}
				const inheritLabel = (what) => (channelName ? `（继承：${what || '未设置'}）` : '（用 DSH 部署默认）')
				return h(
					'div',
					{ className: 'wil_col' },
					h('div', { className: 'wil_meta' }, label),
					h(
						'div',
						{ className: 'wil_row' },
						h('span', { className: 'wil_meta' }, '模型'),
						modelRows.length > 0
							? h(
								'select',
								{
									className: 'wil_select',
									value: modelValue,
									disabled: busy !== '',
									onChange: (event) => setModel(event.target.value),
								},
								h('option', { value: '' }, inheritLabel(inherited ? `${inherited.provider}/${inherited.model}` : '')),
								modelRows.map((row) => {
									const value = `${row.provider}/${row.model.id}`
									return h('option', { key: value, value }, value)
								}),
							)
							: h('span', { className: 'wil_meta' }, '宿主不提供模型目录'),
					),
					h(
						'div',
						{ className: 'wil_row' },
						h('span', { className: 'wil_meta' }, '思考档位'),
						efforts.length > 0
							? h(
								'select',
								{
									className: 'wil_select',
									value: own.reasoningEffort || '',
									disabled: busy !== '',
									onChange: (event) => write({ reasoningEffort: event.target.value }),
								},
								h('option', { value: '' }, channelName ? inheritLabel(inherited?.reasoningEffort) : '（模型默认）'),
								efforts.map((effort) =>
									h('option', { key: effort.id, value: effort.id }, effort.name || effort.id),
								),
							)
							: h('span', { className: 'wil_meta' }, modelValue ? '该模型不支持思考档位' : '先选模型'),
					),
					permissions && permissions.available
						? h(
							'div',
							{ className: 'wil_row' },
							h('span', { className: 'wil_meta' }, '权限预设'),
							h(
								'select',
								{
									className: 'wil_select',
									value: own.permissionPreset || '',
									disabled: busy !== '',
									onChange: (event) => write({ permissionPreset: event.target.value }),
								},
								h('option', { value: '' }, channelName ? inheritLabel(inherited?.permissionPreset) : '（用 DSH 部署默认）'),
								(permissions.presets || []).map((preset) =>
									h('option', { key: preset.name, value: preset.name }, preset.label || preset.name),
								),
							),
						)
						: null,
				)
			}
			const inheritedDefaults = live
				? {
					provider: live.provider,
					model: live.model,
					reasoningEffort: live.reasoningEffort,
					permissionPreset: live.permissionPreset,
				}
				: {}
			/** The fallback every channel inherits until it says otherwise. */
			const globalDefaultsCard = h(
				'div',
				{ className: 'wil_card' },
				h(
					'div',
					{ className: 'wil_row' },
					h('span', { className: 'wil_title' }, '所有通道的兜底'),
					h('span', { className: 'wil_meta' }, '通道没自己设的，就用这里的值'),
				),
				live ? defaultsGroup('兜底默认', {}, undefined, undefined) : null,
			)

			/**
			 * The new-session defaults for one channel.
			 *
			 * @param {string} name - channel key.
			 * @param {string} label - how the channel is named.
			 * @returns {object} the card.
			 */
			const defaultsCardFor = (name, label) =>
				h(
					'div',
					{ className: 'wil_card' },
					h(
						'div',
						{ className: 'wil_row' },
						h('span', { className: 'wil_title' }, '新会话默认'),
						h('span', { className: 'wil_meta' }, `只影响以后新开的${label}会话`),
					),
					live
						? h(
							'div',
							{ className: 'wil_col' },
							defaultsGroup(label, live.channels?.[name], name, inheritedDefaults),
							h(
								'div',
								{ className: 'wil_meta' },
								'留空即继承「所有通道的兜底」。当前对话请用 /model、/effort、/permission 切换——那会立即生效，且 DSH 界面同步。',
							),
						)
						: null,
				)
			/**
			 * What one channel's delivery settings actually resolve to.
			 *
			 * The page shows the *effective* value and marks whether it is the
			 * channel's own or inherited, because a blank control with a value in
			 * force behind it is the one thing a settings page must never show.
			 */
			const channelView = (name) => {
				const own = (live && live.channels && live.channels[name]) || {}
				return {
					own,
					displayMode: own.displayMode ?? live?.displayMode ?? 'compact',
					typingIndicator: own.typingIndicator ?? live?.typingIndicator ?? true,
				}
			}
			const writeChannel = (name, patch) => changeSetting({ channels: { [name]: patch } })

			/**
			 * The reply-style card for one channel.
			 *
			 * @param {string} name - channel key.
			 * @param {string} label - how the channel is named.
			 * @returns {object} the card.
			 */
			const replySettingsCard = (name, label) => {
				const view = channelView(name)
				const inheritedMode = view.own.displayMode === undefined
				const inheritedTyping = view.own.typingIndicator === undefined
				return h(
					'div',
					{ className: 'wil_card' },
					h(
						'div',
						{ className: 'wil_row' },
						h('span', { className: 'wil_title' }, '回复设置'),
						h('span', { className: 'wil_meta' }, `改完立即生效，无需重启${label ? `（${label}）` : ''}`),
					),
					live
						? h(
							'div',
							{ className: 'wil_col' },
							h(
								'div',
								{ className: 'wil_row' },
								h('span', { className: 'wil_meta' }, '回复方式'),
								h(
									'select',
									{
										className: 'wil_select',
										value: view.displayMode,
										disabled: busy !== '',
										onChange: (event) => writeChannel(name, { displayMode: event.target.value }),
									},
									h('option', { value: 'compact' }, '逐段发送（每段回复单独一条）'),
									h('option', { value: 'quiet' }, '整轮合并（一轮只发一条）'),
									h('option', { value: '' }, `继承（当前：${view.displayMode === 'quiet' ? '整轮合并' : '逐段发送'}）`),
								),
							),
							h(
								'div',
								{ className: 'wil_row' },
								h('span', { className: 'wil_meta' }, '输入中提示'),
								h(
									'button',
									{
										type: 'button',
										className: 'wil_btn',
										disabled: busy !== '',
										onClick: () => writeChannel(name, { typingIndicator: !view.typingIndicator }),
									},
									view.typingIndicator ? '已开启' : '已关闭',
								),
								inheritedTyping
									? null
									: h(
										'button',
										{
											type: 'button',
											className: 'wil_btn',
											disabled: busy !== '',
											onClick: () => writeChannel(name, { typingIndicator: '' }),
										},
										'继承',
									),
							),
							h(
								'div',
								{ className: 'wil_meta' },
								inheritedMode
									? '两种回复方式都不发送工具调用和思考内容。当前用的是全局兜底值。'
									: '两种回复方式都不发送工具调用和思考内容。这是本通道自己的设置。',
							),
						)
						: h('div', { className: 'wil_meta' }, '桥接未运行，设置暂时改不了（需要 wechat-ilink-bridge 那一行已启动）。'),
				)
			}

			// Host diagnostics belong to the plugin, not to a channel: they say
			// which host surfaces were found and whether a closed window is still
			// holding a reply.
			const diagnosticsCard = h(
				'div',
				{ className: 'wil_card' },
				h(
					'div',
					{ className: 'wil_row' },
					h('span', { className: 'wil_title' }, '诊断'),
					h('span', { className: 'wil_meta' }, '宿主能力与未送达回复'),
				),
				compatLine,
				undeliveredLine,
			)

			// The Feishu channel: its own row, its own credentials, its own card.
			// Rendered even when the row is missing, because "the plugin row is not
			// loaded" and "no credentials yet" look identical from the outside and
			// only one of them is fixed by typing something here.
			const feishuStatus = feishu && feishu.status ? feishu.status : null
			const feishuCard = h(
				'div',
				{ className: 'wil_card' },
				h(
					'div',
					{ className: 'wil_row' },
					h('span', { className: 'wil_title' }, '飞书'),
					h(
						'span',
						{ className: 'wil_meta' },
						feishu === null
							? '读取中…'
							: feishu.mounted === false
								? '通道未加载'
								: feishuStatus && feishuStatus.connected
									? '长连接已连接'
									: feishuStatus && feishuStatus.bound
										? '已绑定，连接中'
										: '未绑定',
					),
				),
				feishu && feishu.mounted === false
					? h(
						'div',
						{ className: 'wil_err' },
						'飞书通道那一行没有加载。需要 DSH 配置里有 feishu 这一行（本插件的 cordis.patch.yml 已经带上），并重启。',
					)
					: feishuStatus && feishuStatus.bound
						? h(
							'div',
							{ className: 'wil_col' },
							h('div', { className: 'wil_meta' }, `App ID：${feishuStatus.appId}`),
							h(
								'div',
								{ className: 'wil_meta' },
								`部署：${feishuStatus.domain === 'lark' ? 'Lark（国际版）' : '飞书（中国版）'}`,
							),
							feishuStatus.lastError
								? h('div', { className: 'wil_err' }, `最近错误：${feishuStatus.lastError}`)
								: null,
							h(
								'div',
								{ className: 'wil_row' },
								h(
									'button',
									{ type: 'button', className: 'wil_btn', disabled: busy !== '', onClick: refreshFeishu },
									'刷新',
								),
								h(
									'button',
									{ type: 'button', className: 'wil_btn', disabled: busy !== '', onClick: unbindFeishu },
									'解绑',
								),
							),
						)
						: feishu && feishu.mounted
							? h(
								'div',
								{ className: 'wil_col' },
								feishuLogin
									? h(
										'div',
										{ className: 'wil_col' },
										h(
											'div',
											{ className: 'wil_meta' },
											'用飞书扫这个二维码，确认后会自动创建一个应用并完成绑定——不用去开发者后台建应用、配权限、发版本。',
										),
										feishuLogin.qrImageUrl
											? h(
												'div',
												{ className: 'wil_qr' },
												h('img', {
													src: feishuLogin.qrImageUrl,
													alt: '飞书应用一键创建二维码',
													width: 220,
													height: 220,
													// A broken QR is otherwise completely silent: the
													// image just does not appear and nothing says why.
													onError: () =>
														setBindNote({
															kind: 'err',
															text: `二维码图片加载失败：${feishuLogin.qrImageUrl}`,
														}),
												}),
											)
											: null,
										h('div', { className: 'wil_meta' }, '等待扫码确认…'),
									)
									: h(
										'div',
										{ className: 'wil_col' },
										h(
											'div',
											{ className: 'wil_meta' },
											'扫码一键创建并绑定，不需要手动去开发者后台建应用。',
										),
										h(
											'div',
											{ className: 'wil_row' },
											h(
												'button',
												{ type: 'button', className: 'wil_btn', disabled: busy !== '', onClick: beginFeishuLogin },
												busy === 'feishu' ? '正在获取二维码…' : '扫码绑定',
											),
											h(
												'button',
												{
													type: 'button',
													className: 'wil_btn',
													disabled: busy !== '',
													onClick: () => setFeishuManual((value) => !value),
												},
												feishuManual ? '收起手动填写' : '手动填写 App ID',
											),
										),
									),
								feishuManual
									? h(
										'div',
										{ className: 'wil_col' },
										h(
											'div',
											{ className: 'wil_meta' },
											'已有自建应用时可以直接填。凭据写进数据目录，不进配置文件。',
										),
										h('input', {
											className: 'wil_input',
											placeholder: 'App ID（cli_ 开头）',
											value: feishuForm.appId,
											onChange: (event) => setFeishuForm((p) => ({ ...p, appId: event.target.value })),
										}),
										h('input', {
											className: 'wil_input',
											type: 'password',
											placeholder: 'App Secret',
											value: feishuForm.appSecret,
											onChange: (event) => setFeishuForm((p) => ({ ...p, appSecret: event.target.value })),
										}),
										h(
											'select',
											{
												className: 'wil_select',
												value: feishuForm.domain,
												onChange: (event) => setFeishuForm((p) => ({ ...p, domain: event.target.value })),
											},
											h('option', { value: 'feishu' }, '飞书（open.feishu.cn）'),
											h('option', { value: 'lark' }, 'Lark 国际版（open.larksuite.com）'),
										),
										h(
											'div',
											{ className: 'wil_row' },
											h(
												'button',
												{
													type: 'button',
													className: 'wil_btn',
													disabled: busy !== '' || !feishuForm.appId || !feishuForm.appSecret,
													onClick: bindFeishu,
												},
												busy === 'feishu' ? '绑定中…' : '绑定',
											),
										),
										h('div', { className: 'wil_meta' }, '事件订阅方式选「长连接」，不需要公网回调地址。'),
									)
									: null,
							)
							: null,
				bindNote.kind === 'err' && bindNote.text ? h('div', { className: 'wil_err' }, bindNote.text) : null,
				bindNote.kind === 'ok' && bindNote.text ? h('div', { className: 'wil_meta' }, bindNote.text) : null,
			)

			/**
			 * One channel's section: everything about that channel, under one
			 * heading. The two channels are independent rows with independent
			 * credentials and independent defaults, so the page mirrors that
			 * rather than mixing them into one pile of cards.
			 *
			 * @param {string} label - how the channel is named.
			 * @param {object[]} cards - the cards belonging to it.
			 * @returns {object} the section.
			 */
			const channelSection = (label, cards) =>
				h(
					'div',
					{ className: 'wil_section' },
					h('div', { className: 'wil_section_title' }, label),
					...cards,
				)

			return h(
				'div',
				{ className: 'wil_root' },
				styleTag,
				hostMissing
					? h('div', { className: 'wil_err' }, '本插件的 Web 接口没有响应，设置页无法工作。')
					: null,
				globalDefaultsCard,
				channelSection('微信', [
					h(
						'div',
						{ className: 'wil_card' },
						h(
							'div',
							{ className: 'wil_row' },
							h('span', { className: 'wil_title' }, '状态'),
							h('span', { className: `wil_badge ${badge.cls}` }, badge.label),
							pollBadge ? h('span', { className: `wil_badge ${pollBadge.cls}` }, pollBadge.label) : null,
							h(
								'div',
								{ className: 'wil_actions' },
								h('button', { type: 'button', className: 'wil_btn', onClick: refreshStatus, disabled: busy !== '' }, '刷新'),
								bound
									? h('button', { type: 'button', className: 'wil_btn', onClick: startLogin, disabled: busy !== '' }, '重新扫码')
									: null,
								bound
									? h('button', { type: 'button', className: 'wil_btn danger', onClick: logout, disabled: busy !== '' }, busy === 'logout' ? '解绑中…' : '解绑')
									: null,
							),
						),
						text(status && status.botId) ? h('div', { className: 'wil_meta' }, `Bot ID：${status.botId}`) : null,
						text(status && status.accountId) ? h('div', { className: 'wil_meta' }, `账号：${status.accountId}`) : null,
						errorText ? h('div', { className: 'wil_err' }, `最近错误：${errorText}`) : null,
						note.text ? h('div', { className: note.kind === 'err' ? 'wil_err' : 'wil_ok' }, note.text) : null,
						!bound && !login
							? h(
								'div',
								{ className: 'wil_row' },
								h(
									'button',
									{ type: 'button', className: 'wil_btn primary', onClick: startLogin, disabled: busy !== '' },
									busy === 'begin' ? '获取二维码…' : '扫码绑定',
								),
								h('span', { className: 'wil_meta' }, '点击后用手机微信扫描二维码即可绑定。'),
							)
							: null,
					),
					login
						? h(
							'div',
							{ className: 'wil_card' },
							h(
								'div',
								{ className: 'wil_row' },
								h('span', { className: 'wil_title' }, '扫码绑定'),
								h('span', { className: `wil_badge ${loginBadgeClass(login.status)}` }, LOGIN_LABEL[login.status] || login.status),
							),
							h(
								'div',
								{ className: 'wil_qr' },
								login.qrImageUrl
									? h('img', { src: login.qrImageUrl, alt: '微信 ClawBot 绑定二维码', width: 220, height: 220 })
									: h('div', { className: 'wil_meta' }, '正在生成二维码…'),
								h(
									'div',
									{ className: 'wil_qr_side' },
									loginActive ? h('div', { className: 'wil_count' }, `剩余 ${remaining} 秒`) : null,
									h('div', { className: 'wil_meta' }, LOGIN_HINT[login.status] || ''),
									text(login.message) ? h('div', { className: 'wil_err' }, login.message) : null,
									text(login.qrUrl)
										? h('div', { className: 'wil_col' }, h('div', { className: 'wil_meta' }, '备用链接（可在微信中打开）：'), h('code', { className: 'wil_link' }, login.qrUrl))
										: null,
									h(
										'div',
										{ className: 'wil_row' },
										h('button', { type: 'button', className: 'wil_btn', onClick: () => setLogin(null), disabled: busy !== '' }, '取消'),
										login.status === 'expired' || login.status === 'error'
											? h('button', { type: 'button', className: 'wil_btn primary', onClick: startLogin, disabled: busy !== '' }, '重新获取')
											: null,
									),
								),
							),
						)
						: null,
					replySettingsCard('wechat-ilink', '微信'),
					defaultsCardFor('wechat-ilink', '微信'),
					h(
						'div',
						{ className: 'wil_card' },
						h('div', { className: 'wil_row' }, h('span', { className: 'wil_title' }, '工作区与会话')),
					h('div', { className: 'wil_sep' }),
					h(
						'div',
						{ className: 'wil_row' },
						h('span', { className: 'wil_meta' }, '工作区'),
						workspaceItems.length > 0
							? h(
								'select',
								{
									className: 'wil_select',
									value: choice.workspace,
									onChange: (event) => setChoice((previous) => ({ ...previous, workspace: event.target.value, sessionId: '' })),
								},
								h('option', { value: '' }, '（不切换）'),
								workspaceItems.map((item, index) =>
									h(
										'option',
										{ key: text(item.id) || text(item.path) || String(index), value: text(item.path) || text(item.cwd) || text(item.id) },
										text(item.name) || text(item.path) || text(item.cwd) || text(item.id) || '(未命名)',
									),
								),
							)
							: h('span', { className: 'wil_meta' }, workspaces === null ? '正在加载…' : text(workspaces.message) || '暂无工作区数据'),
					),
					h(
						'div',
						{ className: 'wil_row' },
						h('span', { className: 'wil_meta' }, '会话'),
						sessionItems.length > 0
							? h(
								'select',
								{
									className: 'wil_select',
									value: choice.sessionId,
									onChange: (event) => setChoice((previous) => ({ ...previous, sessionId: event.target.value })),
								},
								h('option', { value: '' }, '（不切换）'),
								sessionItems.map((item, index) =>
									h(
										'option',
										{ key: text(item.sessionId) || String(index), value: text(item.sessionId) },
										text(item.title) || text(item.name) || text(item.sessionId) || '(未命名会话)',
									),
								),
							)
							: h('span', { className: 'wil_meta' }, sessions === null ? '正在加载…' : text(sessions.message) || '暂无会话数据'),
					),
					h(
						'div',
						{ className: 'wil_row' },
						h('button', { type: 'button', className: 'wil_btn primary', onClick: applyBinding, disabled: busy !== '' }, busy === 'bind' ? '切换中…' : '应用绑定'),
						h(
							'button',
							{
								type: 'button',
								className: 'wil_btn',
								onClick: () => {
									refreshWorkspaces()
									refreshSessions(choice.workspace)
								},
								disabled: busy !== '',
							},
							'刷新列表',
						),
					),
					bindNote.text ? h('div', { className: bindNote.kind === 'err' ? 'wil_err' : 'wil_ok' }, bindNote.text) : null,
					h('div', { className: 'wil_meta' }, '工作区与会话的切换依赖宿主侧能力；未就绪时会显示上方提示。'),
				),
				]),
				channelSection('飞书', [
					feishuCard,
					replySettingsCard('feishu', '飞书'),
					defaultsCardFor('feishu', '飞书'),
				]),
				diagnosticsCard,
			)
		}

		/**
		 * Register the settings section.
		 *
		 * @param {object} ctx - client plugin context.
		 * @returns {void}
		 */
		function apply(ctx) {
			ctx.slots.inject(SLOT, () =>
				ctx.slots.register(
					{
						name: SLOT,
						id: SECTION_ID,
						order: 45,
						label: SECTION_LABEL,
					},
					WechatIlinkSection,
				),
			)
		}

		return { inject: ['slots'], apply }
	},
})
