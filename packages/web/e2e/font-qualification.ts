export async function qualifyFont(
  faces: { file: string; weight: number; style: string }[],
) {
  // Qualification measures real CSS layout; Canvas is not a typography oracle.
  HTMLCanvasElement.prototype.getContext = () => {
    throw new Error("Canvas requested during DOM font qualification");
  };
  document.body.replaceChildren();
  document.body.style.cssText = "margin:16px;background:#fff;color:#111";
  const loaded = await Promise.all(
    faces.map(async (face) => {
      const font = new FontFace(
        "SwiftTUI Qualification",
        `url(/fonts/${face.file})`,
        { weight: String(face.weight), style: face.style },
      );
      await font.load();
      document.fonts.add(font);
      return font.status;
    }),
  );
  const sizes = [12, 14, 16, 20, 24, 32];
  const measurements = [];
  for (const size of sizes) {
    for (const face of faces) {
      const line = document.createElement("div");
      line.style.cssText = `font:${face.style} ${face.weight} ${size}px "SwiftTUI Qualification";font-synthesis:none;white-space:pre;line-height:1.5;font-kerning:none;font-variant-ligatures:none;letter-spacing:0;word-spacing:0`;
      const text = document.createElement("span");
      text.textContent = "W".repeat(200);
      const baseline = document.createElement("span");
      baseline.style.cssText =
        "display:inline-block;width:0;height:0;vertical-align:baseline";
      line.append(text, baseline);
      document.body.append(line);
      const rect = line.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(text);
      const advance = range.getBoundingClientRect().width / 200;
      const baselineOffset = baseline.getBoundingClientRect().top - rect.top;
      text.textContent =
        " !\"#$%&'()*+,-./0123456789:;<=>?@[\\]^_`{|}~ éÅñç e\u0301";
      const samples = [];
      for (const sample of ["W", " ", "i", "é", "e\u0301", "Å", "_", "j"]) {
        text.textContent = sample;
        range.selectNodeContents(text);
        samples.push({
          text: sample,
          width: range.getBoundingClientRect().width,
        });
      }
      text.textContent =
        " !\"#$%&'()*+,-./0123456789:;<=>?@[\\]^_`{|}~ éÅñç e\u0301";
      measurements.push({
        size,
        face: face.file,
        advance,
        baseline: baselineOffset,
        lineHeight: rect.height,
        samples,
      });
    }
  }
  return {
    loaded,
    measurements,
    platform: navigator.platform,
    userAgent: navigator.userAgent,
  };
}
