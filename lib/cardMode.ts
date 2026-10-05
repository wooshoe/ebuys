// "Card" batch mode, chosen on the upload page. Every listing written in
// that batch starts as an auction in New-without-tags condition; the seller
// can still change both on each listing card.

import type { ListingResult } from "@/lib/types";

export const CARD_MODE_PROFILE = "collectibles";
export const CARD_AUCTION_START = 0.99;

export function applyCardDefaults(listing: ListingResult): ListingResult {
  return {
    ...listing,
    condition: "NEW_NO_TAGS",
    listing_format: "AUCTION",
    auction_start_price: listing.auction_start_price ?? CARD_AUCTION_START,
    auction_duration: listing.auction_duration ?? "DAYS_7",
  };
}
