import AppKit
import Foundation

// Observe the application, not its IPC socket: sockets may be absent during
// startup or temporarily reconnect while the desktop is still running.
let arguments = Array(CommandLine.arguments.dropFirst())
let once = arguments.contains("--once")
let identifiers = Set(arguments.filter { $0 != "--once" }.isEmpty
    ? ["com.openai.codex"] : arguments.filter { $0 != "--once" })
let workspace = NSWorkspace.shared
var previous: Bool?

func report() {
    let running = workspace.runningApplications.contains {
        !$0.isTerminated && identifiers.contains($0.bundleIdentifier ?? "")
    }
    guard previous != running else { return }
    previous = running
    let data = try! JSONSerialization.data(withJSONObject: ["running": running], options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data([0x0A]))
}

if once {
    report()
} else {
    let center = workspace.notificationCenter
    let observers = [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification].map {
        center.addObserver(forName: $0, object: nil, queue: .main) { _ in report() }
    }
    // Reconcile after missed notifications, sleep/wake, and very fast restarts.
    let timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in report() }
    report()
    withExtendedLifetime((observers, timer)) { RunLoop.main.run() }
}
