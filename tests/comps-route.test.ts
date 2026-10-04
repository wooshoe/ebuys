import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CompsSummary, ListingResult } from "@/lib/types";

// The route's eBay dependencies are mocked; PriceCharting goes through a
// stubbed global fetch so the real card-pricing module runs.
const searchComps = vi.fn();
vi.mock("@/lib/api-guard", () => ({ guardApiRequest: () => null }));
vi.mock("@/lib/ebay/config", () => ({ isEbayConfigured: () => true }));
vi.mock("@/lib/ebay/taxonomy", () => ({ appToken: async () => "app-token" }));
vi.mock("@/lib/ebay/comps", () => ({ searchComps: (...a: unknown[]) => searchComps(...a) }));

const { POST } = await import("@/app/api/ebay/comps/route");
const { clearCardPriceCache } = await import("@/lib/cardPricing");

const activeComps: CompsSummary = {
  ok: true,
  query: "Panini Trading Card",
  count: 20,
  median: 40,
  low: 10,
  high: 90,
  confidence: 0.5,
  basis: "20 active listings",
};

const silver = {
  id: "7001",
  "product-name": "Victor Wembanyama [Silver /99] #25",
  "console-name": "Basketball Cards 2023 Panini Prizm",
  "loose-price": 125000,
};

const cardListing: ListingResult = {
  title: "2023-24 Panini Silver Prizm Victor Wembanyama 1/99 #25 RC",
  description: "",
  category: "trading_card",
};

async function post(listing: ListingResult) {
  const req = new Request("http://localhost/api/ebay/comps", {
    method: "POST",
    body: JSON.stringify({ listing }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await POST(req as any);
  return (await res.json()) as { ok: boolean; comps?: CompsSummary };
}

const fetchMock = vi.fn();

beforeEach(() => {
  clearCardPriceCache();
  fetchMock.mockReset();
  searchComps.mockReset().mockResolvedValue(activeComps);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("PRICECHARTING_API_TOKEN", "tok");
  vi.stubEnv("PRICE_MARKUP_PERCENT", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("POST /api/ebay/comps", () => {
  test("household items keep the existing comps path and never hit PriceCharting", async () => {
    vi.stubEnv("PRICE_MARKUP_PERCENT", "40");
    const d = await post({ title: "KitchenAid Stand Mixer", description: "", category: "small_appliance" });
    expect(d.comps).toEqual({ ...activeComps, listPrice: 56 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("confident card match → PriceCharting summary with markup", async () => {
    vi.stubEnv("PRICE_MARKUP_PERCENT", "40");
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "success", products: [silver] }))
    );
    const d = await post(cardListing);
    expect(d.ok).toBe(true);
    expect(d.comps).toMatchObject({
      ok: true,
      source: "pricecharting",
      median: 1250,
      listPrice: 1750,
      cardMatch: { id: "7001", grade: "Ungraded" },
    });
    expect(d.comps?.lowConfidence).toBeUndefined();
    expect(searchComps).not.toHaveBeenCalled();
  });

  test("missing token → active-comps fallback flagged low-confidence", async () => {
    vi.stubEnv("PRICECHARTING_API_TOKEN", "");
    const d = await post(cardListing);
    expect(d.ok).toBe(true);
    expect(d.comps).toMatchObject({
      ...activeComps,
      source: "ebay_active",
      lowConfidence: true,
    });
    expect(d.comps?.lowConfidenceReason).toMatch(/token/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("PriceCharting failure and comps failure still respond without throwing", async () => {
    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    searchComps.mockRejectedValueOnce(new Error("eBay down"));
    const d = await post(cardListing);
    expect(d.ok).toBe(true);
    expect(d.comps).toMatchObject({ ok: false, lowConfidence: true, source: "ebay_active" });
  });
});
