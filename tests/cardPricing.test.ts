import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  buildCardQuery,
  clearCardPriceCache,
  detectGrade,
  isTradingCard,
  lookupCardPrice,
  parseCardTitle,
  priceFieldForGrade,
  scoreCardMatch,
} from "@/lib/cardPricing";
import type { ListingResult } from "@/lib/types";

const WEMBY_TITLE = "2023-24 Panini Silver Prizm Victor Wembanyama 1/99 #25 RC";

const card = (over: Partial<ListingResult> = {}): ListingResult => ({
  title: WEMBY_TITLE,
  description: "",
  category: "trading_card",
  ...over,
});

// PriceCharting products as /api/products returns them (prices in pennies).
const silver = {
  id: "7001",
  "product-name": "Victor Wembanyama [Silver /99] #25",
  "console-name": "Basketball Cards 2023 Panini Prizm",
  "loose-price": 125000,
  "graded-price": 180000,
  "manual-only-price": 450000,
};
const base = {
  id: "7000",
  "product-name": "Victor Wembanyama #25",
  "console-name": "Basketball Cards 2023 Panini Prizm",
  "loose-price": 4500,
};
const gold = {
  id: "7002",
  "product-name": "Victor Wembanyama [Gold /10] #25",
  "console-name": "Basketball Cards 2023 Panini Prizm",
  "loose-price": 900000,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  clearCardPriceCache();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isTradingCard", () => {
  test("trading_card category and card category ids qualify", () => {
    expect(isTradingCard(card())).toBe(true);
    expect(isTradingCard(card({ category: "other", category_id: "261328" }))).toBe(true);
  });

  test("card-ish item types under collectible categories qualify", () => {
    expect(
      isTradingCard(card({ category: "sports_memorabilia", item_type: "Basketball Card" }))
    ).toBe(true);
  });

  test("household goods and non-trading cards do not", () => {
    expect(isTradingCard({ title: "KitchenAid Stand Mixer", description: "", category: "small_appliance" })).toBe(false);
    expect(
      isTradingCard({ title: "Hallmark Birthday Card", description: "", category: "other", item_type: "Greeting Card" })
    ).toBe(false);
    // A card-ish item_type doesn't pull a household category onto the card path.
    expect(
      isTradingCard({ title: "Card table", description: "", category: "home_decor", item_type: "sports card table" })
    ).toBe(false);
  });
});

describe("detectGrade / priceFieldForGrade", () => {
  test("ungraded by default", () => {
    const g = detectGrade(card());
    expect(g.label).toBe("Ungraded");
    expect(priceFieldForGrade(g)).toBe("loose-price");
  });

  test("reads grades from the title", () => {
    expect(detectGrade(card({ title: `${WEMBY_TITLE} PSA 10` })).label).toBe("PSA 10");
    expect(priceFieldForGrade(detectGrade(card({ title: "x PSA 10" })))).toBe("manual-only-price");
    expect(priceFieldForGrade(detectGrade(card({ title: "x BGS 9.5" })))).toBe("box-only-price");
    expect(priceFieldForGrade(detectGrade(card({ title: "x BGS 10" })))).toBe("bgs-10-price");
    expect(priceFieldForGrade(detectGrade(card({ title: "x SGC 10" })))).toBe("condition-18-price");
    expect(priceFieldForGrade(detectGrade(card({ title: "x PSA 9" })))).toBe("graded-price");
    expect(priceFieldForGrade(detectGrade(card({ title: "x PSA 8" })))).toBe("new-price");
  });

  test("reads grades from item specifics", () => {
    const g = detectGrade(
      card({ item_specifics: { "Professional Grader": "Professional Sports Authenticator (PSA)", Grade: "9" } })
    );
    expect(g.label).toBe("PSA 9");
  });

  test("low grades have no tracked price field", () => {
    expect(priceFieldForGrade(detectGrade(card({ title: "x PSA 5" })))).toBeNull();
  });
});

describe("parseCardTitle / buildCardQuery", () => {
  test("pulls year, serial, number, and identifying words", () => {
    const p = parseCardTitle(WEMBY_TITLE);
    expect(p.years).toEqual(["2023", "2024"]);
    expect(p.serial).toBe("99");
    expect(p.number).toBe("25");
    expect(p.words).toEqual(["panini", "silver", "prizm", "victor", "wembanyama"]);
  });

  test("query drops grade, serial, and filler", () => {
    expect(buildCardQuery(card({ title: `${WEMBY_TITLE} PSA 10` }))).toBe(
      "2023 panini silver prizm victor wembanyama #25"
    );
  });
});

describe("scoreCardMatch", () => {
  const parsed = parseCardTitle(WEMBY_TITLE);

  test("exact parallel scores above threshold", () => {
    expect(scoreCardMatch(parsed, silver)).toBeGreaterThanOrEqual(0.7);
  });

  test("base card is rejected for a parallel title", () => {
    expect(scoreCardMatch(parsed, base)).toBe(0);
  });

  test("different parallel or print run is rejected", () => {
    expect(scoreCardMatch(parsed, gold)).toBe(0);
  });

  test("different card number or year is rejected", () => {
    expect(scoreCardMatch(parsed, { ...silver, "product-name": "Victor Wembanyama [Silver /99] #136" })).toBe(0);
    expect(scoreCardMatch(parsed, { ...silver, "console-name": "Basketball Cards 2019 Panini Prizm" })).toBe(0);
  });

  test("different player is rejected", () => {
    expect(scoreCardMatch(parsed, { ...silver, "product-name": "Chet Holmgren [Silver /99] #25" })).toBe(0);
  });
});

describe("lookupCardPrice", () => {
  test("no token → low-confidence result without calling the API", async () => {
    const r = await lookupCardPrice(card(), undefined);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/token/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("confident match returns the ungraded price in dollars", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "success", products: [base, gold, silver] }));
    const r = await lookupCardPrice(card(), "tok");
    expect(r.ok).toBe(true);
    expect(r.price).toBe(1250);
    expect(r.match).toMatchObject({ id: "7001", grade: "Ungraded" });
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/api/products");
    expect(url.searchParams.get("t")).toBe("tok");
    expect(url.searchParams.get("q")).toBe("2023 panini silver prizm victor wembanyama #25");
  });

  test("uses the grade-specific price", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "success", products: [silver] }));
    const r = await lookupCardPrice(card({ title: `${WEMBY_TITLE} PSA 10` }), "tok");
    expect(r.price).toBe(4500);
    expect(r.match?.grade).toBe("PSA 10");
  });

  test("fetches the product when search results lack the price", async () => {
    const { "loose-price": _omit, ...noPrices } = silver;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ status: "success", products: [noPrices] }))
      .mockResolvedValueOnce(jsonResponse({ status: "success", ...silver }));
    const r = await lookupCardPrice(card(), "tok");
    expect(r.ok).toBe(true);
    expect(r.price).toBe(1250);
    const url = new URL(fetchMock.mock.calls[1][0] as string);
    expect(url.pathname).toBe("/api/product");
    expect(url.searchParams.get("id")).toBe("7001");
  });

  test("only the base card found → no confident match", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "success", products: [base] }));
    const r = await lookupCardPrice(card(), "tok");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/exact card/i);
  });

  test("no grade price → not ok", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "success", products: [silver] }));
    const r = await lookupCardPrice(card({ title: `${WEMBY_TITLE} BGS 10` }), "tok");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/BGS 10/);
  });

  test("empty results, API errors, HTTP errors, and network failures never throw", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "success", products: [] }));
    expect((await lookupCardPrice(card(), "tok")).ok).toBe(false);

    clearCardPriceCache();
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "error", "error-message": "Invalid token" }));
    expect((await lookupCardPrice(card(), "tok")).ok).toBe(false);

    clearCardPriceCache();
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));
    expect((await lookupCardPrice(card(), "tok")).ok).toBe(false);

    clearCardPriceCache();
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    const r = await lookupCardPrice(card(), "tok");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unavailable/i);
  });

  test("caches successful lookups", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "success", products: [silver] }));
    await lookupCardPrice(card(), "tok");
    await lookupCardPrice(card(), "tok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
