import { describe, expect, it } from "vitest";
import { createTokenCounter } from "../proxy/token-counter.js";

describe("createTokenCounter", () => {
  it("accumulates tokens saved", () => {
    const counter = createTokenCounter({ emitEveryN: 100 });
    counter.record(500, 1000);
    counter.record(300, 800);

    expect(counter.getTotalSaved()).toBe(800);
    expect(counter.getTotalProcessed()).toBe(1800);
    expect(counter.getCallCount()).toBe(2);
  });

  it("emits to sink every N calls", () => {
    const messages: string[] = [];
    const counter = createTokenCounter({
      emitEveryN: 3,
      sink: (msg) => messages.push(msg),
    });

    counter.record(100, 200);
    counter.record(100, 200);
    expect(messages).toHaveLength(0);

    counter.record(100, 200);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("tokens saved");
    expect(messages[0]).toContain("efficiency");
  });

  it("formats large token counts with K/M suffixes", () => {
    const messages: string[] = [];
    const counter = createTokenCounter({
      emitEveryN: 1,
      sink: (msg) => messages.push(msg),
    });

    counter.record(23_400, 50_000);
    expect(messages[0]).toContain("23.4K");
  });

  it("calculates efficiency correctly", () => {
    const counter = createTokenCounter({ emitEveryN: 100 });
    counter.record(500, 1000);
    expect(counter.getEfficiency()).toBe(50);
  });

  it("handles zero processed tokens", () => {
    const counter = createTokenCounter({ emitEveryN: 100 });
    expect(counter.getEfficiency()).toBe(0);
  });

  it("emits at exactly the Nth call", () => {
    const messages: string[] = [];
    const counter = createTokenCounter({
      emitEveryN: 10,
      sink: (msg) => messages.push(msg),
    });

    for (let i = 0; i < 9; i++) {
      counter.record(10, 100);
    }
    expect(messages).toHaveLength(0);

    counter.record(10, 100);
    expect(messages).toHaveLength(1);
  });

  it("emits again at 2N calls", () => {
    const messages: string[] = [];
    const counter = createTokenCounter({
      emitEveryN: 5,
      sink: (msg) => messages.push(msg),
    });

    for (let i = 0; i < 10; i++) {
      counter.record(10, 100);
    }
    expect(messages).toHaveLength(2);
  });

  it("reset clears all state", () => {
    const counter = createTokenCounter({ emitEveryN: 100 });
    counter.record(500, 1000);
    counter.reset();

    expect(counter.getTotalSaved()).toBe(0);
    expect(counter.getTotalProcessed()).toBe(0);
    expect(counter.getCallCount()).toBe(0);
  });

  it("defaults to emitEveryN=10", () => {
    const messages: string[] = [];
    const counter = createTokenCounter({
      sink: (msg) => messages.push(msg),
    });

    for (let i = 0; i < 10; i++) {
      counter.record(10, 100);
    }
    expect(messages).toHaveLength(1);
  });
});
