/**
 * dsh-plugin-whale-overlay — client half.
 *
 * A hand-written client bundle: the web shell's module loader only understands
 * `window.__ModuleLoader__.load({ id, factory })` where `factory(require)` returns
 * the module exports (see @deepseek-ai/dsh-client-modules). The `id` must be this
 * package's name, because that name is the boot-graph row the host half of
 * client-modules resolves.
 *
 * The pet is a browser-side `shell.overlay` contribution: that slot is the
 * frame-wide overlay layer of @deepseek-ai/dsh-client-ui-layout, so the pet floats
 * over the whole app, and `overlayLayer > *` gives it pointer events without
 * stealing them for the rest of the screen (the root element is pet-sized, never
 * full-frame).
 *
 * Decoration only. It reads exactly two facts from the session — "is the agent
 * running" and "is it waiting for you" — and turns the edges of that into a spoken
 * reminder. It never sends a prompt and never talks to a model.
 */
window.__ModuleLoader__.load({
	id: 'dsh-plugin-whale-overlay',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
		const React = require('react')

		// ─────────────────────────── assets ───────────────────────────

		/** Same path the host half registers in lib/index.js. */
		const ASSET_BASE = '/dsh-plugin-whale-overlay/assets/'

		/**
		 * Both forms are square 1:1 art, which is why PET_SIZE_PX can be a constant
		 * instead of a measurement (tests/plugin-harness.js asserts squareness).
		 */
		const FORMS = {
			whale: {
				idle: 'whale_idle.gif',
				walkLeft: 'whale_walk_left.gif',
				walkRight: 'whale_walk_right.gif',
				drag: 'drag.png',
			},
			human: {
				idle: 'idle.png',
				blink: 'blink.gif',
				walkLeft: 'walk_left.gif',
				walkRight: 'walk_right.gif',
				drag: 'drag.png',
			},
		}

		const DEFAULT_FORM = 'whale'

		// ─────────────────────────── tuning ───────────────────────────

		/** Rendered edge length of the pet, in px. */
		const PET_SIZE_PX = 96
		/** Keep this much space between the pet and the window edges. */
		const EDGE_PADDING_PX = 10
		/** Idle gap before the pet first wanders off. */
		const WALK_FIRST_DELAY_MS = 7000
		const WALK_MIN_DELAY_MS = 9000
		const WALK_MAX_DELAY_MS = 20000
		/** One wandering trip: move every tick until the step budget or an edge stops it. */
		const WALK_TICK_MS = 50
		const WALK_STEP_PX = 2
		const WALK_MIN_DURATION_MS = 800
		const WALK_EXTRA_DURATION_MS = 700
		/** Pointer travel that turns a press into a drag rather than a poke. */
		const DRAG_THRESHOLD_PX = 5
		/** How long a poke phrase stays up, and how long a reminder stays up. */
		const BUBBLE_MS = 2600
		const REMINDER_BUBBLE_MS = 9000
		/** Edge talk ("要掉下去了！") is rate-limited so dragging along an edge stays quiet. */
		const EDGE_SPEAK_COOLDOWN_MS = 3000
		/** Distance from an edge that counts as "near" it. */
		const NEAR_EDGE_PX = 50

		const STORE_POSITION = 'dsh-plugin-whale-overlay:position'
		const STORE_FORM = 'dsh-plugin-whale-overlay:form'

		// ─────────────────────────── voice ───────────────────────────

		/** Local phrases only: this pet never calls a model. */
		const POKE_PHRASES = [
			'嘿嘿～在呢！🐟',
			'专心干活哦，我在这里陪着你！',
			'要喝水了！……啊，我好像不用喝呢',
			'呜哦，别戳啦！',
			'再戳喷水！',
			'嘘！我在摸鱼哦',
			'电量不足，求贴贴 ❤️',
			'滴滴！人工智障上线！',
			'一直戳的话，AI 也会害羞的',
			'你知道吗？虎鲸会咬鼠标的！',
			'蓝蓝尾巴，要扫你咯',
			'呼呼……',
			'再戳就咬你！',
		]

		/** Said when a drag drops the pet against a window edge. */
		const EDGE_PHRASES = {
			left: '🐟 要掉下去了！快拉我一把～',
			right: '🐟 右边是悬崖！危险危险～',
			top: '🐟 上面太高啦，我恐高！',
			bottom: '🐟 地板好凉，抱我上去～',
		}

		/** Said on a form switch. */
		const FORM_PHRASES = { human: '🐟 已切换为人形', whale: '🐟 已切换为鲸鱼形态' }

		/** The two things worth interrupting you for, keyed by the session's pendingInteraction. */
		const PENDING_PHRASES = {
			approval: '🐟 有人要你点头才能继续哦！',
			'plan-review': '🐟 方案在等你过目！',
			question: '🐟 有事要问你！',
		}
		const PENDING_FALLBACK_PHRASE = '🐟 有人在等你哦！'
		const DONE_PHRASE = '🐟 干完啦～'

		// ─────────────────────── pure helpers ───────────────────────
		// Kept free of React and of the DOM so tests/plugin-harness.js can exercise
		// them directly. They are also exported as `__internals` for that reason.

		/** Absolute URL of one pet asset. */
		function assetUrl(fileName) {
			return `${ASSET_BASE}${fileName}`
		}

		/** Gap before the next wandering trip. */
		function nextWalkDelay(random) {
			return WALK_MIN_DELAY_MS + random() * (WALK_MAX_DELAY_MS - WALK_MIN_DELAY_MS)
		}

		/** One step in the current direction, or the same value when the budget/edge stops the trip. */
		function clampAxis(value, min, max) {
			if (value < min) return min
			if (value > max) return max
			return value
		}

		/** Keep the pet fully on screen. */
		function clampPosition(position, viewport) {
			const maxX = Math.max(EDGE_PADDING_PX, viewport.width - PET_SIZE_PX - EDGE_PADDING_PX)
			const maxY = Math.max(EDGE_PADDING_PX, viewport.height - PET_SIZE_PX - EDGE_PADDING_PX)
			return {
				x: clampAxis(position.x, EDGE_PADDING_PX, maxX),
				y: clampAxis(position.y, EDGE_PADDING_PX, maxY),
			}
		}

		/** Where a fresh pet sits: bottom-left, above the composer. */
		function defaultPosition(viewport) {
			return clampPosition(
				{ x: EDGE_PADDING_PX + 18, y: viewport.height - PET_SIZE_PX - EDGE_PADDING_PX - 96 },
				viewport,
			)
		}

		/** Read a stored position, rejecting anything unusable instead of throwing. */
		function parseStoredPosition(raw) {
			if (typeof raw !== 'string' || raw.length === 0) return null
			let parsed
			try {
				parsed = JSON.parse(raw)
			} catch {
				return null
			}
			if (parsed === null || typeof parsed !== 'object') return null
			if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null
			return { x: parsed.x, y: parsed.y }
		}

		/** A phrase that never repeats the previous one, so poking twice reads as two moods. */
		function pickPhrase(phrases, previous, random) {
			if (phrases.length === 0) return ''
			if (phrases.length === 1) return phrases[0]
			const index = clampAxis(Math.floor(random() * phrases.length), 0, phrases.length - 1)
			const picked = phrases[index]
			return picked === previous ? phrases[(index + 1) % phrases.length] : picked
		}

		/** Which edge (if any) the pet is resting against. */
		function edgeSide(position, viewport) {
			if (position.x <= NEAR_EDGE_PX) return 'left'
			if (position.x + PET_SIZE_PX >= viewport.width - NEAR_EDGE_PX) return 'right'
			if (position.y <= NEAR_EDGE_PX) return 'top'
			if (position.y + PET_SIZE_PX >= viewport.height - NEAR_EDGE_PX) return 'bottom'
			return null
		}

		/** Keep a bubble inside the window by anchoring it to whichever side has room. */
		function bubbleAlignment(position, viewport) {
			return position.x + PET_SIZE_PX / 2 > viewport.width / 2 ? 'right' : 'left'
		}

		/** Flip the bubble below the pet when the pet is high up, so it never leaves the window. */
		function bubblePlacement(position, viewport) {
			return {
				align: bubbleAlignment(position, viewport),
				side: position.y < viewport.height * 0.28 ? 'below' : 'above',
			}
		}

		/**
		 * The whole reminder rule, as one pure state machine.
		 *
		 * `prev`/`next` are `{ sessionId, running, pending }`, where `pending` is the
		 * session's pendingInteraction (`'approval' | 'plan-review' | 'question'`) or null.
		 *
		 * - Switching sessions says nothing: the pet reads one session at a time, and
		 *   landing on an idle session after leaving a busy one is navigation, not a
		 *   finished turn.
		 * - A new pending interaction always speaks: that is the one thing the pet
		 *   exists to tell you.
		 * - Going from running to not running speaks "干完啦" — but only when nothing
		 *   is pending, because a turn that ends by asking a question has already
		 *   spoken, and two bubbles for one event is noise.
		 * @returns `{ kind: 'pending', pending }`, `{ kind: 'done' }`, or null.
		 */
		function announceFor(prev, next) {
			if (prev.sessionId !== next.sessionId) return null
			if (next.pending !== null && next.pending !== undefined && next.pending !== prev.pending) {
				return { kind: 'pending', pending: next.pending }
			}
			if (prev.running === true && next.running === false && (next.pending === null || next.pending === undefined)) {
				return { kind: 'done' }
			}
			return null
		}

		/** Reminder text for one announcement. */
		function announcementText(announcement) {
			if (announcement === null) return ''
			if (announcement.kind === 'done') return DONE_PHRASE
			return PENDING_PHRASES[announcement.pending] ?? PENDING_FALLBACK_PHRASE
		}

		// ─────────────────────────── styles ───────────────────────────
		// Scoped under a dshWhaleOverlay_ prefix and colored through theme tokens, so the pet
		// follows light/dark and never touches the product's own DOM or theme.

		const CSS = [
			'.dshWhaleOverlay_root{position:absolute;z-index:30;cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none;filter:drop-shadow(0 6px 12px rgba(0,0,0,.22))}',
			'.dshWhaleOverlay_root[data-dragging="true"]{cursor:grabbing}',
			'.dshWhaleOverlay_img{display:block;width:96px;height:96px;pointer-events:none;-webkit-user-drag:none}',
			'.dshWhaleOverlay_bubble{position:absolute;left:0;bottom:calc(100% - 8px);box-sizing:border-box;max-width:min(240px,calc(100vw - 32px));padding:7px 12px;border-radius:14px;background:var(--dsw-specific-menu,#fff);color:var(--dsw-alias-label-primary,#1e293b);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));box-shadow:var(--dsw-shadow-lv3,0 4px 12px rgba(0,0,0,.18));font-size:12px;line-height:1.45;white-space:pre-wrap;word-break:break-word;pointer-events:none;animation:dshWhaleOverlay_bubbleIn 160ms ease-out}',
			'.dshWhaleOverlay_bubble::after{content:"";position:absolute;bottom:-5px;left:18px;width:9px;height:9px;background:inherit;border-right:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));transform:rotate(45deg)}',
			'.dshWhaleOverlay_bubbleRight{left:auto;right:0}',
			'.dshWhaleOverlay_bubbleRight::after{left:auto;right:18px}',
			'.dshWhaleOverlay_bubbleBelow{bottom:auto;top:calc(100% - 8px)}',
			'.dshWhaleOverlay_bubbleBelow::after{bottom:auto;top:-5px;border:none;border-left:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12))}',
			'.dshWhaleOverlay_bubbleAlert{box-shadow:0 0 0 2px #ffaa44,0 6px 16px rgba(0,0,0,.22)}',
			'@keyframes dshWhaleOverlay_bubbleIn{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}',
			'@media (prefers-reduced-motion:reduce){.dshWhaleOverlay_bubble{animation:none}}',
		].join('')

		const STYLE_TAG_ID = 'dsh-plugin-whale-overlay/pet.css'
		if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`) === null) {
			const tag = document.createElement('style')
			tag.dataset.plugin = 'dsh-plugin-whale-overlay'
			tag.dataset.pluginCss = STYLE_TAG_ID
			tag.textContent = CSS
			document.head.appendChild(tag)
		}

		// ───────────────────────── component ─────────────────────────

		/** Stand-in when the standard kit has no session feed: keeps hook order stable. */
		const useNoSessions = () => undefined

		/** Viewport measured the way the overlay layer sees it. */
		function readViewport() {
			return {
				width: document.documentElement?.clientWidth ?? window.innerWidth,
				height: document.documentElement?.clientHeight ?? window.innerHeight,
			}
		}

		function readStored(key) {
			try {
				return window.localStorage.getItem(key)
			} catch {
				return null
			}
		}

		function writeStored(key, value) {
			try {
				window.localStorage.setItem(key, value)
			} catch {
				// A blocked localStorage must never break the pet.
			}
		}

		/** Image source for one form/action pair. */
		function imageFor(form, action) {
			const set = FORMS[form] ?? FORMS[DEFAULT_FORM]
			if (action === 'drag') return set.drag
			if (action === 'walkLeft') return set.walkLeft
			if (action === 'walkRight') return set.walkRight
			if (action === 'blink') return set.blink ?? set.idle
			return set.idle
		}

		/**
		 * The pet. One component owns three moving parts: the wandering timer, the
		 * pointer gesture (drag moves it, poke speaks), and the session reminders.
		 * Position is kept in a ref and written straight to the DOM — the wandering
		 * path runs 20 times a second and must not re-render React for every 2px.
		 */
		function Pet(props) {
			const useSessions = typeof props.useSessions === 'function' ? props.useSessions : useNoSessions

			const [form, setForm] = React.useState(() => (readStored(STORE_FORM) === 'human' ? 'human' : DEFAULT_FORM))
			const [action, setAction] = React.useState('idle')
			const [bubble, setBubble] = React.useState(null)

			const rootRef = React.useRef(null)
			const positionRef = React.useRef(null)
			const actionRef = React.useRef('idle')
			const draggingRef = React.useRef(false)
			const draggedRef = React.useRef(false)
			const lastPhraseRef = React.useRef('')
			const lastEdgeAtRef = React.useRef(0)
			const bubbleTimerRef = React.useRef(null)
			const bubbleSeqRef = React.useRef(0)
			const preloadedRef = React.useRef(new Set())

			// Two stable selections (a row object and a session id) instead of one fresh
			// object: a selector must return a reference the store can compare.
			const currentSessionId = useSessions((state) => state.current)
			const summary = useSessions((state) => (currentSessionId === undefined ? undefined : state.byId[currentSessionId]))
			const running = summary !== undefined && summary !== null && summary.running === true
			const pending = summary !== undefined && summary !== null && summary.pendingInteraction !== undefined
				? summary.pendingInteraction
				: null

			/** Action state lives in two places on purpose: React renders it, the engine reads the ref. */
			const go = React.useCallback((next) => {
				if (actionRef.current === next) return
				actionRef.current = next
				setAction(next)
			}, [])

			/** Write the pet's position straight to the DOM. */
			const place = React.useCallback((next) => {
				positionRef.current = next
				const node = rootRef.current
				if (node !== null) {
					node.style.left = `${next.x}px`
					node.style.top = `${next.y}px`
				}
			}, [])

			/** Say something. `alert` marks the two reminders with the pet's accent ring. */
			const speak = React.useCallback((text, durationMs, alert) => {
				if (text === '') return
				if (bubbleTimerRef.current !== null) {
					window.clearTimeout(bubbleTimerRef.current)
					bubbleTimerRef.current = null
				}
				const position = positionRef.current ?? defaultPosition(readViewport())
				const placement = bubblePlacement(position, readViewport())
				bubbleSeqRef.current += 1
				setBubble({ text, alert: alert === true, align: placement.align, side: placement.side, seq: bubbleSeqRef.current })
				bubbleTimerRef.current = window.setTimeout(() => {
					bubbleTimerRef.current = null
					setBubble(null)
				}, durationMs)
			}, [])

			/** A hop, so a reminder is visible even when the eyes are on the chat. */
			const hop = React.useCallback(() => {
				const node = rootRef.current
				if (node === null || typeof node.animate !== 'function') return
				node.animate(
					[
						{ transform: 'translateY(0)' },
						{ transform: 'translateY(-14px)' },
						{ transform: 'translateY(0)' },
					],
					{ duration: 420, iterations: 3, easing: 'ease-in-out' },
				)
			}, [])

			/** Warm the cache for one form so a form/action switch never shows a blank frame. */
			const preload = React.useCallback((target) => {
				const set = FORMS[target] ?? FORMS[DEFAULT_FORM]
				for (const file of Object.values(set)) {
					const url = assetUrl(file)
					if (preloadedRef.current.has(url)) continue
					preloadedRef.current.add(url)
					const image = new window.Image()
					image.src = url
				}
			}, [])

			// ── first placement, and keeping the pet on screen when the window shrinks
			React.useEffect(() => {
				const viewport = readViewport()
				const stored = parseStoredPosition(readStored(STORE_POSITION))
				place(clampPosition(stored ?? defaultPosition(viewport), viewport))
				const onResize = () => {
					const next = readViewport()
					const current = positionRef.current
					if (current === null) return
					const clamped = clampPosition(current, next)
					if (clamped.x !== current.x || clamped.y !== current.y) place(clamped)
				}
				window.addEventListener('resize', onResize)
				return () => window.removeEventListener('resize', onResize)
			}, [place])

			React.useEffect(() => {
				preload(form)
			}, [form, preload])

			// ── the wandering engine
			React.useEffect(() => {
				let scheduleTimer = null
				let moveTimer = null

				const stopTrip = () => {
					if (moveTimer !== null) {
						window.clearInterval(moveTimer)
						moveTimer = null
					}
				}
				const endTrip = () => {
					stopTrip()
					if (actionRef.current === 'walkLeft' || actionRef.current === 'walkRight') go('idle')
				}
				const speakEdge = () => {
					const now = Date.now()
					if (now - lastEdgeAtRef.current < EDGE_SPEAK_COOLDOWN_MS) return
					const position = positionRef.current
					if (position === null) return
					const side = edgeSide(position, readViewport())
					if (side === null) return
					lastEdgeAtRef.current = now
					speak(EDGE_PHRASES[side], REMINDER_BUBBLE_MS, false)
				}
				const startTrip = () => {
					if (draggingRef.current) return
					const direction = Math.random() < 0.5 ? 'left' : 'right'
					go(direction === 'left' ? 'walkLeft' : 'walkRight')
					const step = direction === 'left' ? -WALK_STEP_PX : WALK_STEP_PX
					const maxSteps = Math.round((WALK_MIN_DURATION_MS + Math.random() * WALK_EXTRA_DURATION_MS) / WALK_TICK_MS)
					let steps = 0
					stopTrip()
					moveTimer = window.setInterval(() => {
						if (draggingRef.current) {
							endTrip()
							return
						}
						const current = positionRef.current
						if (current === null) {
							endTrip()
							return
						}
						const viewport = readViewport()
						const next = clampPosition({ x: current.x + step, y: current.y }, viewport)
						if (steps >= maxSteps || next.x === current.x) {
							// Out of steps, or the window edge is already there.
							endTrip()
							if (next.x === current.x) speakEdge()
							return
						}
						place(next)
						steps += 1
					}, WALK_TICK_MS)
				}
				let firstTrip = true
				const schedule = () => {
					const delay = firstTrip ? WALK_FIRST_DELAY_MS : nextWalkDelay(Math.random)
					firstTrip = false
					scheduleTimer = window.setTimeout(() => {
						scheduleTimer = null
						startTrip()
						schedule()
					}, delay)
				}
				schedule()
				return () => {
					if (scheduleTimer !== null) window.clearTimeout(scheduleTimer)
					stopTrip()
				}
			}, [go, place, speak])

			// ── reminders: the only two things the pet reads out of the session
			const previousRef = React.useRef(null)
			React.useEffect(() => {
				const previous = previousRef.current
				previousRef.current = { sessionId: currentSessionId, running, pending }
				// The first observation only records the baseline: mounting the pet must
				// not fire a reminder about a state that was already true before it.
				if (previous === null) return
				const announcement = announceFor(previous, { sessionId: currentSessionId, running, pending })
				if (announcement === null) return
				speak(announcementText(announcement), REMINDER_BUBBLE_MS, true)
				hop()
			}, [currentSessionId, hop, pending, running, speak])

			// ── gestures
			const onPointerDown = (event) => {
				if (event.button !== 0) return
				const node = rootRef.current
				if (node === null) return
				event.preventDefault()
				// Reset here, not on a timer: the click the browser fires after a drag
				// arrives after any timer we could have set, and must still be ignored.
				draggedRef.current = false
				draggingRef.current = true
				node.dataset.dragging = 'true'
				go('drag')
				const origin = positionRef.current ?? defaultPosition(readViewport())
				const startX = event.clientX
				const startY = event.clientY
				const onMove = (moveEvent) => {
					const dx = moveEvent.clientX - startX
					const dy = moveEvent.clientY - startY
					if (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX) draggedRef.current = true
					if (!draggedRef.current) return
					place(clampPosition({ x: origin.x + dx, y: origin.y + dy }, readViewport()))
				}
				const onUp = (upEvent) => {
					// A right-click during a left-drag also ends up here; only the left
					// button release may end the gesture, or the pet sticks mid-air.
					if (upEvent !== undefined && upEvent.button !== undefined && upEvent.button !== 0) return
					window.removeEventListener('pointermove', onMove)
					window.removeEventListener('pointerup', onUp)
					draggingRef.current = false
					delete node.dataset.dragging
					go('idle')
					const position = positionRef.current
					if (position !== null) writeStored(STORE_POSITION, JSON.stringify(position))
					if (draggedRef.current) {
						const side = edgeSide(position ?? origin, readViewport())
						if (side !== null) {
							lastEdgeAtRef.current = Date.now()
							speak(EDGE_PHRASES[side], REMINDER_BUBBLE_MS, false)
						}
					}
				}
				window.addEventListener('pointermove', onMove)
				window.addEventListener('pointerup', onUp)
			}

			const onPoke = () => {
				// The click the browser appends to a drag is not a poke.
				if (draggedRef.current) {
					draggedRef.current = false
					return
				}
				const phrase = pickPhrase(POKE_PHRASES, lastPhraseRef.current, Math.random)
				lastPhraseRef.current = phrase
				speak(phrase, BUBBLE_MS, false)
				// A blink is a pose, not a state: only take it over from an idle human,
				// never mid-walk or mid-drag, and give it straight back.
				if (actionRef.current === 'idle' && form === 'human') {
					go('blink')
					window.setTimeout(() => {
						if (actionRef.current === 'blink') go('idle')
					}, 220)
				}
			}

			const onContextMenu = (event) => {
				event.preventDefault()
				event.stopPropagation()
				const next = form === 'human' ? 'whale' : 'human'
				setForm(next)
				writeStored(STORE_FORM, next)
				speak(FORM_PHRASES[next], BUBBLE_MS, false)
			}

			const bubbleClass = [
				'dshWhaleOverlay_bubble',
				bubble !== null && bubble.align === 'right' ? 'dshWhaleOverlay_bubbleRight' : '',
				bubble !== null && bubble.side === 'below' ? 'dshWhaleOverlay_bubbleBelow' : '',
				bubble !== null && bubble.alert ? 'dshWhaleOverlay_bubbleAlert' : '',
			].filter(Boolean).join(' ')

			return React.createElement(
				'div',
				{
					ref: rootRef,
					className: 'dshWhaleOverlay_root',
					onPointerDown,
					onClick: onPoke,
					onContextMenu,
					role: 'img',
					'aria-label': '小鲸鱼桌宠',
				},
				bubble === null ? null : React.createElement('div', { className: bubbleClass, key: bubble.seq }, bubble.text),
				React.createElement('img', {
					className: 'dshWhaleOverlay_img',
					src: assetUrl(imageFor(form, action)),
					alt: '',
					draggable: false,
				}),
			)
		}

		// ─────────────────────────── plugin ───────────────────────────

		/** Hard dependencies: without the slot registry there is no pet, without sessions there are no reminders. */
		const inject = ['slots', 'sessions']

		/**
		 * Client plugin body: put the pet in the frame-wide overlay layer.
		 * `shell.overlay` is a `list` slot at root scope (declared by ui-layout), which
		 * hands every occupant the root standard kit — including `useSessions`.
		 */
		function apply(ctx) {
			ctx.slots.inject('shell.overlay', () => ctx.slots.register({
				name: 'shell.overlay',
				id: 'pet',
				order: 50,
			}, Pet))
		}

		exports.apply = apply
		exports.inject = inject
		/**
		 * Pure helpers, exposed for tests/plugin-harness.js. The module loader only
		 * reads `apply`/`inject` off these exports, so this stays inert at runtime.
		 */
		exports.__internals = {
			ASSET_BASE,
			CSS,
			BUBBLE_MS,
			EDGE_PADDING_PX,
			WALK_FIRST_DELAY_MS,
			WALK_MAX_DELAY_MS,
			WALK_MIN_DELAY_MS,
			FORMS,
			PET_SIZE_PX,
			POKE_PHRASES,
			REMINDER_BUBBLE_MS,
			STORE_FORM,
			STORE_POSITION,
			announceFor,
			announcementText,
			assetUrl,
			bubblePlacement,
			clampPosition,
			defaultPosition,
			edgeSide,
			imageFor,
			nextWalkDelay,
			parseStoredPosition,
			pickPhrase,
		}
		return module.exports
	},
})
