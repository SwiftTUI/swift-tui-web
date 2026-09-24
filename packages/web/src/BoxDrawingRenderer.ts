// Compatibility names for the Canvas backend. All primitives are emitted by
// the renderer-neutral sink; no context is allocated by the geometry module.
export {
  canRenderGeometricGlyph as canRenderBoxDrawing,
  emitGlyphGeometry as drawBoxDrawing,
} from "./GlyphGeometry.ts";
