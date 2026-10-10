import "@testing-library/jest-dom";

// jsdom has no ResizeObserver, which Recharts' <ResponsiveContainer> needs in order to measure its
// parent. Every real browser provides it; this no-op stand-in only keeps chart components renderable
// in tests (jsdom has no layout, so charts draw nothing — tests assert on the data and text instead).
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
