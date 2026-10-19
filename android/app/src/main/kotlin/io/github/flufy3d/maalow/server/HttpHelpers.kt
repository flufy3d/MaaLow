package io.github.flufy3d.maalow.server

import io.github.flufy3d.maalow.App
import io.ktor.server.routing.RoutingCall

/** The workspace named in the route's {ws} path parameter. */
internal fun RoutingCall.ws(): String = parameters["ws"]!!

/** The workspace a request names, or the current one; fails when there is none. */
internal fun App.workspaceOf(name: String?): String = name ?: defaultWorkspace() ?: error("no workspace")
