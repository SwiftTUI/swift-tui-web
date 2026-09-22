import { expect, test } from "bun:test";

import { ManualAnimationFrameScheduler } from "./ManualAnimationFrameScheduler.ts";
import {
  type SurfacePaintRequest,
  SurfacePaintScheduler,
  unionSurfaceDamage,
  type WebHostAnimationFrameScheduler,
} from "./SurfacePaintScheduler.ts";
import type {
  WebHostSurfaceDamage,
  WebHostSurfaceFrame,
  WebHostSurfaceImage,
} from "./WebHostSurfaceTransport.ts";

function frame(
  overrides: Partial<WebHostSurfaceFrame> = {},
): WebHostSurfaceFrame {
  return {
    version: 2,
    epoch: 1,
    width: 4,
    height: 2,
    styles: [null],
    rows: [[], []],
    ...overrides,
  };
}

function damage(
  textRows: WebHostSurfaceDamage["textRows"],
  flags: Partial<Omit<WebHostSurfaceDamage, "textRows">> = {},
): WebHostSurfaceDamage {
  return {
    textRows,
    requiresFullTextRepaint: false,
    requiresFullGraphicsReplay: false,
    ...flags,
  };
}

function image(id: string, dataBase64?: string): WebHostSurfaceImage {
  return {
    id,
    format: "png",
    bounds: [0, 0, 1, 1],
    visibleBounds: [0, 0, 1, 1],
    scalingMode: "stretch",
    ...(dataBase64 === undefined ? {} : { dataBase64 }),
  };
}

function makeScheduler(
  animationFrames: WebHostAnimationFrameScheduler | undefined,
): { scheduler: SurfacePaintScheduler; paints: SurfacePaintRequest[] } {
  const paints: SurfacePaintRequest[] = [];
  const scheduler = new SurfacePaintScheduler(animationFrames, (request) => {
    paints.push(request);
  });
  return { scheduler, paints };
}

test("a burst of frames paints once, as the newest frame with unioned damage", () => {
  const clock = new ManualAnimationFrameScheduler();
  const { scheduler, paints } = makeScheduler(clock);

  const first = frame({ gen: 1 });
  scheduler.present(first);
  clock.tick();
  expect(paints).toHaveLength(1);
  expect(paints[0]!.frame).toBe(first);
  // The first paint has nothing to be relative to.
  expect(paints[0]!.damage).toBeUndefined();

  scheduler.present(
    frame({
      gen: 2,
      damage: damage([[0, [[0, 1]]]]),
      accessibilityAnnouncements: [{ message: "two", politeness: "polite" }],
    }),
  );
  scheduler.present(
    frame({
      gen: 3,
      damage: damage([[1, [[2, 3]]]]),
      accessibilityAnnouncements: [
        { message: "three", politeness: "assertive" },
      ],
    }),
  );
  const newest = frame({
    gen: 4,
    damage: damage([[0, [[1, 2]]]]),
    accessibilityAnnouncements: [{ message: "four", politeness: "polite" }],
  });
  scheduler.present(newest);

  expect(clock.requests).toBe(2);
  expect(clock.scheduled).toBe(1);
  expect(paints).toHaveLength(1);
  expect(scheduler.statistics).toEqual({
    presentedFrames: 4,
    paints: 1,
    coalescedFrames: 2,
    pending: true,
  });

  clock.tick();
  expect(paints).toHaveLength(2);
  const request = paints[1]!;
  expect(request.frame).toBe(newest);
  expect(request.damage).toEqual(
    damage([
      [0, [[0, 2]]],
      [1, [[2, 3]]],
    ]),
  );
  expect(
    request.accessibilityAnnouncements.map((entry) => entry.message),
  ).toEqual(["two", "three", "four"]);
  expect(request.coalescedFrameCount).toBe(2);
  expect(scheduler.statistics).toEqual({
    presentedFrames: 4,
    paints: 2,
    coalescedFrames: 2,
    pending: false,
  });
});

test("damage after a paint is relative to the painted frame, not to the burst before it", () => {
  const clock = new ManualAnimationFrameScheduler();
  const { scheduler, paints } = makeScheduler(clock);
  scheduler.present(frame({ gen: 1 }));
  scheduler.present(frame({ gen: 2, damage: damage([[1, []]]) }));
  clock.tick();
  expect(paints[0]!.damage).toBeUndefined();

  scheduler.present(frame({ gen: 3, damage: damage([[0, [[3, 4]]]]) }));
  clock.tick();
  expect(paints[1]!.damage).toEqual(damage([[0, [[3, 4]]]]));
  expect(paints[1]!.coalescedFrameCount).toBe(0);
});

test("geometry, epoch and damage-less frames promote the pending paint to full", () => {
  for (const [label, transition] of [
    [
      "grid width",
      frame({ gen: 2, width: 5, damage: damage([[0, [[0, 1]]]]) }),
    ],
    [
      "grid height",
      frame({ gen: 2, height: 3, damage: damage([[0, [[0, 1]]]]) }),
    ],
    ["epoch", frame({ gen: 2, epoch: 2, damage: damage([[0, [[0, 1]]]]) })],
    ["missing damage", frame({ gen: 2 })],
  ] as const) {
    const clock = new ManualAnimationFrameScheduler();
    const { scheduler, paints } = makeScheduler(clock);
    scheduler.present(frame({ gen: 1 }));
    clock.tick();

    scheduler.present(transition);
    // A later partial frame cannot narrow a promotion.
    scheduler.present({
      ...transition,
      gen: 3,
      damage: damage([[1, [[0, 1]]]]),
    });
    clock.tick();
    expect(paints, label).toHaveLength(2);
    expect(paints[1]!.damage, label).toBeUndefined();
  }
});

test("full-repaint flags survive the union and everything else merges", () => {
  expect(unionSurfaceDamage(undefined, damage([]))).toBeUndefined();
  expect(unionSurfaceDamage(damage([]), undefined)).toBeUndefined();
  expect(
    unionSurfaceDamage(
      damage([
        [2, [[0, 1]]],
        [
          0,
          [
            [4, 6],
            [1, 2],
          ],
        ],
      ]),
      damage(
        [
          [0, [[2, 5]]],
          [1, [[0, 1]]],
          [2, []],
        ],
        { requiresFullGraphicsReplay: true },
      ),
    ),
  ).toEqual(
    damage(
      [
        [0, [[1, 6]]],
        [1, [[0, 1]]],
        [2, []],
      ],
      { requiresFullGraphicsReplay: true },
    ),
  );
  // A whole-row entry absorbs ranges that arrive after it too.
  expect(
    unionSurfaceDamage(
      damage([[3, []]]),
      damage([[3, [[0, 1]]]], { requiresFullTextRepaint: true }),
    ),
  ).toEqual(damage([[3, []]], { requiresFullTextRepaint: true }));
});

test("image payloads and recovered ids carried only by coalesced frames reach the painter", () => {
  const clock = new ManualAnimationFrameScheduler();
  const { scheduler, paints } = makeScheduler(clock);
  scheduler.present(frame({ gen: 1 }));
  clock.tick();

  scheduler.present(
    frame({
      gen: 2,
      damage: damage([]),
      images: [
        image("png:a", "AAAA"),
        image("png:b", "BBBB"),
        image("png:gone", "GGGG"),
      ],
    }),
    ["png:a"],
  );
  scheduler.present(
    frame({
      gen: 3,
      damage: damage([]),
      images: [image("png:a"), image("png:b", "B2B2")],
    }),
    ["png:b"],
  );
  const newest = frame({
    gen: 4,
    damage: damage([]),
    images: [image("png:a"), image("png:b"), image("png:c")],
  });
  scheduler.present(newest);
  clock.tick();

  const request = paints[1]!;
  expect(request.frame).not.toBe(newest);
  expect(request.frame?.images).toEqual([
    image("png:a", "AAAA"),
    // The most recently carried bytes win.
    image("png:b", "B2B2"),
    // Nothing carried for this id: left as received.
    image("png:c"),
  ]);
  expect(request.recoveredImagePayloadIds).toEqual(["png:a", "png:b"]);
  // The original frame is untouched.
  expect(newest.images?.[0]).toEqual(image("png:a"));
});

test("the newest frame's own payload is not overwritten by a carried one", () => {
  const clock = new ManualAnimationFrameScheduler();
  const { scheduler, paints } = makeScheduler(clock);
  scheduler.present(frame({ gen: 1, images: [image("png:a", "OLD")] }));
  const newest = frame({ gen: 2, images: [image("png:a", "NEW")] });
  scheduler.present(newest);
  clock.tick();
  expect(paints[0]!.frame).toBe(newest);
});

test("a repaint request reuses the painted frame's identity and carries no announcements", () => {
  const clock = new ManualAnimationFrameScheduler();
  const { scheduler, paints } = makeScheduler(clock);
  const painted = frame({
    gen: 1,
    accessibilityAnnouncements: [{ message: "once", politeness: "polite" }],
  });
  scheduler.present(painted);
  clock.tick();
  expect(paints[0]!.accessibilityAnnouncements).toHaveLength(1);

  scheduler.requestRepaint();
  scheduler.requestRepaint();
  expect(clock.scheduled).toBe(1);
  clock.tick();
  expect(paints).toHaveLength(2);
  expect(paints[1]!.frame).toBe(painted);
  expect(paints[1]!.damage).toBeUndefined();
  expect(paints[1]!.accessibilityAnnouncements).toEqual([]);
  expect(paints[1]!.coalescedFrameCount).toBe(0);
  expect(scheduler.statistics.coalescedFrames).toBe(0);
});

test("a repaint request folds into a pending paint and promotes it to full", () => {
  const clock = new ManualAnimationFrameScheduler();
  const { scheduler, paints } = makeScheduler(clock);
  scheduler.present(frame({ gen: 1 }));
  clock.tick();
  scheduler.present(frame({ gen: 2, damage: damage([[0, [[0, 1]]]]) }));
  scheduler.requestRepaint();
  scheduler.present(frame({ gen: 3, damage: damage([[1, [[0, 1]]]]) }));
  clock.tick();
  expect(paints).toHaveLength(2);
  expect(paints[1]!.damage).toBeUndefined();
  expect(paints[1]!.frame?.gen).toBe(3);
});

test("a repaint before any frame clears the surface", () => {
  const clock = new ManualAnimationFrameScheduler();
  const { scheduler, paints } = makeScheduler(clock);
  scheduler.requestRepaint();
  clock.tick();
  expect(paints).toEqual([
    {
      frame: undefined,
      damage: undefined,
      recoveredImagePayloadIds: [],
      accessibilityAnnouncements: [],
      coalescedFrameCount: 0,
    },
  ]);

  // The first real frame afterwards is still a full paint of that frame.
  const first = frame({ gen: 1, damage: damage([[0, [[0, 1]]]]) });
  scheduler.present(first);
  clock.tick();
  expect(paints[1]!.frame).toBe(first);
  expect(paints[1]!.damage).toBeUndefined();
  expect(paints[1]!.coalescedFrameCount).toBe(0);
});

test("repaintNow cancels the scheduled callback and paints synchronously", () => {
  const clock = new ManualAnimationFrameScheduler();
  const { scheduler, paints } = makeScheduler(clock);
  scheduler.present(frame({ gen: 1 }));
  clock.tick();
  const pending = frame({ gen: 2, damage: damage([[0, [[0, 1]]]]) });
  scheduler.present(pending);
  expect(clock.scheduled).toBe(1);

  scheduler.repaintNow();
  expect(clock.cancels).toBe(1);
  expect(clock.scheduled).toBe(0);
  expect(paints).toHaveLength(2);
  expect(paints[1]!.frame).toBe(pending);
  expect(paints[1]!.damage).toBeUndefined();

  clock.tick();
  expect(paints).toHaveLength(2);
  expect(scheduler.statistics.pending).toBe(false);
});

test("flush with nothing pending paints nothing", () => {
  const clock = new ManualAnimationFrameScheduler();
  const { scheduler, paints } = makeScheduler(clock);
  scheduler.flush();
  expect(paints).toEqual([]);
  expect(clock.requests).toBe(0);
});

test("dispose cancels the pending callback and ignores later work", () => {
  const clock = new ManualAnimationFrameScheduler();
  const { scheduler, paints } = makeScheduler(clock);
  scheduler.present(frame({ gen: 1 }));
  expect(clock.scheduled).toBe(1);

  scheduler.dispose();
  expect(clock.cancels).toBe(1);
  expect(clock.scheduled).toBe(0);

  scheduler.present(frame({ gen: 2 }));
  scheduler.requestRepaint();
  scheduler.repaintNow();
  scheduler.flush();
  clock.tick();
  expect(paints).toEqual([]);
  expect(clock.requests).toBe(1);
  expect(scheduler.statistics.pending).toBe(false);
});

test("a callback that fires after dispose paints nothing", () => {
  // Some hosts deliver an already-dispatched callback despite cancellation.
  const callbacks: Array<(time: number) => void> = [];
  const { scheduler, paints } = makeScheduler({
    requestAnimationFrame: (callback) => {
      callbacks.push(callback);
      return callbacks.length;
    },
    cancelAnimationFrame: () => {},
  });
  scheduler.present(frame({ gen: 1 }));
  scheduler.dispose();
  for (const callback of callbacks) {
    callback(16);
  }
  expect(paints).toEqual([]);
});

test("without animation frames every presented frame paints synchronously", () => {
  const { scheduler, paints } = makeScheduler(undefined);
  expect(scheduler.batchesPaints).toBe(false);

  const first = frame({ gen: 1, damage: damage([[0, [[0, 1]]]]) });
  scheduler.present(first);
  expect(paints).toHaveLength(1);
  expect(paints[0]!.frame).toBe(first);
  expect(paints[0]!.damage).toBeUndefined();

  const second = frame({
    gen: 2,
    damage: damage([[1, [[0, 1]]]]),
    accessibilityAnnouncements: [{ message: "two", politeness: "polite" }],
  });
  scheduler.present(second, ["png:x"]);
  expect(paints).toHaveLength(2);
  expect(paints[1]).toEqual({
    frame: second,
    damage: second.damage,
    recoveredImagePayloadIds: ["png:x"],
    accessibilityAnnouncements: second.accessibilityAnnouncements!,
    coalescedFrameCount: 0,
  });

  scheduler.requestRepaint();
  expect(paints).toHaveLength(3);
  expect(paints[2]!.frame).toBe(second);
  expect(scheduler.statistics).toEqual({
    presentedFrames: 2,
    paints: 3,
    coalescedFrames: 0,
    pending: false,
  });
});
