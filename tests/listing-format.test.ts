import { describe, expect, test } from "vitest";
import { buildOfferPricing } from "@/lib/ebay/publish";
import type { ListingResult } from "@/lib/types";

const listing = (over: Partial<ListingResult>): ListingResult => ({
  title: "2023-24 Panini Silver Prizm Victor Wembanyama 1/99 #25 RC",
  description: "",
  ...over,
});

describe("buildOfferPricing", () => {
  test("defaults to Buy It Now at the suggested price, to the cent", () => {
    expect(buildOfferPricing(listing({ suggested_price: 3.47 }))).toEqual({
      ok: true,
      format: "FIXED_PRICE",
      pricingSummary: { price: { value: "3.47", currency: "USD" } },
    });
    expect(buildOfferPricing(listing({ suggested_price: "12.5" }))).toMatchObject({
      pricingSummary: { price: { value: "12.50" } },
    });
  });

  test("Buy It Now with no price is blocked", () => {
    const r = buildOfferPricing(listing({ suggested_price: 0 }));
    expect(r.ok).toBe(false);
  });

  test("auction with starting bid, duration, and Buy It Now", () => {
    expect(
      buildOfferPricing(
        listing({
          listing_format: "AUCTION",
          auction_start_price: 0.99,
          auction_duration: "DAYS_3",
          suggested_price: 4.99,
        })
      )
    ).toEqual({
      ok: true,
      format: "AUCTION",
      listingDuration: "DAYS_3",
      pricingSummary: {
        auctionStartPrice: { value: "0.99", currency: "USD" },
        price: { value: "4.99", currency: "USD" },
      },
    });
  });

  test("auction without Buy It Now omits the price and defaults to 7 days", () => {
    const r = buildOfferPricing(
      listing({ listing_format: "AUCTION", auction_start_price: "1.5", suggested_price: "" })
    );
    expect(r).toEqual({
      ok: true,
      format: "AUCTION",
      listingDuration: "DAYS_7",
      pricingSummary: { auctionStartPrice: { value: "1.50", currency: "USD" } },
    });
  });

  test("auction needs a starting bid", () => {
    const r = buildOfferPricing(listing({ listing_format: "AUCTION", suggested_price: 10 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/starting bid/i);
  });

  test("Buy It Now must be at least 30% above the starting bid", () => {
    const tooLow = buildOfferPricing(
      listing({ listing_format: "AUCTION", auction_start_price: 10, suggested_price: 12.99 })
    );
    expect(tooLow.ok).toBe(false);
    if (!tooLow.ok) expect(tooLow.error).toMatch(/\$13\.00/);
    expect(
      buildOfferPricing(
        listing({ listing_format: "AUCTION", auction_start_price: 10, suggested_price: 13 })
      ).ok
    ).toBe(true);
  });

  test("unknown durations fall back to 7 days", () => {
    const r = buildOfferPricing(
      listing({
        listing_format: "AUCTION",
        auction_start_price: 1,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        auction_duration: "DAYS_30" as any,
      })
    );
    expect(r).toMatchObject({ ok: true, listingDuration: "DAYS_7" });
  });
});
