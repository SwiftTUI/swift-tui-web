import SwiftTUIRuntime
import SwiftTUIWASI

struct BrowserApp: App {
  var body: some Scene {
    WindowGroup("Alpha", id: WindowIdentifier("alpha")) {
      CounterScene(name: "Alpha")
    }
    WindowGroup("Animation", id: WindowIdentifier("animation")) {
      AnimationWorkload()
    }
    WindowGroup("Deep", id: WindowIdentifier("deep")) {
      DeepWorkload()
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

struct AnimationWorkload: View {
  @State private var tick = 0

  var body: some View {
    VStack(spacing: 0) {
      Text("Animation tick \(tick)")
      ForEach(0..<16, id: \.self) { row in
        HStack(spacing: 0) {
          ForEach(0..<16, id: \.self) { column in
            Text("\((tick + row + column) % 10)")
          }
        }
      }
    }
    .task { @MainActor in
      while !Task.isCancelled {
        do { try await Task.sleep(for: .milliseconds(16)) } catch { return }
        tick += 1
      }
    }
  }
}

struct DeepWorkload: View {
  var body: some View {
    // AnyView policy: deliberately construct a finite runtime-selected depth
    // for the browser stack qualification fixture, not an authoring API.
    var content = AnyView(CounterScene(name: "Deep"))
    for _ in 0..<96 {
      content = AnyView(content.padding(0))
    }
    return content
  }
}

try await WASIRunner.run(BrowserApp.self)
