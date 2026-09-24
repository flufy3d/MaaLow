package io.github.flufy3d.maalow;

import android.view.Surface;
import android.os.ParcelFileDescriptor;

// Runs in the Shizuku UserService process (shell uid). Kept minimal: display mirroring, input injection,
// and shell commands. All data stays in the app process.
interface IPrivileged {
    // Shizuku calls this transaction to tear the service down.
    void destroy() = 16777114;

    // Mirror display 0 into the surface (aspect fit). Returns a mirror id, or -1.
    int mirror(in Surface surface, int width, int height, String name) = 1;
    void release(int id) = 2;

    // Read input messages from the socket (see bridge.cpp); coordinates are in a width x height frame.
    void attachInput(in ParcelFileDescriptor socket, int width, int height) = 3;

    // Run a shell command; returns stdout+stderr, prefixed by "exit=<code>\n".
    String exec(String cmd) = 4;

    // [logical width, logical height, rotation] of display 0.
    int[] displayInfo() = 5;

    int pid() = 6;
}
