package io.github.flufy3d.maalow.server

import io.github.flufy3d.maalow.App
import io.ktor.server.routing.Route
import io.ktor.server.websocket.webSocket

/**
 * Remote view and control (see [io.github.flufy3d.maalow.remote.Remote]):
 *
 *     WS /api/v1/remote    first message {"t": "hello", "token"}; then video frames and JSON both ways
 */
fun Route.remoteRoutes(app: App) {
    webSocket(REMOTE_PATH) { app.remote.serve(this) }
}

const val REMOTE_PATH = "/api/v1/remote"
