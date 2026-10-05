// Comparable-listing price research via eBay's Browse API.
//
// The analysis model's suggested_price is a visual guess with no market data
// behind it. This module grounds it: search active eBay listings for the same
// kind of item, filter out bad comps (lots, wrong condition, parts,
// reproductions), and compute a median/trimmed price band with a confidence
// score. Active asking prices run higher than sold prices (eBay's sold-comps
// API requires special approval), so this is a sanity band, not gospel — the
// UI presents it beside the AI estimate and the seller decides.

import { EBAY_CURRENCY, EBAY_MARKETPLACE_ID } from "./config";
import type { CompsSummary, ListingResult } from "@/lib/types";

const EBAY_BROWSE_SEARCH = "https://api.ebay.com/buy/browse/v1/item_summary/search";

export type { CompsSummary };

// Comps that poison the statistics: multi-item lots when ours is one item,
// parts/repair listings, reproductions, and empty-box scams. (No "x 12"-style
// quantity heuristic — it false-positived on dimension titles like "16 x 20".)
const BAD_COMP_TITLE_RE =
  /\b(lot(?:\sof)?|bundle|wholesale|reseller|bulk|for\sparts|parts\sonly|repair|broken|damaged|repro(?:duction)?|replica|fake|style\sof|box\sonly|case\sonly|manual\sonly)\b/i;

const NEW_CONDITION_IDS = new Set([1000, 1500, 1750]);

function isNewGrade(condition: string | undefined): boolean {
  return /^NEW/i.test(String(condition || ""));
}

// Sports/trading cards. Their price hinges on year, set, parallel, card
// number, print run, and grade — all in the title, none in "brand + item type"
// (which would search "Panini Trading Card") — so they get a title query.
const CARD_CATEGORY_IDS = new Set(["261328", "183454"]); // card singles, CCG singles
const CARD_ITEM_TYPE_RE =
  /\b(trading|sports|baseball|basketball|football|hockey|soccer|rookie|pok[eé]mon|tcg|ccg)\s+cards?\b/i;

export function isTradingCard(listing: ListingResult): boolean {
  const category = String(listing.category || "").trim().toLowerCase();
  if (category === "trading_card") return true;
  if (CARD_CATEGORY_IDS.has(String(listing.category_id || "").trim())) return true;
  if (!["sports_memorabilia", "collectible", "other"].includes(category)) return false;
  return CARD_ITEM_TYPE_RE.test(`${listing.item_type || ""} ${listing.category_hint || ""}`);
}

// Seller hype that narrows a search without identifying the card.
const CARD_FILLER_RE = /\b(rc|rookie(?:\s+card)?|invest(?:ment)?|hot|rare|l@@k|look|nice|sharp)\b|🔥/gi;

function buildCardQuery(title: string): string {
  return title.replace(CARD_FILLER_RE, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}

export function buildCompQuery(listing: ListingResult): string {
  if (isTradingCard(listing)) return buildCardQuery(String(listing.title || ""));
  const brand = String(listing.brand || "").trim();
  const usableBrand = brand && !/^(no\s?brand|unbranded|unknown)$/i.test(brand) ? brand : "";
  const itemType = String(listing.item_type || "").trim();
  const parts = [usableBrand, itemType].filter(Boolean);
  if (parts.length) return parts.join(" ").slice(0, 100);
  // No brand/type — fall back to the first few title words.
  return String(listing.title || "").split(/\s+/).slice(0, 6).join(" ").slice(0, 100);
}

interface BrowseItem {
  title?: string;
  price?: { value?: string; currency?: string };
  conditionId?: string;
  itemGroupType?: string;
}

export function filterComps(
  items: BrowseItem[],
  listingCondition: string | undefined,
  // Cards use eBay's Graded/Ungraded conditions, not the new/used split.
  ignoreCondition = false
): number[] {
  const wantNew = isNewGrade(listingCondition);
  const prices: number[] = [];
  for (const it of items) {
    const price = Number(it.price?.value);
    if (!Number.isFinite(price) || price <= 0) continue;
    // Comps must be priced in the currency the listing will publish in —
    // mixing currencies would corrupt the median/band silently.
    if (it.price?.currency && it.price.currency !== EBAY_CURRENCY) continue;
    if (BAD_COMP_TITLE_RE.test(String(it.title || ""))) continue;
    const condId = Number(it.conditionId);
    if (!ignoreCondition && Number.isFinite(condId) && condId > 0) {
      const compIsNew = NEW_CONDITION_IDS.has(condId);
      if (compIsNew !== wantNew) continue;
    }
    prices.push(price);
  }
  return prices;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Median, 10–90% band, trimmed mean, and a confidence heuristic based on how
// many valid comps exist and how tightly they cluster.
export function compStats(prices: number[]): Omit<CompsSummary, "ok" | "query" | "basis"> {
  const sorted = [...prices].sort((a, b) => a - b);
  const count = sorted.length;
  if (count === 0) return { count: 0, confidence: 0 };

  const median = percentile(sorted, 0.5);
  const low = percentile(sorted, 0.1);
  const high = percentile(sorted, 0.9);
  const trimStart = Math.floor(count * 0.1);
  const trimmed = sorted.slice(trimStart, count - trimStart || count);
  const trimmedMean = trimmed.reduce((s, n) => s + n, 0) / trimmed.length;

  // Confidence: volume (12+ comps → full marks) damped by dispersion — a band
  // spanning 3× the median means the query matched too many different things.
  const volumeScore = Math.min(1, count / 12);
  const spread = median > 0 ? (high - low) / median : 1;
  const tightness = Math.max(0.2, 1 - spread / 3);
  const confidence = Math.round(volumeScore * tightness * 100) / 100;

  return {
    count,
    median: round2(median),
    trimmedMean: round2(trimmedMean),
    low: round2(low),
    high: round2(high),
    confidence,
  };
}

// Identical items in a batch (or a re-analyze) shouldn't re-spend Browse API
// quota — cache per warm lambda for a while.
const compsCache = new Map<string, { summary: CompsSummary; expiresAt: number }>();
const COMPS_TTL_MS = 10 * 60_000;
const COMPS_CACHE_MAX = 200;

// Search active comps for a listing. `appToken` comes from the taxonomy
// module's client-credentials flow — the Browse API accepts the same scope.
export async function searchComps(
  appToken: string,
  listing: ListingResult
): Promise<CompsSummary> {
  const query = buildCompQuery(listing);
  const empty: CompsSummary = { ok: false, query, count: 0, confidence: 0, basis: "" };
  if (!query) return empty;

  const card = isTradingCard(listing);
  const wantNew = isNewGrade(listing.condition);
  const cacheKey = `${query}|${card ? "card" : wantNew ? "new" : "used"}`;
  const cached = compsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.summary;
  const params = new URLSearchParams({
    q: query,
    limit: "50",
    filter: card
      ? `buyingOptions:{FIXED_PRICE},priceCurrency:${EBAY_CURRENCY}`
      : `buyingOptions:{FIXED_PRICE},conditions:{${wantNew ? "NEW" : "USED"}},priceCurrency:${EBAY_CURRENCY}`,
  });
  const resp = await fetch(`${EBAY_BROWSE_SEARCH}?${params}`, {
    headers: {
      Authorization: `Bearer ${appToken}`,
      Accept: "application/json",
      "X-EBAY-C-MARKETPLACE-ID": EBAY_MARKETPLACE_ID,
    },
  });
  if (!resp.ok) return empty;
  const data = await resp.json().catch(() => null);
  const items: BrowseItem[] = data?.itemSummaries ?? [];
  const prices = filterComps(items, listing.condition, card);
  const stats = compStats(prices);
  const summary: CompsSummary = {
    ok: stats.count > 0,
    query,
    ...stats,
    basis:
      stats.count > 0
        ? `${stats.count} active ${card ? "" : wantNew ? "new " : "pre-owned "}listings matching “${query}” (asking prices, not sold)`
        : "",
  };
  if (compsCache.size > COMPS_CACHE_MAX) compsCache.clear();
  compsCache.set(cacheKey, { summary, expiresAt: Date.now() + COMPS_TTL_MS });
  return summary;
}
