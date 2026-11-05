import { expect, test } from "bun:test";
import { AccessibilityRequests } from "./AccessibilityRequests.ts";

test("only the exact outstanding ID and target can settle a request", () => {
  const requests = new AccessibilityRequests();
  const a = requests.issue("a");
  const b = requests.issue("b");
  for (const requestID of [
    "18446744073709551615",
    "18446744073709551616",
    "",
    "+1",
  ])
    expect(requests.settle({ requestID, target: "a" })).toBe(false);
  expect(requests.settle({ requestID: String(a), target: "b" })).toBe(false);
  expect(requests.has(a)).toBe(true);
  expect(requests.settle({ requestID: String(b), target: "b" })).toBe(true);
  expect(requests.has(a)).toBe(true);
  expect(requests.settle({ requestID: String(b), target: "b" })).toBe(false);
  expect(requests.settle({ requestID: "0001", target: "a" })).toBe(true);
});

test("reset, disappeared targets, expiration and retention bounds retire pending requests", () => {
  let now = 0;
  const requests = new AccessibilityRequests(() => now);
  const old = requests.issue("a");
  requests.reset();
  const current = requests.issue("a");
  expect(current).not.toBe(old);
  expect(requests.settle({ requestID: String(old), target: "a" })).toBe(false);
  expect(requests.has(current)).toBe(true);
  requests.retainTargets(new Set(["b"]));
  expect(requests.has(current)).toBe(false);
  const expired = requests.issue("a");
  now = 30_000;
  expect(requests.settle({ requestID: String(expired), target: "a" })).toBe(
    false,
  );
  const oldest = requests.issue("a");
  let latest = oldest;
  for (let i = 0; i < 256; ++i) latest = requests.issue("a");
  expect(requests.has(oldest)).toBe(false);
  expect(requests.has(latest)).toBe(true);
});
