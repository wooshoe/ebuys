import { describe, expect, test } from "vitest";
import { applyCardDefaults } from "@/lib/cardMode";

describe("applyCardDefaults", () => {
  test("sets Auction and New without tags, keeping the rest of the listing", () => {
    const out = applyCardDefaults({
      title: "2023-24 Panini Prizm Victor Wembanyama #136 RC",
      description: "d",
      condition: "EXCELLENT",
      suggested_price: 12.5,
    });
    expect(out).toMatchObject({
      title: "2023-24 Panini Prizm Victor Wembanyama #136 RC",
      description: "d",
      suggested_price: 12.5,
      condition: "NEW_NO_TAGS",
      listing_format: "AUCTION",
      auction_start_price: 0.99,
      auction_duration: "DAYS_7",
    });
  });
});
