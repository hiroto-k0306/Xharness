import { afterEach, expect, it, vi } from "vitest";
import { phaseTimer } from "./phase-timer.js";
afterEach(() => vi.useRealTimers());
it("charges elapsed time once for eight concurrent approval waits", () => {
  vi.useFakeTimers();
  const expire = vi.fn(),
    timer = phaseTimer(120000, expire);
  vi.advanceTimersByTime(10000);
  for (let i = 0; i < 8; i++) timer.pause();
  vi.advanceTimersByTime(300000);
  for (let i = 0; i < 7; i++) timer.resume();
  vi.advanceTimersByTime(300000);
  expect(expire).not.toHaveBeenCalled();
  timer.resume();
  vi.advanceTimersByTime(109999);
  expect(expire).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(expire).toHaveBeenCalledTimes(1);
  timer.close();
});
it.each(["denied", "cancelled", "expired", "automatic"])(
  "does not arm a timer on late %s approval after phase closure",
  () => {
    vi.useFakeTimers();
    const expire = vi.fn(),
      timer = phaseTimer(1000, expire);
    timer.pause();
    timer.pause();
    timer.close();
    timer.resume();
    timer.resume();
    timer.pause();
    timer.resume();
    vi.advanceTimersByTime(10000);
    expect(expire).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);
it("preserves the remaining budget across successive waits and ignores extra resumes", () => {
  vi.useFakeTimers();
  const expire = vi.fn(),
    timer = phaseTimer(1000, expire);
  vi.advanceTimersByTime(200);
  timer.pause();
  vi.advanceTimersByTime(10000);
  timer.resume();
  timer.resume();
  vi.advanceTimersByTime(300);
  timer.pause();
  vi.advanceTimersByTime(10000);
  timer.resume();
  vi.advanceTimersByTime(499);
  expect(expire).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(expire).toHaveBeenCalledTimes(1);
  timer.close();
});
