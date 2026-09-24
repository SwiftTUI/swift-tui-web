/** Raw GIF images are static first-frame composites, matching portable Image.
 * Authored AnimatedImage delivers producer-selected PNG frames instead. Strip
 * animation/loop blocks without Canvas or a second independent animation clock. */
export function firstGifFrame(
  bytes: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const fail = () => {
    throw new Error("Invalid GIF container");
  };
  if (
    bytes.length < 13 ||
    (String.fromCharCode(...bytes.subarray(0, 6)) !== "GIF89a" &&
      String.fromCharCode(...bytes.subarray(0, 6)) !== "GIF87a")
  )
    return fail();
  let offset = 13 + (bytes[10]! & 0x80 ? 3 * 2 ** ((bytes[10]! & 7) + 1) : 0);
  if (offset > bytes.length) return fail();
  const header = bytes.slice(0, offset);
  let control = new Uint8Array(0);
  const subBlocks = () => {
    while (offset < bytes.length) {
      const size = bytes[offset++]!;
      if (!size) return;
      offset += size;
      if (offset > bytes.length) return fail();
    }
    return fail();
  };
  while (offset < bytes.length) {
    const start = offset;
    const marker = bytes[offset++]!;
    if (marker === 0x21) {
      const label = bytes[offset++];
      if (label === 0xf9 && bytes[offset] !== 4) return fail();
      subBlocks();
      if (label === 0xf9) control = bytes.slice(start, offset);
    } else if (marker === 0x2c) {
      if (offset + 9 > bytes.length) return fail();
      const word = (at: number) => bytes[at]! | (bytes[at + 1]! << 8);
      const width = word(offset + 4),
        height = word(offset + 6);
      if (
        !width ||
        !height ||
        word(offset) + width > word(6) ||
        word(offset + 2) + height > word(8)
      )
        return fail();
      const packed = bytes[offset + 8]!;
      offset += 9 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
      if (offset >= bytes.length) return fail();
      if (bytes[offset]! < 2 || bytes[offset]! > 8) return fail();
      offset++; // LZW minimum code size; data sub-blocks remain untouched.
      subBlocks();
      const frame = bytes.subarray(start, offset);
      const result = new Uint8Array(
        header.length + control.length + frame.length + 1,
      );
      result.set(header);
      result.set(control, header.length);
      result.set(frame, header.length + control.length);
      result[result.length - 1] = 0x3b;
      return result;
    } else return fail();
  }
  return fail();
}

export function staticGifBase64(payload: string): string {
  const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
  const first = firstGifFrame(bytes);
  let binary = "";
  for (let offset = 0; offset < first.length; offset += 16384)
    binary += String.fromCharCode(...first.subarray(offset, offset + 16384));
  return btoa(binary);
}
