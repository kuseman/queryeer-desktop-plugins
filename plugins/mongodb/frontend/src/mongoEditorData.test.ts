import { afterEach, describe, expect, it, vi } from "vitest";
import { settled } from "./mongoEditorData.js";
import { clearExplorerCache, type Loadable } from "./MongoExplorer.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("settled", () => {
  it("returns a value that isn't loading straight away", async () => {
    expect(await settled(() => ({ status: "loaded", items: ["a"] }))).toEqual({ status: "loaded", items: ["a"] });
  });

  it("waits for the explorer to finish loading", async () => {
    let value: Loadable<string> = { status: "loading" };
    const result = settled(() => value);

    value = { status: "loaded", items: ["orders"] };
    // Any explorer change notifies its listeners
    clearExplorerCache();

    expect(await result).toEqual({ status: "loaded", items: ["orders"] });
  });

  it("gives up after a while, so completion offers what it has", async () => {
    vi.useFakeTimers();
    const result = settled(() => ({ status: "loading" }), 3000);

    await vi.advanceTimersByTimeAsync(3000);

    expect(await result).toEqual({ status: "loading" });
  });
});
