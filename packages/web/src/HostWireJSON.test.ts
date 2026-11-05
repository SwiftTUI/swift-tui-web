import { describe, expect, test } from "bun:test";
import {
  admitsWireJSON,
  checkWireJSON,
  WireJSONAdmission,
} from "./HostWireJSON.ts";

describe("host JSON admission", () => {
  test("compact key identities preserve length, NULs and escaped spellings", () => {
    const admission = new WireJSONAdmission();
    for (const keys of [
      ["", "\0", "\0\0"],
      ["a", "\0a", "a\0", "aaa"],
      ["😀", "\ud83d", "\ude00"],
      ["1", "01", "001"],
    ]) {
      const fields = keys.map((key) => `${JSON.stringify(key)}:0`).join(",");
      expect(admission.check(`{${fields}}`)).toBe("admitted");
      expect(admission.check(`{${fields},${JSON.stringify(keys[0])}:1}`)).toBe(
        "ambiguous",
      );
    }
    expect(admission.check('{"ab":1,"\\u0061b":2}')).toBe("ambiguous");
    expect(admission.check('{"a\\u0000":1,"\\u0061\\u0000":2}')).toBe(
      "ambiguous",
    );
  });
  test("record offsets preserve duplicate, depth and number admission", () => {
    const prefix = "\x1esurface:";
    for (const text of [
      '{"a":1}',
      '{"a":1,"\\u0061":2}',
      '{"a":{"b":1e999}}',
      "[".repeat(33) + "0" + "]".repeat(33),
    ])
      expect(checkWireJSON(prefix + text, prefix.length)).toBe(
        checkWireJSON(text),
      );
    for (const offset of [-1, 0.5, 100, Number.NaN])
      expect(checkWireJSON("{}", offset)).toBe("ambiguous");
  });
  test("duplicate keys include escaped aliases at every object depth", () => {
    for (const text of [
      '{"width":1,"width":2}',
      '{"width":1,"\\u0077idth":2}',
      '{"\\u0077idth":1,"width":2}',
      '{"😀":1,"\\uD83D\\uDE00":2}',
      '{"a":[{"k":"v","k":"w"}]}',
      '{"\\n":1,"\\u000a":2}',
    ])
      expect(admitsWireJSON(text)).toBe(false);
    expect(admitsWireJSON('{"a":{"x":1},"b":{"x":2}}')).toBe(true);
    expect(admitsWireJSON('{"a":"\\"x\\":1","b":2}')).toBe(true);
  });
  test("sibling scopes release keys without forgetting parents or large vocabularies", () => {
    const keys = Array.from({ length: 40 }, (_, i) => `"key${i}":${i}`).join(
      ",",
    );
    expect(admitsWireJSON(`{"large":{${keys}},"small":{"key0":1}}`)).toBe(true);
    expect(admitsWireJSON(`{"large":{${keys},"key0":99}}`)).toBe(false);
    expect(admitsWireJSON(`{"large":{${keys},"\\u006bey0":99}}`)).toBe(false);
    expect(admitsWireJSON(`{"large":{"\\u0078":0,${keys},"x":99}}`)).toBe(
      false,
    );
    expect(
      admitsWireJSON('{"parent":1,"children":[{"a":1},{"a":2}],"parent":3}'),
    ).toBe(false);
    expect(admitsWireJSON('{"children":[{"a":1},{"b":2,"a":3}],"a":4}')).toBe(
      true,
    );
  });
  test("rejected records release reusable key scopes", () => {
    const admission = new WireJSONAdmission();
    for (let i = 0; i < 40; i++) {
      expect(admission.check('{"parent":1,"nested":{"a":1,"a":2}}')).toBe(
        "ambiguous",
      );
      expect(admission.check('{"parent":1,"nested":{"a":1}}')).toBe("admitted");
    }
  });
  test("key slots do not become members of the next object", () => {
    const long = "x".repeat(1024);
    for (const text of [
      '{"a":1,"b":2}',
      '{"b":1}',
      '{"b":1,"a":2}',
      `{"${long}":1}`,
      '{"":1}',
      '{"a":1}',
      '{"a":{"x":1,"y":2},"b":{"y":3}}',
    ])
      expect(admitsWireJSON(text)).toBe(true);
    expect(admitsWireJSON('{"a":1,"a":2}')).toBe(false);
  });
  test("overflow in ignored fields is rejected before materialization", () => {
    for (const value of ["1e309", "-1e309", "9".repeat(400)])
      expect(admitsWireJSON(`{"future":${value}}`)).toBe(false);
    for (const value of ["1e308", "1e-999", "-0", "1.25"])
      expect(admitsWireJSON(`{"future":${value}}`)).toBe(true);
    expect(admitsWireJSON('{"future":"1e999"}')).toBe(true);
  });
  test("similar key names compare complete decoded spellings", () => {
    expect(admitsWireJSON('{"axz":1,"ayz":2}')).toBe(true);
    expect(admitsWireJSON('{"axz":1,"ayz":2,"ayz":3}')).toBe(false);
    expect(admitsWireJSON('{"axz":1,"ayz":2,"\\u0061xz":3}')).toBe(false);
    expect(admitsWireJSON('{"axz":1,"ayz":2,"nested":{"ayz":3},"axz":4}')).toBe(
      false,
    );
  });
  test("depth includes arrays and ignores quoted brackets", () => {
    expect(admitsWireJSON("[".repeat(32) + '"[{"' + "]".repeat(32))).toBe(true);
    expect(admitsWireJSON("[".repeat(33) + "0" + "]".repeat(33))).toBe(false);
  });
});
