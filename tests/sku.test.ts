import { describe, expect, test } from "vitest";
import { autoSku, buildSku, sanitizeSku } from "@/lib/sku";

describe("buildSku", () => {
  test("bin code → lettered SKUs", () => {
    expect(buildSku("K75", 0)).toBe("K75-A");
    expect(buildSku("K75", 26)).toBe("K75-AA");
  });

  test("no bin code → blank SKU, like eBay's default", () => {
    expect(buildSku("", 0)).toBe("");
    expect(buildSku("   ", 3)).toBe("");
  });
});

describe("autoSku", () => {
  test("is a valid, unique-per-call eBay SKU", () => {
    const a = autoSku(1_790_000_000_000, 0.1);
    const b = autoSku(1_790_000_000_000, 0.2);
    expect(a).toMatch(/^ITEM-[0-9A-Z]+$/);
    expect(sanitizeSku(a)).toBe(a);
    expect(a.length).toBeLessThanOrEqual(50);
    expect(a).not.toBe(b);
    expect(autoSku(1_790_000_000_001, 0.1)).not.toBe(a);
  });
});
