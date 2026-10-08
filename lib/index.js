/**
 * dsh-plugin-whale-overlay — host half.
 *
 * The pet itself is entirely browser-side (lib/client.js). The host half exists
 * for one reason: the GIF/PNG assets must reach the browser as real files. A
 * client bundle is a single self-contained module (the browser module table only
 * resolves seed words, shell modules, and other registered bundles), so assets
 * cannot be `require`d or inlined without bloating the bundle by ~1 MB of base64.
 *
 * So: register one prefix route on the webserver and stream files out of
 * `assets/`. Nothing here touches the session, the model, or any DSH state.
 *
 * @module dsh-plugin-whale-overlay
 */
import { createReadStream, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Stable Cordis plugin name. */
const name = 'dsh-plugin-whale-overlay'

/** The webserver is a hard dependency: without it the pet has no images. */
const inject = ['webServer']

/** Route prefix the client half builds asset URLs from. Keep in sync with `ASSET_BASE` in lib/client.js. */
const ROUTE_PATH = '/dsh-plugin-whale-overlay/assets'

/** Absolute path of this package's asset directory (trailing separator included on POSIX). */
const ASSET_ROOT = fileURLToPath(new URL('../assets/', import.meta.url))

/** Only image formats the pet actually uses are servable — an extension allowlist, not a blocklist. */
const MIME_BY_EXTENSION = {
  '.gif': 'image/gif',
  '.png': 'image/png',
}

/** One day: assets are immutable for a running deployment, and the pet re-requests them on every reload. */
const CACHE_CONTROL = 'public, max-age=86400'

/**
 * Answer a response that cannot be served.
 * @param res - node:http response.
 * @param status - HTTP status to send.
 */
function fail(res, status) {
  res.writeHead(status)
  res.end()
}

/**
 * Build the asset route handler.
 *
 * Path handling is deliberately narrow: decode, strip the route prefix, require a
 * known image extension, then join under ASSET_ROOT and re-check that the result
 * is still inside it. That last check is what makes `../` traversal a 404 instead
 * of a file read, so it must stay after `join` (which resolves the `..`).
 *
 * @returns a `(req, res)` handler usable as a webserver route.
 */
function createAssetHandler() {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      fail(res, 405)
      return
    }
    let pathname
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      fail(res, 400)
      return
    }
    let relative
    try {
      relative = decodeURIComponent(pathname.slice(ROUTE_PATH.length)).replace(/^\/+/, '')
    } catch {
      // A malformed %-escape in the request path.
      fail(res, 400)
      return
    }
    const extension = extname(relative).toLowerCase()
    if (relative.length === 0 || MIME_BY_EXTENSION[extension] === undefined || relative.includes('\0')) {
      fail(res, 404)
      return
    }
    const file = join(ASSET_ROOT, relative)
    if (!file.startsWith(ASSET_ROOT)) {
      fail(res, 404)
      return
    }
    let size
    try {
      const stat = statSync(file)
      if (!stat.isFile()) {
        fail(res, 404)
        return
      }
      size = stat.size
    } catch {
      fail(res, 404)
      return
    }
    res.writeHead(200, {
      'content-type': MIME_BY_EXTENSION[extension],
      'content-length': String(size),
      'cache-control': CACHE_CONTROL,
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = createReadStream(file)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }
}

/**
 * Plugin body: own the asset route for as long as this plugin is active.
 * @param ctx - host context carrying `webServer`.
 */
function apply(ctx) {
  const handler = createAssetHandler()
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PATH, handler }),
    'dsh-plugin-whale-overlay: asset route',
  )
}

export { ROUTE_PATH, apply, inject, name }
