import { describe, expect, test } from "bun:test";
import { admitsWireJSON } from "./HostWireJSON.ts";

describe("host JSON admission", () => {
  test("duplicate keys include escaped aliases at every object depth", () => {
    for (const text of [
      '{"width":1,"width":2}',
      '{"width":1,"\\u0077idth":2}',
      '{"a":[{"k":"v","k":"w"}]}',
      '{"\\n":1,"\\u000a":2}',
    ])
      expect(admitsWireJSON(text)).toBe(false);
    expect(admitsWireJSON('{"a":{"x":1},"b":{"x":2}}')).toBe(true);
    expect(admitsWireJSON('{"a":"\\"x\\":1","b":2}')).toBe(true);
  });
  test("overflow in ignored fields is rejected before materialization", () => {
    for (const value of ["1e309", "-1e309", "9".repeat(400)])
      expect(admitsWireJSON(`{"future":${value}}`)).toBe(false);
    for (const value of ["1e308", "1e-999", "-0", "1.25"])
      expect(admitsWireJSON(`{"future":${value}}`)).toBe(true);
    expect(admitsWireJSON('{"future":"1e999"}')).toBe(true);
  });
  test("depth includes arrays and ignores quoted brackets", () => {
    expect(admitsWireJSON("[".repeat(32) + '"[{"' + "]".repeat(32))).toBe(true);
    expect(admitsWireJSON("[".repeat(33) + "0" + "]".repeat(33))).toBe(false);
  });
});
