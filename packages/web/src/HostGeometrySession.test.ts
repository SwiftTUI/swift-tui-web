import { expect, test } from "bun:test";
import { HostGeometrySession } from "./HostGeometrySession.ts";
import type { WebHostSurfaceFrame } from "./WebHostSurfaceTransport.ts";

const geometry = {
  revision: 1,
  columns: 2,
  rows: 1,
  cellWidth: 10,
  cellHeight: 24,
};
const frame = (geometryRevision?: number): WebHostSurfaceFrame => ({
  version: 2,
  width: 2,
  height: 1,
  styles: [null],
  rows: [[]],
  geometryRevision,
});

test("legacy producers never receive geometry records and startup acknowledgement is not a presentation", () => {
  const session = new HostGeometrySession();
  session.request(geometry);
  session.observe(frame());
  expect(session.takeRequest()).toBeUndefined();
  expect(session.canPresent(frame())).toBe(true);
  session.observe(frame(0));
  expect(session.canPresent(frame(0))).toBe(false);
  expect(session.takeRequest()).toEqual(geometry);
  expect(session.takeRequest()).toBeUndefined();
  expect(session.canPresent({ ...frame(1), width: 3 })).toBe(false);
  session.didPresent(frame(1));
  expect(session.pointerRevision).toBe(1);
});

test("same-grid typography revisions coalesce, old responses never commit, and reconnect requires acknowledgement", () => {
  const session = new HostGeometrySession();
  session.observe(frame(0));
  session.request(geometry);
  session.takeRequest();
  session.didPresent(frame(1));
  session.request({ ...geometry, revision: 2, cellWidth: 11 });
  session.request({ ...geometry, revision: 3, cellWidth: 12 });
  expect(session.takeRequest()?.revision).toBe(3);
  expect(session.canPresent(frame(2))).toBe(false);
  expect(session.pointerRevision).toBe(1);
  expect(() => session.didPresent(frame(2))).toThrow();
  session.didPresent(frame(3));
  expect(session.pointerRevision).toBe(3);
  session.resetConnection();
  expect(session.takeRequest()).toBeUndefined();
  expect(session.pointerRevision).toBeUndefined();
  session.observe(frame(0));
  expect(session.takeRequest()?.revision).toBe(3);
  expect(() => session.request(geometry)).toThrow(RangeError);
  expect(() => session.request({ ...geometry, revision: 3 })).toThrow(
    RangeError,
  );
});

test("reconnect cannot send an old producer a prior paragraph extension", () => {
  const session = new HostGeometrySession();
  session.observe(frame(0));
  session.request({ ...geometry, paragraphSpacing: 2 });
  expect(session.takeRequest()?.paragraphSpacing).toBe(2);
  session.didPresent(frame(1));
  session.resetConnection();
  session.observe(frame(0));
  expect(session.takeRequest()).toBeUndefined();
  expect(session.canPresent(frame(1))).toBe(false);
  session.request({ ...geometry, revision: 2 });
  expect(session.takeRequest()?.paragraphSpacing).toBeUndefined();
  expect(session.canPresent(frame(2))).toBe(true);
});

test("a shared viewport can constrain the requested grid and retains its independent pointer revision", () => {
  const session = new HostGeometrySession();
  session.observe(frame(0));
  session.request({ ...geometry, columns: 120, rows: 40 });
  session.takeRequest();
  const shared = { ...frame(1), width: 80, height: 24, viewportRevision: 5 };
  expect(session.canPresent(shared)).toBe(true);
  expect(session.canPresent({ ...shared, width: 121 })).toBe(false);
  expect(session.canPresent({ ...shared, geometryRevision: 2 })).toBe(false);
  expect(session.canPresent({ ...shared, viewportRevision: undefined })).toBe(
    false,
  );
  session.didPresent(shared);
  expect(session.pointerViewportRevision).toBe(5);
  session.didPresent({ ...shared, width: 70, viewportRevision: 6 });
  expect(session.pointerViewportRevision).toBe(6);
  session.resetConnection();
  expect(session.pointerViewportRevision).toBeUndefined();
});
