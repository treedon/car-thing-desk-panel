// Prints one line to stdout each time the Mac's display or power state changes:
//   display off | display on | will sleep | did wake
// mac-service/src/mac-power.js reads them. At start-up it prints the display's
// current state once ("display off" or "display on"), so a helper restarted
// while the screen is dark, or lit again meanwhile, doesn't leave the service
// with a stale one. It never prints "will sleep" or "did wake" at start: a
// running helper means the system is awake, and the service assumes as much.
//
// NSWorkspace's notification center is only delivered inside a logged-in GUI
// session, which is where the LaunchAgent runs the service. Lines are flushed
// one by one because stdout is a pipe, and a buffered "display off" would reach
// the panel when the next line did, not when the screen went dark.

import AppKit

func emit(_ line: String) {
    print(line)
    fflush(stdout)
}

let center = NSWorkspace.shared.notificationCenter
let events: [(Notification.Name, String)] = [
    (NSWorkspace.screensDidSleepNotification, "display off"),
    (NSWorkspace.screensDidWakeNotification, "display on"),
    (NSWorkspace.willSleepNotification, "will sleep"),
    (NSWorkspace.didWakeNotification, "did wake"),
]
for (name, line) in events {
    center.addObserver(forName: name, object: nil, queue: .main) { _ in emit(line) }
}

// After the observers, so a change between the two is reported, not lost. The
// worst case is a repeated line, which the service ignores.
emit(CGDisplayIsAsleep(CGMainDisplayID()) != 0 ? "display off" : "display on")

RunLoop.main.run()
