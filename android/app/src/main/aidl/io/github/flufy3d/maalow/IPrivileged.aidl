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

    // Remote control from the web UI, straight to the injector (not through Maa): action 0 down, 1 move, 2 up;
    // contacts 100 and up, coordinates in a width x height frame like attachInput's.
    boolean remoteTouch(int action, int contact, int x, int y, int width, int height) = 7;

    // A key press (down and up).
    boolean remoteKey(int code) = 8;
}
