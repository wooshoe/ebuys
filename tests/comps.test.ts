import { describe, expect, test } from "vitest";
import { buildCompQuery, compStats, filterComps, isTradingCard } from "@/lib/ebay/comps";
import type { ListingResult } from "@/lib/types";

const listing = (over: Partial<ListingResult>): ListingResult => ({
  title: "Ralph Lauren Wool Sweater Blue Men's L",
  description: "",
  ...over,
});

describe("buildCompQuery", () => {
  test("prefers brand + item type", () => {
    expect(
      buildCompQuery(listing({ brand: "Ralph Lauren", item_type: "Cable Knit Sweater" }))
    ).toBe("Ralph Lauren Cable Knit Sweater");
  });
  test("ignores No Brand and falls back to the first title words", () => {
    expect(buildCompQuery(listing({ brand: "No Brand" }))).toBe(
      "Ralph Lauren Wool Sweater Blue Men's"
    );
  });
});

describe("trading cards", () => {
  const card = listing({
    title: "2023-24 Panini Silver Prizm Victor Wembanyama 1/99 #25 RC 🔥",
    brand: "Panini",
    item_type: "Trading Card",
    category: "trading_card",
  });

  test("isTradingCard: card categories yes, household goods no", () => {
    expect(isTradingCard(card)).toBe(true);
    expect(isTradingCard(listing({ category: "other", category_id: "261328" }))).toBe(true);
    expect(
      isTradingCard(listing({ category: "sports_memorabilia", item_type: "Basketball Card" }))
    ).toBe(true);
    expect(isTradingCard(listing({ category: "kitchenware", item_type: "Mixing Bowl" }))).toBe(false);
    expect(isTradingCard(listing({ category: "other", item_type: "Greeting Card" }))).toBe(false);
  });

  test("cards search by title (set, parallel, number, print run), minus hype", () => {
    expect(buildCompQuery(card)).toBe("2023-24 Panini Silver Prizm Victor Wembanyama 1/99 #25");
  });

  test("grade stays in the card query", () => {
    expect(buildCompQuery({ ...card, title: "2018 Topps Update Shohei Ohtani #US1 PSA 10" })).toBe(
      "2018 Topps Update Shohei Ohtani #US1 PSA 10"
    );
  });

  test("household goods keep the brand + item type query", () => {
    expect(
      buildCompQuery(listing({ brand: "KitchenAid", item_type: "Stand Mixer", category: "small_appliance" }))
    ).toBe("KitchenAid Stand Mixer");
  });

  test("card comps ignore the new/used condition split", () => {
    const items = [
      { title: "Wemby Silver /99", price: { value: "1200", currency: "USD" }, conditionId: "4000" },
      { title: "Wemby Silver /99 PSA 10", price: { value: "4500", currency: "USD" }, conditionId: "2750" },
    ];
    expect(filterComps(items, "EXCELLENT", true)).toEqual([1200, 4500]);
  });
});

describe("filterComps", () => {
  const item = (title: string, price: number, conditionId?: string) => ({
    title,
    price: { value: String(price), currency: "USD" },
    conditionId,
  });

  test("excludes lots, parts, and reproductions", () => {
    const prices = filterComps(
      [
        item("Ralph Lauren Sweater", 40),
        item("Lot of 5 Ralph Lauren Sweaters", 120),
        item("Ralph Lauren Sweater for parts", 5),
        item("Reproduction Ralph Lauren style Sweater", 15),
      ],
      "EXCELLENT"
    );
    expect(prices).toEqual([40]);
  });

  test("dimension titles are NOT mistaken for lots", () => {
    const prices = filterComps(
      [item("Framed Watercolor 16 x 20 Landscape", 45)],
      "EXCELLENT"
    );
    expect(prices).toEqual([45]);
  });

  test("excludes wrong-condition comps when condition ids are present", () => {
    const prices = filterComps(
      [item("Sweater", 40, "3000"), item("Sweater NWT", 90, "1000")],
      "EXCELLENT"
    );
    expect(prices).toEqual([40]);
  });

  test("keeps new comps for new items", () => {
    const prices = filterComps(
      [item("Sweater", 40, "3000"), item("Sweater NWT", 90, "1000")],
      "NEW_WITH_TAGS"
    );
    expect(prices).toEqual([90]);
  });
});

describe("compStats", () => {
  test("empty prices → zero confidence and no median", () => {
    const s = compStats([]);
    expect(s.count).toBe(0);
    expect(s.confidence).toBe(0);
    expect(s.median).toBeUndefined();
  });

  test("computes a sane median and band", () => {
    const s = compStats([48, 52, 55, 60, 62, 64, 70, 74, 80, 85, 90, 95]);
    expect(s.count).toBe(12);
    expect(s.median).toBeGreaterThan(60);
    expect(s.median).toBeLessThan(70);
    expect(s.low).toBeLessThan(s.median!);
    expect(s.high).toBeGreaterThan(s.median!);
    expect(s.confidence).toBeGreaterThan(0.5);
  });

  test("wildly dispersed comps lower confidence", () => {
    const tight = compStats([50, 52, 54, 55, 56, 58, 60, 61, 62, 63, 64, 65]);
    const loose = compStats([5, 20, 45, 55, 90, 150, 300, 12, 75, 33, 210, 400]);
    expect(loose.confidence).toBeLessThan(tight.confidence);
  });
});
