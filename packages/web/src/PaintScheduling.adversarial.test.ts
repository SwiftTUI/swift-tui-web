import { expect, test } from "bun:test";
import { ManualAnimationFrameScheduler } from "./ManualAnimationFrameScheduler.ts";
import {
  type SurfacePaintRequest,
  SurfacePaintScheduler,
} from "./SurfacePaintScheduler.ts";
import type {
  WebHostSurfaceFrame,
  WebHostSurfaceImage,
} from "./WebHostSurfaceTransport.ts";

const frame = (
  overrides: Partial<WebHostSurfaceFrame> = {},
): WebHostSurfaceFrame => ({
  version: 2,
  epoch: 1,
  width: 4,
  height: 2,
  styles: [null],
  rows: [[], []],
  ...overrides,
});
const damage = (start: number, end: number) => ({
  textRows: [[0, [[start, end]]]] as [number, [number, number][]][],
  requiresFullTextRepaint: false,
  requiresFullGraphicsReplay: false,
});
const image = (id: string, dataBase64?: string): WebHostSurfaceImage => ({
  id,
  format: "png",
  bounds: [0, 0, 1, 1],
  visibleBounds: [0, 0, 1, 1],
  scalingMode: "stretch",
  ...(dataBase64 === undefined ? {} : { dataBase64 }),
});
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a recorded paint value");
  return value;
}

const announce = (message: string) => [{ message, politeness: "polite" }];

for (let id = 46; id <= 70; id++) {
  test(`w1s${String(id).padStart(3, "0")} paint scheduling contract`, () => {
    const clock = new ManualAnimationFrameScheduler();
    const paints: SurfacePaintRequest[] = [];
    let revision = 1;
    const scheduler = new SurfacePaintScheduler(
      id === 46 ? undefined : clock,
      (value) => {
        paints.push(value);
        if (id === 69 && paints.length === 1)
          scheduler.present(frame({ gen: 2 }));
        if (id === 70) scheduler.resetSession();
      },
      (value) =>
        id >= 66 && id <= 68 ? value?.geometryRevision === revision : true,
    );
    try {
      switch (id) {
        case 46:
          scheduler.present(frame({ gen: 1 }));
          scheduler.present(frame({ gen: 2 }));
          expect(paints.map((p) => required(p.frame).gen)).toEqual([1, 2]);
          break;
        case 47:
          for (const gen of [1, 2, 3]) scheduler.present(frame({ gen }));
          expect(clock.scheduled).toBe(1);
          clock.tick();
          expect(paints).toHaveLength(1);
          expect(required(required(paints[0]).frame).gen).toBe(3);
          expect(required(paints[0]).coalescedFrameCount).toBe(2);
          break;
        case 48:
          scheduler.present(frame());
          clock.tick();
          scheduler.present(frame({ damage: damage(0, 1) }));
          scheduler.present(frame({ damage: damage(2, 3) }));
          clock.tick();
          expect(required(required(paints[1]).damage).textRows).toEqual([
            [
              0,
              [
                [0, 1],
                [2, 3],
              ],
            ],
          ]);
          break;
        case 49:
        case 50:
        case 51:
          scheduler.present(frame({ geometryRevision: 1 }));
          clock.tick();
          scheduler.present(
            frame({
              damage: damage(0, 1),
              geometryRevision: 1,
              ...(id === 49
                ? { epoch: 2 }
                : id === 50
                  ? { width: 5 }
                  : { geometryRevision: 2 }),
            }),
          );
          clock.tick();
          expect(required(paints[1]).damage).toBeUndefined();
          break;
        case 52:
        case 53:
        case 54:
          scheduler.present(frame({ images: [image("png:one", "old")] }));
          scheduler.present(
            frame({
              images:
                id === 53
                  ? []
                  : [image("png:one", id === 54 ? "new" : undefined)],
            }),
          );
          if (id === 53)
            expect(scheduler.statistics.carriedImagePayloadBytes).toBe(0);
          clock.tick();
          expect(required(required(paints[0]).frame).images).toEqual(
            id === 53 ? [] : [image("png:one", id === 54 ? "new" : "old")],
          );
          break;
        case 55:
          for (const word of ["one", "two", "three"])
            scheduler.present(
              frame({ accessibilityAnnouncements: announce(word) }),
            );
          clock.tick();
          scheduler.repaintNow();
          expect(
            required(paints[0]).accessibilityAnnouncements.map(
              (a) => a.message,
            ),
          ).toEqual(["one", "two", "three"]);
          expect(required(paints[1]).accessibilityAnnouncements).toEqual([]);
          break;
        case 56:
          scheduler.present(frame({ images: [image("b"), image("a")] }), [
            "b",
            "a",
          ]);
          scheduler.present(frame({ images: [image("b"), image("a")] }), ["a"]);
          clock.tick();
          expect(required(paints[0]).recoveredImagePayloadIds).toEqual([
            "a",
            "b",
          ]);
          break;
        case 57:
        case 58:
        case 59:
          if (id !== 58) scheduler.setHeld(true);
          scheduler.present(frame());
          if (id === 58) {
            scheduler.setHeld(true);
            expect(clock.cancels).toBe(1);
          }
          if (id === 59) scheduler.flush();
          clock.tick();
          expect(paints).toHaveLength(0);
          expect(scheduler.statistics.pending).toBe(true);
          scheduler.setHeld(false);
          clock.tick();
          expect(paints).toHaveLength(1);
          break;
        case 60:
          scheduler.present(frame({ gen: 1 }));
          clock.tick();
          scheduler.present(frame({ gen: 2, damage: damage(0, 1) }));
          scheduler.repaintNow();
          expect(required(required(paints[1]).frame).gen).toBe(2);
          expect(required(paints[1]).damage).toBeUndefined();
          clock.tick();
          expect(paints).toHaveLength(2);
          break;
        case 61:
          scheduler.present(frame());
          clock.tick();
          scheduler.requestRepaint();
          scheduler.requestRepaint();
          expect(clock.scheduled).toBe(1);
          clock.tick();
          expect(paints).toHaveLength(2);
          expect(required(paints[1]).damage).toBeUndefined();
          break;
        case 62:
          scheduler.present(frame({ gen: 1 }));
          clock.tick();
          scheduler.present(
            frame({ gen: 2, accessibilityAnnouncements: announce("new") }),
          );
          scheduler.reprojectVisible();
          expect(required(required(paints[1]).frame).gen).toBe(1);
          expect(required(paints[1]).accessibilityAnnouncements).toEqual([]);
          expect(scheduler.statistics.pending).toBe(true);
          clock.tick();
          expect(required(required(paints[2]).frame).gen).toBe(2);
          expect(required(paints[2]).accessibilityAnnouncements).toEqual(
            announce("new"),
          );
          break;
        case 63:
          scheduler.present(
            frame({
              accessibilityAnnouncements: announce("old"),
              images: [image("old", "bytes")],
            }),
          );
          scheduler.resetSession();
          clock.tick();
          expect(paints).toHaveLength(0);
          expect(scheduler.statistics).toMatchObject({
            pending: false,
            queuedAnnouncements: 0,
            carriedImagePayloadBytes: 0,
          });
          break;
        case 64:
          scheduler.present(frame());
          clock.tick();
          scheduler.resetSession();
          scheduler.present(frame({ damage: damage(0, 1) }));
          clock.tick();
          expect(required(paints[1]).damage).toBeUndefined();
          break;
        case 65:
          scheduler.present(frame());
          scheduler.dispose();
          scheduler.dispose();
          scheduler.present(frame());
          scheduler.requestRepaint();
          scheduler.repaintNow();
          scheduler.flush();
          clock.tick();
          expect(paints).toHaveLength(0);
          expect(clock.scheduled).toBe(0);
          break;
        case 66:
          scheduler.present(frame({ geometryRevision: 2 }));
          clock.tick();
          clock.tick();
          expect(clock.requests).toBe(0);
          expect(paints).toHaveLength(0);
          break;
        case 67:
          scheduler.present(frame({ geometryRevision: 1 }));
          revision = 2;
          clock.tick();
          expect(paints).toHaveLength(0);
          expect(clock.scheduled).toBe(0);
          scheduler.present(frame({ geometryRevision: 2 }));
          clock.tick();
          expect(required(required(paints[0]).frame).geometryRevision).toBe(2);
          break;
        case 68:
          scheduler.present(frame({ geometryRevision: 1, gen: 1 }));
          scheduler.present(frame({ geometryRevision: 2, gen: 2 }));
          clock.tick();
          expect(required(required(paints[0]).frame).gen).toBe(1);
          break;
        case 69:
          scheduler.present(frame({ gen: 1 }));
          clock.tick();
          expect(paints).toHaveLength(1);
          expect(clock.scheduled).toBe(1);
          clock.tick();
          expect(paints.map((p) => required(p.frame).gen)).toEqual([1, 2]);
          break;
        case 70:
          scheduler.present(frame());
          clock.tick();
          expect(scheduler.statistics.pending).toBe(false);
          scheduler.reprojectVisible();
          expect(paints).toHaveLength(1);
          scheduler.present(frame({ damage: damage(0, 1) }));
          clock.tick();
          expect(required(paints[1]).damage).toBeUndefined();
          break;
      }
    } finally {
      scheduler.dispose();
    }
  });
}
