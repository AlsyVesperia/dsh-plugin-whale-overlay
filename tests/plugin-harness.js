/**
 * dsh-plugin-whale-overlay offline self-check.
 *
 * The pet only ever runs inside the DSH web shell, which means there is no way to
 * "just try it" from a terminal: the client bundle is fetched by a module loader
 * that only exists in the browser, and its slot only exists once the app frame is
 * mounted. So this harness supplies the smallest honest version of that
 * environment and drives the real bundle:
 *
 *   - a `window.__ModuleLoader__` that captures the registration exactly like the
 *     product's loader does (and never executes the factory early, because the real
 *     one is lazy);
 *   - a miniature React (useState/useRef/useCallback/useEffect) with the same
 *     render-then-run-effects ordering, so the component is genuinely executed;
 *   - a controllable clock, so the pet's wandering and its reminder timing are
 *     deterministic instead of "wait 7 seconds and hope";
 *   - a fake `window`/`document`/`localStorage`/`Image`, with recorded listeners.
 *
 * The host half is exercised for real: `apply()` is called with a stub context and
 * the resulting route handler is fed synthetic requests.
 *
 * Run: node tests/plugin-harness.js
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const results = []
const check = (name, ok, extra) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra === undefined ? '' : `  → ${extra}`}`)

const readText = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8')
const readJson = (...parts) => JSON.parse(readText(...parts))

// ───────────────────────────── fake clock ─────────────────────────────

/**
 * One virtual clock drives `setTimeout`/`setInterval` and `Date.now`, so a test can
 * advance time instead of sleeping.
 */
function createClock() {
  let nextId = 1
  let now = 1_700_000_000_000
  let tasks = []
  return {
    get now() {
      return now
    },
    setTimeout(fn, delay) {
      const id = nextId++
      tasks.push({ id, fn, at: now + Math.max(0, delay ?? 0), interval: null })
      return id
    },
    setInterval(fn, delay) {
      const id = nextId++
      const period = Math.max(1, delay ?? 1)
      tasks.push({ id, fn, at: now + period, interval: period })
      return id
    },
    clear(id) {
      tasks = tasks.filter((task) => task.id !== id)
    },
    /** Run every task due within `ms`, in time order. */
    advance(ms) {
      const target = now + ms
      for (;;) {
        const due = tasks.filter((task) => task.at <= target).sort((a, b) => a.at - b.at)[0]
        if (due === undefined) break
        now = due.at
        if (due.interval === null) tasks = tasks.filter((task) => task.id !== due.id)
        else due.at = now + due.interval
        due.fn()
      }
      now = target
    },
    get pending() {
      return tasks.length
    },
  }
}

// ───────────────────────── fake DOM and window ─────────────────────────

/** The pet's root node: only the surface the component actually touches. */
function makeNode(element) {
  return {
    className: element.props.className,
    style: {},
    dataset: {},
    animateCalls: [],
    animate(...args) {
      this.animateCalls.push(args)
      return { cancel() {} }
    },
  }
}

/** Record every element with a `ref` prop the way React would attach it. */
function attachRefs(tree, created) {
  if (tree === null || typeof tree !== 'object') return
  const ref = tree.props?.ref
  if (ref !== undefined && ref !== null && typeof ref === 'object') {
    if (ref.current === null || ref.current === undefined) {
      const node = makeNode(tree)
      ref.current = node
      created.push(node)
    }
  }
  for (const child of tree.props?.children ?? []) attachRefs(child, created)
}

function createSandbox() {
  const listeners = new Map()
  const storage = new Map()
  const styleTags = []
  const images = []
  const clock = createClock()

  const window = {
    innerWidth: 1280,
    innerHeight: 800,
    Image: function Image() {
      const image = { src: '' }
      images.push(image)
      return image
    },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(fn)
    },
    removeEventListener: (type, fn) => {
      const list = listeners.get(type)
      if (list === undefined) return
      listeners.set(type, list.filter((entry) => entry !== fn))
    },
    setTimeout: (fn, delay) => clock.setTimeout(fn, delay),
    setInterval: (fn, delay) => clock.setInterval(fn, delay),
    clearTimeout: (id) => clock.clear(id),
    clearInterval: (id) => clock.clear(id),
  }
  window.window = window

  const document = {
    documentElement: { clientWidth: 1280, clientHeight: 800 },
    head: { appendChild: (tag) => styleTags.push(tag) },
    createElement: (tag) => ({ tag, dataset: {}, textContent: '' }),
    querySelector: () => null,
  }

  const registrations = []
  window.__ModuleLoader__ = {
    load: (registration) => registrations.push(registration),
  }

  const sandbox = {
    window,
    document,
    Math,
    Date,
    JSON,
    console,
    __clock: clock,
    __listeners: listeners,
    __storage: storage,
    __styleTags: styleTags,
    __images: images,
    __registrations: registrations,
  }
  return sandbox
}

// ──────────────────────── miniature React ────────────────────────

/**
 * Enough of React to run one function component: hooks keyed by call order, effects
 * run after the render pass with shallow dep comparison, and `setState` marking the
 * tree dirty so the driver re-renders (exactly like a real render loop, bounded).
 */
function createReact() {
  const hooks = []
  let cursor = 0
  let scheduled = []
  let dirty = false

  const React = {
    createElement(type, props, ...children) {
      const kids = children.flat().filter((child) => child !== null && child !== undefined && child !== false)
      return { type, props: { ...(props ?? {}), children: kids } }
    },
    useState(initial) {
      const index = cursor++
      if (hooks.length <= index) hooks[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
      const slot = hooks[index]
      return [
        slot.value,
        (next) => {
          const value = typeof next === 'function' ? next(slot.value) : next
          if (Object.is(value, slot.value)) return
          slot.value = value
          dirty = true
        },
      ]
    },
    useRef(initial) {
      const index = cursor++
      if (hooks.length <= index) hooks[index] = { kind: 'ref', value: { current: initial } }
      return hooks[index].value
    },
    useCallback(fn, deps) {
      const index = cursor++
      const slot = hooks[index]
      if (slot === undefined || slot.kind !== 'memo' || !sameDeps(slot.deps, deps)) {
        hooks[index] = { kind: 'memo', value: fn, deps }
      }
      return hooks[index].value
    },
    useEffect(fn, deps) {
      const index = cursor++
      scheduled.push({ index, fn, deps })
    },
  }

  function sameDeps(a, b) {
    if (a === undefined || b === undefined) return false
    if (a.length !== b.length) return false
    return a.every((value, index) => Object.is(value, b[index]))
  }

  /** One render pass: reset the cursor, run the component, attach refs, settle effects. */
  function render(component, props) {
    let tree = null
    const created = []
    for (let pass = 0; pass < 25; pass += 1) {
      dirty = false
      cursor = 0
      scheduled = []
      tree = component(props)
      // React attaches refs before effects run, and the placement effect writes
      // straight to the node — so this order is load-bearing, not cosmetic.
      attachRefs(tree, created)
      const pending = scheduled
      scheduled = []
      for (const effect of pending) {
        const previous = hooks[effect.index]
        if (previous !== undefined && previous.kind === 'effect' && sameDeps(previous.deps, effect.deps)) continue
        if (previous?.cleanup !== undefined) previous.cleanup()
        const cleanup = effect.fn()
        hooks[effect.index] = { kind: 'effect', deps: effect.deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
      }
      if (!dirty) break
    }
    return { tree, nodes: created, isDirty: () => dirty }
  }

  function unmount() {
    for (const hook of hooks) if (hook?.cleanup !== undefined) hook.cleanup()
  }

  return { React, render, unmount }
}

/** Find the first element of one type in a rendered tree. */
function findElement(tree, type) {
  if (tree === null || typeof tree !== 'object') return null
  if (tree.type === type) return tree
  for (const child of tree.props?.children ?? []) {
    const found = findElement(child, type)
    if (found !== null) return found
  }
  return null
}

/** Every element of one type in a rendered tree. */
function findElements(tree, type, out = []) {
  if (tree === null || typeof tree !== 'object') return out
  if (tree.type === type) out.push(tree)
  for (const child of tree.props?.children ?? []) findElements(child, type, out)
  return out
}

// ─────────────────────────── client half ───────────────────────────

const clientSource = readText('lib', 'client.js')

/** The only specifiers a client bundle may pull from the module table in this plugin. */
const ALLOWED_REQUIRES = ['react', 'react/jsx-runtime']

/**
 * Load the bundle the way the shell's module table does: register, then materialize.
 * `require` is recorded rather than answered deeply — materialization only binds
 * `react` to a local; the hooks are exercised by mountPet() below.
 */
function materialize(sandbox) {
  const context = createContext(sandbox)
  runInContext(clientSource, context, { filename: 'lib/client.js' })
  const registrations = sandbox.__registrations
  if (registrations.length !== 1) throw new Error(`expected one module registration, got ${registrations.length}`)
  const registration = registrations[0]
  const required = []
  const module = registration.factory((specifier) => {
    required.push(specifier)
    if (ALLOWED_REQUIRES.includes(specifier)) return {}
    throw new Error(`unexpected require("${specifier}") — the bundle must be self-contained`)
  })
  return { registration, exports: module, required }
}

/** Materialize with a React stub installed, and capture the component apply() registers. */
function mountPet(sandbox, sessionState, hooks = {}) {
  const { React, render, unmount } = createReact()
  const context = createContext(sandbox)
  runInContext(clientSource, context, { filename: 'lib/client.js' })
  const registration = sandbox.__registrations[0]
  const exported = registration.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require("${specifier}")`)
  })
  const registered = []
  const injected = []
  exported.apply({
    slots: {
      inject: (name, callback) => {
        injected.push(name)
        callback()
      },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
  })
  // The real renderer hands out a selector hook over the session list store. A
  // missing feed is modelled the way the product does it: the hook exists and
  // returns undefined without ever calling the selector.
  const props = {
    useSessions: hooks.useSessions ?? ((selector) => selector(sessionState.current)),
  }
  const first = render(registered[0].component, props)
  return {
    component: registered[0].component,
    options: registered[0].options,
    injected,
    props,
    render: () => render(registered[0].component, props),
    unmount,
    first,
  }
}

/** Session list state shaped like the real SessionListState. */
function sessionStateOf(patch = {}) {
  return {
    current: 'session-1',
    byId: { 'session-1': { sessionId: 'session-1', running: false, ...patch } },
  }
}

/** Flatten an element's children into its visible text (createElement collects children into an array). */
function textOf(element) {
  if (element === null || element === undefined) return ''
  return (element.props?.children ?? []).map((child) => (typeof child === 'string' ? child : textOf(child))).join('')
}

const bubbleOf = (tree) => findElements(tree, 'div').find((element) => element.props.className?.includes('dshWhaleOverlay_bubble')) ?? null
const bubbleText = (tree) => textOf(bubbleOf(tree))
const imageOf = (tree) => findElement(tree, 'img')

// ─────────────────────────── structural ───────────────────────────

const pkg = readJson('package.json')
const host = await import(new URL('../lib/index.js', import.meta.url).href)

const structureSandbox = createSandbox()
const structure = materialize(structureSandbox)

check('client bundle registers exactly once through window.__ModuleLoader__', structureSandbox.__registrations.length === 1)
check('module id equals the package name', structure.registration.id === pkg.name, `${structure.registration.id} vs ${pkg.name}`)
check('package declares dsh.client.platform = web', pkg.dsh?.client?.platform === 'web')
check('package declares exports["./client"]', typeof pkg.exports?.['./client']?.default === 'string', pkg.exports?.['./client']?.default)
check('the declared client export is the file we shipped', pkg.exports?.['./client']?.default === './lib/client.js')
check('exports["./client"] target exists on disk', statSync(join(ROOT, pkg.exports['./client'].default)).isFile())
check('main entry exists on disk', statSync(join(ROOT, pkg.main)).isFile())
check('package is private (never published by accident)', pkg.private === true)
// The project name is one name: the folder it lives in, the package, the module id
// the shell registers, and the asset route all have to agree. `includes` rather than
// equality so an unpacked download (`dsh-plugin-whale-overlay-main`) still passes.
check('the folder is named after the package', basename(ROOT).includes(pkg.name), `${basename(ROOT)} vs ${pkg.name}`)
check('the client module id equals the package name', structure.registration.id === pkg.name, `${structure.registration.id} vs ${pkg.name}`)
check('the host plugin name equals the package name', host.name === pkg.name, `${host.name} vs ${pkg.name}`)
check('the asset route is namespaced by the package name', host.ROUTE_PATH === `/${pkg.name}/assets`, host.ROUTE_PATH)

// Renaming the project touches a class namespace that lives in two places at once:
// the strings the component renders and the selectors in the stylesheet. A rename
// that misses one of them still mounts, but the pet loses its positioning and the
// bubble stops animating — invisible to a DOM-only check, so assert the pairing.
const cssText = structure.exports.__internals.CSS   // internals is bound further down
const styledClasses = [
  'dshWhaleOverlay_root',
  'dshWhaleOverlay_img',
  'dshWhaleOverlay_bubble',
  'dshWhaleOverlay_bubbleRight',
  'dshWhaleOverlay_bubbleBelow',
  'dshWhaleOverlay_bubbleAlert',
]
// Match a real selector boundary, not a substring: `.x_bubbleAlert` is present in
// `.x_bubbleAlertTYPO` too, and a plain includes() would happily accept a typo.
const stylesSelector = (name) => new RegExp(`\\.${name}(?![\\w-])`).test(cssText)
const unstyled = styledClasses.filter((name) => !stylesSelector(name))
check('the stylesheet styles every class the component renders', unstyled.length === 0, unstyled.length === 0 ? undefined : unstyled.join(', '))
const keyframeNames = [...cssText.matchAll(/@keyframes\s+([\w-]+)/g)].map((match) => match[1])
const animatedNames = [...cssText.matchAll(/animation:\s*([\w-]+)/g)].map((match) => match[1]).filter((name) => name !== 'none')
check('every animation the stylesheet plays is defined in it', animatedNames.length > 0 && animatedNames.every((name) => keyframeNames.includes(name)), `${animatedNames.join(',')} ⊆ ${keyframeNames.join(',')}`)
check('dsh.client.inject lists only string package ids', Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.every((id) => typeof id === 'string'))
check('host half exports name/apply/inject', host.name === pkg.name && typeof host.apply === 'function' && Array.isArray(host.inject))
check('host half injects webServer (no webserver, no images)', host.inject.includes('webServer'))
check('client half injects slots and sessions', JSON.stringify(structure.exports.inject) === JSON.stringify(['slots', 'sessions']))
check('client half exports apply as a function', typeof structure.exports.apply === 'function')
check('client bundle requires nothing beyond the platform seed words', structure.required.every((specifier) => ALLOWED_REQUIRES.includes(specifier)), structure.required.join(', '))
check('client bundle does require React (it renders through createElement)', structure.required.includes('react'))

const internals = structure.exports.__internals
check('client half exposes its pure helpers for this harness', internals !== undefined && typeof internals.announceFor === 'function')
check('lazy factory: nothing registered a slot before apply()', structureSandbox.__registrations.length === 1)

const assets = readdirSync(join(ROOT, 'assets'))
const referenced = new Set()
for (const form of Object.values(internals.FORMS)) for (const file of Object.values(form)) referenced.add(file)
check('every referenced asset exists', [...referenced].every((file) => assets.includes(file)), [...referenced].filter((file) => !assets.includes(file)).join(', '))
check('no unreferenced asset is shipped', assets.every((file) => referenced.has(file)), assets.filter((file) => !referenced.has(file)).join(', '))
check('client asset base matches the host route prefix', internals.ASSET_BASE === `${host.ROUTE_PATH}/`, `${internals.ASSET_BASE} vs ${host.ROUTE_PATH}/`)
check('asset requests stay under the route prefix', internals.assetUrl('whale_idle.gif').startsWith(host.ROUTE_PATH))

/** Square art is what lets PET_SIZE_PX be one constant for both axes. */
function imageSize(file) {
  const bytes = readFileSync(join(ROOT, 'assets', file))
  if (bytes.subarray(0, 3).toString('latin1') === 'GIF') return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
  if (bytes.subarray(1, 4).toString('latin1') === 'PNG') return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  return null
}
const sizes = assets.map((file) => [file, imageSize(file)])
check('every asset is a readable GIF/PNG', sizes.every(([, size]) => size !== null), sizes.filter(([, size]) => size === null).map(([file]) => file).join(', '))
check('every asset is square (PET_SIZE_PX applies to both axes)', sizes.every(([, size]) => size.width === size.height), sizes.filter(([, size]) => size.width !== size.height).map(([file]) => `${file} ${size.width}x${size.height}`).join(', '))
check('pet size is a positive number', Number.isFinite(internals.PET_SIZE_PX) && internals.PET_SIZE_PX > 0, internals.PET_SIZE_PX)

// ─────────────────────────── pure helpers ───────────────────────────

const viewport = { width: 1280, height: 800 }

check('assetUrl joins base and file', internals.assetUrl('drag.png') === '/dsh-plugin-whale-overlay/assets/drag.png', internals.assetUrl('drag.png'))
check('walk delay stays inside its window', internals.nextWalkDelay(() => 0) === internals.WALK_MIN_DELAY_MS && internals.nextWalkDelay(() => 1) === internals.WALK_MAX_DELAY_MS, `${internals.nextWalkDelay(() => 0)}..${internals.nextWalkDelay(() => 1)}`)
check('walk delay is finite for a constant random', Number.isFinite(internals.nextWalkDelay(() => 0.5)))

const clamped = internals.clampPosition({ x: -500, y: -500 }, viewport)
check('clampPosition pins a pet pushed off the top-left', clamped.x === internals.EDGE_PADDING_PX && clamped.y === internals.EDGE_PADDING_PX, JSON.stringify(clamped))
const clampedFar = internals.clampPosition({ x: 99999, y: 99999 }, viewport)
check(
  'clampPosition pins a pet pushed off the bottom-right',
  clampedFar.x === viewport.width - internals.PET_SIZE_PX - internals.EDGE_PADDING_PX
    && clampedFar.y === viewport.height - internals.PET_SIZE_PX - internals.EDGE_PADDING_PX,
  JSON.stringify(clampedFar),
)
const tiny = internals.clampPosition({ x: 40, y: 40 }, { width: 60, height: 60 })
check('clampPosition survives a viewport smaller than the pet', Number.isFinite(tiny.x) && Number.isFinite(tiny.y) && tiny.x >= internals.EDGE_PADDING_PX, JSON.stringify(tiny))
const fallback = internals.defaultPosition(viewport)
check('defaultPosition starts on screen', fallback.x >= 0 && fallback.y >= 0 && fallback.x + internals.PET_SIZE_PX <= viewport.width && fallback.y + internals.PET_SIZE_PX <= viewport.height, JSON.stringify(fallback))
check('the default position is not already clamped against an edge', (() => { const again = internals.clampPosition(fallback, viewport); return again.x === fallback.x && again.y === fallback.y })(), JSON.stringify(fallback))

check('parseStoredPosition accepts a stored point', JSON.stringify(internals.parseStoredPosition('{"x":12,"y":34}')) === '{"x":12,"y":34}')
check('parseStoredPosition rejects junk instead of throwing', internals.parseStoredPosition('{oops') === null && internals.parseStoredPosition('42') === null && internals.parseStoredPosition(null) === null)
check('parseStoredPosition rejects non-finite coordinates', internals.parseStoredPosition('{"x":null,"y":3}') === null && internals.parseStoredPosition('{"x":1}') === null)

const phraseA = internals.pickPhrase(internals.POKE_PHRASES, '', () => 0)
const phraseB = internals.pickPhrase(internals.POKE_PHRASES, phraseA, () => 0)
check('pickPhrase never repeats the previous phrase', phraseA !== phraseB, `${phraseA} / ${phraseB}`)
check('pickPhrase always returns a real phrase', [0, 0.25, 0.5, 0.75, 0.999].every((r) => internals.POKE_PHRASES.includes(internals.pickPhrase(internals.POKE_PHRASES, '', () => r))))
check('pickPhrase handles a one-phrase list', internals.pickPhrase(['only'], 'only', () => 0.9) === 'only')
check('pickPhrase handles an empty list', internals.pickPhrase([], 'x', () => 0) === '')

check('edgeSide detects the left edge', internals.edgeSide({ x: 0, y: 400 }, viewport) === 'left')
check('edgeSide detects the right edge', internals.edgeSide({ x: viewport.width - internals.PET_SIZE_PX, y: 400 }, viewport) === 'right')
check('edgeSide detects the top edge', internals.edgeSide({ x: 400, y: 0 }, viewport) === 'top')
check('edgeSide detects the bottom edge', internals.edgeSide({ x: 400, y: viewport.height - internals.PET_SIZE_PX }, viewport) === 'bottom')
check('edgeSide stays quiet in the middle', internals.edgeSide({ x: 400, y: 400 }, viewport) === null)

check('bubble aligns left for a pet on the left half', internals.bubblePlacement({ x: 20, y: 400 }, viewport).align === 'left')
check('bubble aligns right for a pet on the right half', internals.bubblePlacement({ x: viewport.width - 120, y: 400 }, viewport).align === 'right')
check('bubble flips below for a pet near the top', internals.bubblePlacement({ x: 400, y: 10 }, viewport).side === 'below')
check('bubble stays above for a low pet', internals.bubblePlacement({ x: 400, y: 700 }, viewport).side === 'above')

check('imageFor maps every whale action', internals.imageFor('whale', 'idle').endsWith('whale_idle.gif') && internals.imageFor('whale', 'walkLeft').endsWith('whale_walk_left.gif') && internals.imageFor('whale', 'walkRight').endsWith('whale_walk_right.gif') && internals.imageFor('whale', 'drag').endsWith('drag.png'))
check('imageFor maps human actions', internals.imageFor('human', 'idle').endsWith('idle.png') && internals.imageFor('human', 'blink').endsWith('blink.gif'))
check('whale has no blink art and falls back to idle', internals.imageFor('whale', 'blink').endsWith('whale_idle.gif'))
check('imageFor is total for unknown input', typeof internals.imageFor('nope', 'nope') === 'string')
check('both forms share one drag image', internals.imageFor('human', 'drag') === internals.imageFor('whale', 'drag'))

check('a new pending interaction speaks', internals.announceFor({ running: true, pending: null }, { running: true, pending: 'question' })?.kind === 'pending')
check('a finished turn speaks', internals.announceFor({ running: true, pending: null }, { running: false, pending: null })?.kind === 'done')
check('an idle-to-idle re-render stays silent', internals.announceFor({ running: false, pending: null }, { running: false, pending: null }) === null)
check('starting a turn stays silent', internals.announceFor({ running: false, pending: null }, { running: true, pending: null }) === null)
check('a turn that ends by asking speaks only once', internals.announceFor({ running: true, pending: null }, { running: false, pending: 'question' })?.kind === 'pending')
check('the same pending interaction does not re-announce', internals.announceFor({ running: false, pending: 'question' }, { running: false, pending: 'question' }) === null)
check('a different pending interaction announces again', internals.announceFor({ running: false, pending: 'question' }, { running: false, pending: 'approval' })?.kind === 'pending')
check('switching sessions is not a finished turn', internals.announceFor({ sessionId: 'a', running: true, pending: null }, { sessionId: 'b', running: false, pending: null }) === null)
check('switching sessions is not a new question either', internals.announceFor({ sessionId: 'a', running: false, pending: null }, { sessionId: 'b', running: false, pending: 'question' }) === null)
check('the done phrase is used for a finished turn', internals.announcementText({ kind: 'done' }) === '🐟 干完啦～')
check('each pending kind has its own phrase', internals.announcementText({ kind: 'pending', pending: 'approval' }) !== internals.announcementText({ kind: 'pending', pending: 'question' }))
check('an unknown pending kind still gets a phrase', internals.announcementText({ kind: 'pending', pending: 'made-up' }).length > 0)
check('no announcement means no text', internals.announcementText(null) === '')

// ─────────────────────────── host half ───────────────────────────

const requests = []
const disposers = []
const routeContext = {
  effect: (factory, label) => {
    requests.push({ label })
    const disposer = factory()
    disposers.push(disposer)
  },
  webServer: {
    register: (route) => {
      requests.push(route)
      return () => requests.push({ removed: route.path })
    },
  },
}
host.apply(routeContext)
const route = requests.find((entry) => entry.kind !== undefined)
check('host apply registers exactly one route', requests.filter((entry) => entry.kind !== undefined).length === 1)
check('the route is a prefix route', route.kind === 'prefix', route.kind)
check('the route path matches the client asset base', route.path === host.ROUTE_PATH)
check('the route handler is callable', typeof route.handler === 'function')
check('host disposer is handed to ctx.effect', disposers.length === 1 && typeof disposers[0] === 'function')

/**
 * Minimal node:http response. The handler pipes a real file stream into it, so this
 * stands in as a Writable: it collects chunks and resolves `finished` on end.
 */
function fakeResponse() {
  let settle
  const finished = new Promise((resolve) => {
    settle = resolve
  })
  const response = {
    status: null,
    headers: null,
    ended: false,
    destroyed: false,
    chunks: [],
    finished,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? null
      return this
    },
    write(chunk) {
      if (chunk !== undefined && chunk !== null) this.chunks.push(Buffer.from(chunk))
      return true
    },
    end(body) {
      if (body !== undefined && body !== null) this.chunks.push(Buffer.from(body))
      this.ended = true
      settle()
      return this
    },
    destroy() {
      this.destroyed = true
      settle()
    },
    on() {
      return this
    },
    once() {
      return this
    },
    emit() {
      return true
    },
    get body() {
      return this.chunks.length === 0 ? null : Buffer.concat(this.chunks)
    },
  }
  return response
}

async function requestAsset(path, method = 'GET') {
  const response = fakeResponse()
  await route.handler({ method, url: path }, response)
  await response.finished
  return response
}

const gifSize = statSync(join(ROOT, 'assets', 'whale_idle.gif')).size
const gifResponse = await requestAsset('/dsh-plugin-whale-overlay/assets/whale_idle.gif')
check('GET asset returns 200', gifResponse.status === 200, String(gifResponse.status))
check('GET asset sets the GIF content type', gifResponse.headers?.['content-type'] === 'image/gif', gifResponse.headers?.['content-type'])
check('GET asset announces the real byte length', gifResponse.headers?.['content-length'] === String(gifSize), `${gifResponse.headers?.['content-length']} vs ${gifSize}`)
const gifBytes = gifResponse.body
check('GET asset streams the file bytes', gifBytes !== null && gifBytes.length === gifSize && gifBytes.subarray(0, 3).toString('latin1') === 'GIF', String(gifBytes?.length))

const pngResponse = await requestAsset('/dsh-plugin-whale-overlay/assets/drag.png')
check('PNG assets are served with a PNG type', pngResponse.status === 200 && pngResponse.headers?.['content-type'] === 'image/png')

const headResponse = await requestAsset('/dsh-plugin-whale-overlay/assets/whale_idle.gif', 'HEAD')
check('HEAD returns headers without a body', headResponse.status === 200 && headResponse.body === null)

const postResponse = await requestAsset('/dsh-plugin-whale-overlay/assets/whale_idle.gif', 'POST')
check('POST is refused', postResponse.status === 405, String(postResponse.status))

const outsideResponse = await requestAsset('/dsh-plugin-whale-overlay/assets/package.json')
check('a non-image extension is refused', outsideResponse.status === 404, String(outsideResponse.status))

const traversalResponse = await requestAsset('/dsh-plugin-whale-overlay/assets/%2e%2e%2fpackage.json')
check('an encoded traversal is refused', traversalResponse.status === 404, String(traversalResponse.status))

// Aimed at a file that really exists just outside assets/, so this test cannot pass
// merely because the target is missing: without the containment check the handler
// would happily stream the fixture.
const traversalPngResponse = await requestAsset('/dsh-plugin-whale-overlay/assets/%2e%2e%2ftests%2ffixtures%2foutside-asset.png')
check('traversal that resolves to an existing image outside assets/ is refused', traversalPngResponse.status === 404, String(traversalPngResponse.status))
check('the traversal target really does exist (so the check above means something)', statSync(join(ROOT, 'tests', 'fixtures', 'outside-asset.png')).isFile())

const traversalMissingResponse = await requestAsset('/dsh-plugin-whale-overlay/assets/..%2f..%2fpackage.png')
check('traversal aimed outside the package is refused too', traversalMissingResponse.status === 404, String(traversalMissingResponse.status))

const missingResponse = await requestAsset('/dsh-plugin-whale-overlay/assets/nope.gif')
check('a missing asset is a 404', missingResponse.status === 404, String(missingResponse.status))

const malformedResponse = await requestAsset('/dsh-plugin-whale-overlay/assets/%zz.gif')
check('a malformed escape is a 400', malformedResponse.status === 400, String(malformedResponse.status))

const emptyResponse = await requestAsset('/dsh-plugin-whale-overlay/assets/')
check('the bare prefix is a 404', emptyResponse.status === 404, String(emptyResponse.status))

const nestedResponse = await requestAsset('/dsh-plugin-whale-overlay/assets/../assets/whale_idle.gif')
check('a path that resolves back inside is served', nestedResponse.status === 200, String(nestedResponse.status))

disposers[0]()
check('the disposer removes the route', requests.some((entry) => entry.removed === host.ROUTE_PATH))

// ─────────────────────── component: mount and gestures ───────────────────────

function scene(options = {}) {
  const sandbox = createSandbox()
  // A pinned Math.random is what makes the wandering engine testable: direction and
  // step budget both come from it, and other realms must keep the real Math.
  if (options.random !== undefined) {
    const pinned = Object.create(Math)
    pinned.random = () => options.random
    sandbox.Math = pinned
  }
  const state = { current: options.session ?? sessionStateOf() }
  if (options.storage?.position !== undefined) sandbox.__storage.set(internals.STORE_POSITION, options.storage.position)
  if (options.storage?.form !== undefined) sandbox.__storage.set(internals.STORE_FORM, options.storage.form)
  const pet = mountPet(sandbox, state)
  const advance = (ms) => {
    // A non-finite jump used to silently stop every timer and let tests pass by
    // doing nothing, so refuse it loudly.
    if (!Number.isFinite(ms)) throw new Error(`advance() needs a finite duration, got ${ms}`)
    sandbox.__clock.advance(ms)
    pet.render()
  }
  const fire = (type, event) => {
    for (const listener of [...(sandbox.__listeners.get(type) ?? [])]) listener(event)
  }
  return { sandbox, state, ...pet, advance, fire }
}

const pokeEvent = { button: 0, clientX: 100, clientY: 100, preventDefault() {}, stopPropagation() {} }

const mountScene = scene()
check('the pet registers into shell.overlay', mountScene.options.name === 'shell.overlay', mountScene.options.name)
check('the pet declares an id of its own', mountScene.options.id === 'pet', mountScene.options.id)
check('the pet waits for the slot declaration through slots.inject', mountScene.injected.includes('shell.overlay'))
check('the pet renders an image from the host asset route', imageOf(mountScene.first.tree)?.props.src === '/dsh-plugin-whale-overlay/assets/whale_idle.gif', imageOf(mountScene.first.tree)?.props.src)
check('a fresh pet shows no bubble', bubbleOf(mountScene.first.tree) === null)
check('the pet root is a pointer target with a grab cursor', mountScene.first.tree.props.className === 'dshWhaleOverlay_root' && mountScene.first.tree.props.onPointerDown !== undefined)
check('the pet root is attached to a real node', mountScene.first.nodes.length === 1)
check('the pet starts bottom-left inside the viewport', (() => {
  const node = mountScene.first.nodes[0]
  const x = Number.parseFloat(node.style.left)
  const y = Number.parseFloat(node.style.top)
  return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x + internals.PET_SIZE_PX <= 1280 && y + internals.PET_SIZE_PX <= 800
})(), JSON.stringify(mountScene.first.nodes[0].style))
check('mounting preloads the current form art', mountScene.sandbox.__images.length === Object.keys(internals.FORMS.whale).length, String(mountScene.sandbox.__images.length))

// ── poke
mountScene.first.tree.props.onClick()
const pokeTree = mountScene.render().tree
const pokeBubble = bubbleOf(pokeTree)
check('a poke makes the pet speak', internals.POKE_PHRASES.includes(textOf(pokeBubble)), textOf(pokeBubble))
check('a poke bubble is not an alert', pokeBubble.props.className.includes('dshWhaleOverlay_bubbleAlert') === false)
const firstPhrase = textOf(pokeBubble)
pokeTree.props.onClick()
const secondPhrase = bubbleText(mountScene.render().tree)
check('two pokes in a row say different things', firstPhrase !== secondPhrase, `${firstPhrase} / ${secondPhrase}`)

// ── bubble expiry
const bubbleScene = scene()
bubbleScene.first.tree.props.onClick()
check('the poke bubble is up', bubbleOf(bubbleScene.render().tree) !== null)
bubbleScene.advance(internals.BUBBLE_MS + 10)
check('the poke bubble clears itself', bubbleOf(bubbleScene.render().tree) === null)

// ── form switch
const formScene = scene()
formScene.first.tree.props.onContextMenu({ preventDefault() {}, stopPropagation() {} })
const humanTree = formScene.render().tree
check('right-click switches to the human form', imageOf(humanTree).props.src === '/dsh-plugin-whale-overlay/assets/idle.png', imageOf(humanTree).props.src)
check('the form switch is announced', bubbleText(humanTree) === '🐟 已切换为人形', bubbleText(humanTree))
check('the chosen form is remembered', formScene.sandbox.__storage.get(internals.STORE_FORM) === 'human')
humanTree.props.onContextMenu({ preventDefault() {}, stopPropagation() {} })
check('right-click switches back to the whale', imageOf(formScene.render().tree).props.src === '/dsh-plugin-whale-overlay/assets/whale_idle.gif')
check('a remembered form is restored on mount', imageOf(scene({ storage: { form: 'human' } }).first.tree).props.src === '/dsh-plugin-whale-overlay/assets/idle.png')

// ── dragging
const dragScene = scene()
const dragTree = dragScene.first.tree
const dragNode = dragScene.first.nodes[0]
const startX = Number.parseFloat(dragNode.style.left)
dragTree.props.onPointerDown({ ...pokeEvent, clientX: 500, clientY: 500 })
check('pressing shows the drag pose', imageOf(dragScene.render().tree).props.src === '/dsh-plugin-whale-overlay/assets/drag.png')
dragScene.fire('pointermove', { clientX: 700, clientY: 560 })
dragScene.fire('pointerup', { button: 0 })
const draggedTree = dragScene.render().tree
check('dragging moves the pet', Number.parseFloat(dragNode.style.left) !== startX, `${startX} → ${dragNode.style.left}`)
check('a finished drag returns to idle art', imageOf(draggedTree).props.src === '/dsh-plugin-whale-overlay/assets/whale_idle.gif')
// Read through the localStorage face (not the raw map) so a missing key is null
// rather than undefined — the difference is what makes this assertion honest.
const storedDrop = dragScene.sandbox.window.localStorage.getItem(internals.STORE_POSITION)
check('the dropped position is remembered', storedDrop !== null && Number.isFinite(JSON.parse(storedDrop).x), String(storedDrop))
check('the drag listeners are removed on release', (dragScene.sandbox.__listeners.get('pointermove') ?? []).length === 0)

const dragClickScene = scene()
dragClickScene.first.tree.props.onPointerDown({ ...pokeEvent, clientX: 500, clientY: 500 })
dragClickScene.fire('pointermove', { clientX: 620, clientY: 520 })
dragClickScene.fire('pointerup', { button: 0 })
const treeAfterDrag = dragClickScene.render().tree
treeAfterDrag.props.onClick()
check('the click that follows a drag is not a poke', bubbleOf(dragClickScene.render().tree) === null)
treeAfterDrag.props.onClick()
check('the next real click pokes again', bubbleOf(dragClickScene.render().tree) !== null)

const rightButtonScene = scene()
rightButtonScene.first.tree.props.onPointerDown({ ...pokeEvent, button: 2 })
check('a right-button press never starts a drag', imageOf(rightButtonScene.render().tree).props.src.endsWith('whale_idle.gif'))

const clampScene = scene()
clampScene.first.tree.props.onPointerDown({ ...pokeEvent, clientX: 500, clientY: 500 })
clampScene.fire('pointermove', { clientX: -4000, clientY: -4000 })
clampScene.fire('pointerup', { button: 0 })
const clampNode = clampScene.first.nodes[0]
check('dragging past the corner keeps the pet on screen', Number.parseFloat(clampNode.style.left) === internals.EDGE_PADDING_PX && Number.parseFloat(clampNode.style.top) === internals.EDGE_PADDING_PX, JSON.stringify(clampNode.style))
check('dropping against an edge makes the pet complain', bubbleText(clampScene.render().tree).includes('掉下去') === true, bubbleText(clampScene.render().tree))

// ── the wandering engine
const walkScene = scene()
const walkNode = walkScene.first.nodes[0]
const walkStart = Number.parseFloat(walkNode.style.left)
walkScene.advance(internals.WALK_FIRST_DELAY_MS + 1000)
check('the pet eventually wanders off on its own', Number.parseFloat(walkNode.style.left) !== walkStart, `${walkStart} → ${walkNode.style.left}`)
let stayedInside = true
for (let step = 0; step < 400; step += 1) {
  walkScene.advance(500)
  const x = Number.parseFloat(walkNode.style.left)
  const y = Number.parseFloat(walkNode.style.top)
  if (!(x >= 0 && y >= 0 && x + internals.PET_SIZE_PX <= 1280 && y + internals.PET_SIZE_PX <= 800)) stayedInside = false
}
check('the wandering pet never leaves the viewport', stayedInside)
check('the wandering pet keeps a live schedule', walkScene.sandbox.__clock.pending > 0)
walkScene.unmount()

// A pet parked against the left edge, forced to walk left: the first step is blocked,
// which is the wandering engine's own edge complaint (the drag path is a different one).
const edgeWalkScene = scene({ storage: { position: '{"x":10,"y":400}' }, random: 0.2 })
edgeWalkScene.advance(internals.WALK_FIRST_DELAY_MS + 2000)
check('a wandering pet blocked by the edge complains', bubbleText(edgeWalkScene.render().tree).includes('掉下去'), bubbleText(edgeWalkScene.render().tree))
edgeWalkScene.unmount()

// Same start, forced to walk right: it has room, so it must stay quiet.
const freeWalkScene = scene({ storage: { position: '{"x":10,"y":400}' }, random: 0.8 })
freeWalkScene.advance(internals.WALK_FIRST_DELAY_MS + 2000)
check('a wandering pet with room does not complain', bubbleText(freeWalkScene.render().tree) === '', bubbleText(freeWalkScene.render().tree))
check('the walk actually moved the quiet pet', Number.parseFloat(freeWalkScene.first.nodes[0].style.left) > 10, freeWalkScene.first.nodes[0].style.left)
freeWalkScene.unmount()

// ── reminders
const MIDSCREEN = { position: '{"x":600,"y":400}' }
const doneScene = scene({ session: sessionStateOf({ running: true }), storage: MIDSCREEN })
check('a running session shows no reminder yet', bubbleOf(doneScene.first.tree) === null)
doneScene.state.current = sessionStateOf({ running: false })
const doneTree = doneScene.render().tree
const doneBubble = bubbleOf(doneTree)
check('a finished turn is announced', textOf(doneBubble) === '🐟 干完啦～', textOf(doneBubble))
check('the finished-turn bubble is an alert', doneBubble.props.className.includes('dshWhaleOverlay_bubbleAlert'))
check('the reminder comes with a hop', doneScene.first.nodes[0].animateCalls.length === 1, String(doneScene.first.nodes[0].animateCalls.length))
doneScene.advance(internals.REMINDER_BUBBLE_MS + 10)
check('the reminder clears itself', bubbleOf(doneScene.render().tree) === null)

const quietScene = scene({ session: sessionStateOf({ running: false }), storage: MIDSCREEN })
quietScene.state.current = sessionStateOf({ running: false })
check('nothing changes, nothing is said', bubbleOf(quietScene.render().tree) === null)

const pendingScenes = [
  ['approval', '点头'],
  ['plan-review', '方案'],
  ['question', '问你'],
]
for (const [kind, hint] of pendingScenes) {
  const pendingScene = scene({ session: sessionStateOf({ running: true }), storage: MIDSCREEN })
  pendingScene.state.current = sessionStateOf({ running: true, pendingInteraction: kind })
  const text = bubbleText(pendingScene.render().tree)
  check(`a pending ${kind} is announced`, text.includes(hint), text)
}

const mountPending = scene({ session: sessionStateOf({ running: false, pendingInteraction: 'question' }), storage: MIDSCREEN })
check('a pending question that predates the mount is not re-announced', bubbleOf(mountPending.first.tree) === null)

const endedWithPending = scene({ session: sessionStateOf({ running: true }), storage: MIDSCREEN })
endedWithPending.state.current = sessionStateOf({ running: false, pendingInteraction: 'question' })
const endedText = bubbleText(endedWithPending.render().tree)
check('a turn ending on a question says the question, not "done"', endedText !== '🐟 干完啦～' && endedText.length > 0, endedText)

const otherSessionScene = scene({ session: sessionStateOf({ running: true }), storage: MIDSCREEN })
otherSessionScene.state.current = { current: 'session-2', byId: { 'session-2': { sessionId: 'session-2', running: false } } }
check('switching to another session does not fake a finish', bubbleOf(otherSessionScene.render().tree) === null)

// ── resilience
const blockedStorage = scene({ storage: {} })
blockedStorage.sandbox.window.localStorage.getItem = () => {
  throw new Error('blocked')
}
blockedStorage.sandbox.window.localStorage.setItem = () => {
  throw new Error('blocked')
}
check('a blocked localStorage does not break the pet', imageOf(blockedStorage.render().tree) !== null)

const noSessions = createSandbox()
const noSessionPet = mountPet(noSessions, null, { useSessions: () => undefined })
check('the pet still renders where the standard kit has no session feed', imageOf(noSessionPet.first.tree) !== null)

const nestedSessionPet = scene({ session: { current: 'session-9', byId: {} } })
check('a session id with no summary yet is handled', imageOf(nestedSessionPet.first.tree) !== null)

// ─────────────────────── 脱敏守卫 (identity-leak guard) ───────────────────────

/**
 * The pet is a shareable plugin, so its shipped text must not carry local identity.
 * This guard re-scans the delivered files on every run: a hand-written path, a
 * copied token, or a stray author field turns the suite red instead of quietly
 * shipping. The user/host patterns are built from the *running* machine, so whoever
 * runs this test guards their own identity.
 */
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Everything a stranger receives or reads: the code, the package manifest, the docs. */
const SHIPPED_TEXT_FILES = ['package.json', 'README.md', 'lib/index.js', 'lib/client.js']

const currentUser = userInfo().username
const currentHost = hostname().split('.')[0]

/**
 * Assembled from fragments on purpose: a guard that spelled these out verbatim
 * would itself contain them, so every scanner — and every reader grepping the
 * repo — would hit this file. A guard must not look like the thing it guards
 * against, and a PEM header written out here could even trip GitHub's push
 * protection on an otherwise clean repository.
 */
const HOME_PREFIXES = ['/Us' + 'ers/', '/ho' + 'me/', 'C:\\\\Us' + 'ers\\\\']
const CREDENTIAL_PATTERNS = [
  'g' + 'hp_[A-Za-z0-9]{20,}',
  'g' + 'ho_[A-Za-z0-9]{20,}',
  'github' + '_pat_[A-Za-z0-9_]{20,}',
  'AK' + 'IA[0-9A-Z]{16}',
  'xo' + 'x[baprs]-[A-Za-z0-9-]{10,}',
  'sk' + '-[A-Za-z0-9_-]{10,}',
]
const PRIVATE_KEY_PATTERN = '-----BE' + 'GIN [A-Z ]*PRIV' + 'ATE KEY-----'

const IDENTITY_CHECKS = [
  ['absolute home path', new RegExp(HOME_PREFIXES.map(escapeRegExp).join('|'))],
  ['credential literal', new RegExp(`\\b(?:${CREDENTIAL_PATTERNS.join('|')})`)],
  ['private key block', new RegExp(PRIVATE_KEY_PATTERN)],
  ['e-mail address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['phone number', /\b1[3-9]\d{9}\b/],
]
// Short names would match ordinary words, so only enforce these when they are distinctive.
if (currentUser.length >= 4) IDENTITY_CHECKS.push(['this machine\'s user name', new RegExp(escapeRegExp(currentUser), 'i')])
if (currentHost.length >= 4) IDENTITY_CHECKS.push(['this machine\'s host name', new RegExp(escapeRegExp(currentHost), 'i')])

for (const [label, pattern] of IDENTITY_CHECKS) {
  const offenders = SHIPPED_TEXT_FILES
    .map((rel) => [rel, readText(rel).match(pattern)])
    .filter(([, match]) => match !== null)
    .map(([rel, match]) => `${rel}: ${match[0].slice(0, 40)}`)
  check(`shipped files carry no ${label}`, offenders.length === 0, offenders.length === 0 ? undefined : offenders.join(' | '))
}

check('package.json declares no author/contributors (nothing to scrub later)', pkg.author === undefined && pkg.contributors === undefined)
check('the plugin folder carries no .git (no committer identity travels with it)', existsSync(join(ROOT, '.git')) === false)

// ─────────────────────────── verdict ───────────────────────────

const failed = results.filter((line) => line.startsWith('FAIL'))
for (const line of results) console.log(line)
console.log(`\n结论: ${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
