import SwiftTUIRuntime
import SwiftTUIAnimatedImage
import SwiftTUIWASI

struct BrowserApp: App {
  var body: some Scene {
    WindowGroup("Alpha", id: WindowIdentifier("alpha")) {
      CounterScene(name: "Alpha")
    }
    WindowGroup("Animation", id: WindowIdentifier("animation")) {
      AnimationWorkload()
    }
    WindowGroup("Images", id: WindowIdentifier("images")) {
      ImageWorkload()
    }
    WindowGroup("Deep", id: WindowIdentifier("deep")) {
      DeepWorkload()
    }
    WindowGroup("Accessibility", id: WindowIdentifier("accessibility")) {
      AccessibilityWorkload()
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

struct ImageWorkload: View {
  private let frames = [
    AnimatedImageFrame(width: 1, height: 1, pixels: [.init(red: 255, green: 0, blue: 0)]),
    AnimatedImageFrame(width: 1, height: 1, pixels: [.init(red: 0, green: 0, blue: 255)]),
  ]
  var body: some View {
    VStack {
      EnvironmentReader(\.accessibilityReduceMotion) { reduced in
        Text(reduced ? "Motion reduced" : "Motion active")
      }
      AnimatedImage(frames: frames, framesPerSecond: 5).frame(width: 4, height: 2)
    }
  }
}

struct AccessibilityWorkload: View {
  @State private var count = 0
  @State private var enabled = false
  @State private var gain = 2.0
  @State private var name = ""
  @State private var secret = ""
  @State private var showControl = true
  @FocusState private var nameFocused: Bool

  var body: some View {
    VStack(spacing: 0) {
      Text("Activated \(count)").accessibilityLabel("Activated \(count)")
        .accessibilityLiveRegion(.polite)
      Button("Activate") { count += 1 }
      Toggle("Enabled", isOn: $enabled)
      Slider("Gain", value: $gain, in: 0...10, step: 1)
      TextField("Name", text: $name).focused($nameFocused)
      SecureField("Password", text: $secret)
      Button("Unavailable") { count += 100 }.disabled(true)
      Button("Toggle control") { showControl.toggle() }
      if showControl { Button("Removable") { count += 10 } }
      Button("Focus Name") { nameFocused = true }
      HStack(spacing: 1) {
        Text("Decorative star")
        Text("Decorative dot")
      }
      .accessibilityHidden()
    }
  }
}

try await WASIRunner.run(BrowserApp.self)
