import { NextRequest, NextResponse } from "next/server";
import { guardApiRequest } from "@/lib/api-guard";
import { isEbayConfigured } from "@/lib/ebay/config";
import { appToken } from "@/lib/ebay/taxonomy";
import { searchComps } from "@/lib/ebay/comps";
import { isTradingCard, lookupCardPrice } from "@/lib/cardPricing";
import { applyPriceMarkup, priceMarkupPercent } from "@/lib/pricing";
import type { CompsSummary, ListingResult } from "@/lib/types";

// One Browse-API search (plus one PriceCharting lookup for cards); quick.
export const maxDuration = 30;

// The band stays raw market truth; the "use median" affordance carries the
// deployment's storewide markup so it matches analysis-suggested pricing.
function withListPrice(comps: CompsSummary): CompsSummary {
  const markup = priceMarkupPercent();
  if (markup > 0 && comps.median !== undefined && comps.median > 0) {
    return { ...comps, listPrice: applyPriceMarkup(comps.median, markup) };
  }
  return comps;
}

// Market price check for a drafted listing: active-comp count, median, and
// range. Uses the app-level eBay token, so it works before a seller connects.
// Trading cards try PriceCharting first (see lib/cardPricing.ts).
export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;

  let body: { listing?: ListingResult };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }
  if (!body.listing?.title) {
    return NextResponse.json({ ok: false, error: "Missing listing." }, { status: 400 });
  }

  if (isTradingCard(body.listing)) {
    return cardComps(body.listing);
  }

  if (!isEbayConfigured()) {
    return NextResponse.json({ ok: false, error: "eBay isn't configured." }, { status: 200 });
  }

  try {
    const token = await appToken();
    const comps = await searchComps(token, body.listing);
    return NextResponse.json({ ok: true, comps: withListPrice(comps) });
  } catch (e) {
    // Comps are advisory — never let a market-check failure look like an outage.
    console.warn(`[ebay/comps] lookup failed: ${(e as Error).message}`);
    return NextResponse.json({ ok: false, error: "Market check unavailable." }, { status: 200 });
  }
}

// Card path: a confident PriceCharting match becomes the summary (and the
// client prefills suggested_price from it). Otherwise fall back to active
// comps — if eBay is configured — flagged low-confidence so the UI says so.
async function cardComps(listing: ListingResult) {
  const card = await lookupCardPrice(listing);
  if (card.ok && card.price !== undefined) {
    return NextResponse.json({
      ok: true,
      comps: withListPrice({
        ok: true,
        query: card.query,
        count: 1,
        median: card.price,
        confidence: card.confidence,
        basis: `PriceCharting market value for ${card.match?.name} (${card.match?.set}), ${card.match?.grade}`,
        source: "pricecharting",
        cardMatch: card.match,
      }),
    });
  }

  let fallback: CompsSummary = { ok: false, query: card.query, count: 0, confidence: 0, basis: "" };
  if (isEbayConfigured()) {
    try {
      fallback = await searchComps(await appToken(), listing);
    } catch (e) {
      console.warn(`[ebay/comps] card fallback lookup failed: ${(e as Error).message}`);
    }
  }
  return NextResponse.json({
    ok: true,
    comps: withListPrice({
      ...fallback,
      source: "ebay_active",
      lowConfidence: true,
      lowConfidenceReason: card.reason,
    }),
  });
}
