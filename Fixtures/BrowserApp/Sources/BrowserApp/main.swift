import SwiftTUIAnimatedImage
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
    WindowGroup("Images", id: WindowIdentifier("images")) {
      ImageWorkload()
    }
    WindowGroup("Deep", id: WindowIdentifier("deep")) {
      DeepWorkload()
    }
    WindowGroup("Accessibility", id: WindowIdentifier("accessibility")) {
      AccessibilityWorkload()
    }
    WindowGroup("Controls", id: WindowIdentifier("controls")) {
      ControlsWorkload()
    }
    WindowGroup("Scrolling", id: WindowIdentifier("scrolling")) {
      ScrollingWorkload()
    }
    WindowGroup("Reading", id: WindowIdentifier("reading")) {
      ReadingWorkload()
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
  @State private var nameEdits = 0
  @State private var secretEdits = 0
  @State private var showControl = true
  @FocusState private var nameFocused: Bool

  private func counted(_ value: Binding<String>, _ count: Binding<Int>) -> Binding<String> {
    Binding(
      get: { value.wrappedValue },
      set: {
        value.wrappedValue = $0
        count.wrappedValue += 1
      })
  }

  var body: some View {
    VStack(spacing: 0) {
      Text("Activated \(count)").accessibilityLabel("Activated \(count)")
        .accessibilityLiveRegion(.polite)
      Button("Activate") { count += 1 }
      Toggle("Enabled", isOn: $enabled)
      Slider("Gain", value: $gain, in: 0...10, step: 1)
      TextField("Name", text: counted($name, $nameEdits))
        .focused($nameFocused)
      SecureField("Password", text: counted($secret, $secretEdits))
      Text("Name edits \(nameEdits) Password edits \(secretEdits)")
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

struct ControlsWorkload: View {
  @State private var quantity = 1
  @State private var choice = 0
  @State private var expanded = false
  @State private var showSheet = false
  @State private var sheetCount = 0
  @State private var processStatus = "Process not requested"
  @State private var dragEnds = 0
  @State private var notes = "Café 漢字 🙂"

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("Quantity \(quantity) Choice \(choice) Sheets \(sheetCount) Drags \(dragEnds)")
      Stepper("Quantity", value: $quantity, in: 0...9)
      Picker("Choice", selection: $choice) {
        Text("First").tag(0)
        Text("Second").tag(1)
      }.pickerStyle(.segmented)
      DisclosureGroup("Details", isExpanded: $expanded) {
        Text("Expanded Café 漢字 🙂")
      }
      TextEditor(text: $notes).accessibilityLabel("Notes").frame(width: 32, height: 4)
      HStack(spacing: 1) {
        Rectangle().fill(.red).frame(width: 4, height: 2)
        Circle().fill(.blue).frame(width: 4, height: 2)
        Text("▁▂▃▄▅▆▇█")
      }.accessibilityLabel("Shapes and chart marks")
      Text("Drag target").frame(width: 20, height: 2)
        .gesture(DragGesture(minimumDistance: 0).onEnded { _ in dragEnds += 1 })
      Button("Show sheet") { showSheet = true }
      Button("Launch process") {
        #if os(WASI)
          processStatus = "Unavailable: WASI has no PTY process service"
        #else
          processStatus = "Native manifest capture only"
        #endif
      }
      Text(processStatus)
    }
    .sheet("Fixture sheet", isPresented: $showSheet) {
      VStack {
        Text("Sheet body")
        Button("Complete sheet") {
          sheetCount += 1
          showSheet = false
        }
      }
    }
  }
}

struct ScrollingWorkload: View {
  @State private var selected = -1

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("Selected row \(selected)")
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          Text("Outer scroll start")
          ScrollView {
            VStack(alignment: .leading, spacing: 0) {
              ForEach(0..<20, id: \.self) { row in
                Text("Nested row \(row) Café 漢字 🙂")
              }
            }
          }.frame(width: 32, height: 4)
          ForEach(0..<40, id: \.self) { row in
            Button("Choose row \(row)") { selected = row }
          }
        }
      }.frame(width: 48, height: 14)
    }
  }
}

// Ordinary prose is deliberately separate from the spatial shapes/scrolling
// fixtures. A terminal grid does not make prose a two-dimensional exception.
struct ReadingWorkload: View {
  @State private var continued = 0

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 1) {
        Text("Reading introduction")
        Text(
          "A small browser host should preserve ordinary prose when its container becomes narrow. Each sentence remains readable, and the following control remains available after text enlargement."
        )
        Text(
          "The second paragraph contains Café and Ångström. Its final words are reading complete.")
        Button("Continue reading") { continued += 1 }
        Text("Continued \(continued)")
      }
      .padding(1)
    }
  }
}

try await WASIRunner.run(BrowserApp.self)
