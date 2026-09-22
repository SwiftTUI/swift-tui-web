import SwiftTUIRuntime
import SwiftTUIWASI

struct BrowserApp: App {
  var body: some Scene {
    WindowGroup("Alpha", id: WindowIdentifier("alpha")) {
      CounterScene(name: "Alpha")
    }
    WindowGroup("Beta", id: WindowIdentifier("beta")) {
      CounterScene(name: "Beta")
    }
  }
}

struct CounterScene: View {
  let name: String
  @State private var count = 0

  var body: some View {
    VStack {
      Text("\(name) count \(count)")
        .accessibilityLabel("\(name) count \(count)")
      Button("Increment \(name)") { count += 1 }
    }
  }
}

try await WASIRunner.run(BrowserApp.self)
