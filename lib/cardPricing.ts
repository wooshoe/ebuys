// Trading-card pricing via the PriceCharting API.
//
// Active eBay comps (lib/ebay/comps.ts) are a poor guide for cards: they're
// asking prices, and a "brand + item type" search can't tell a base card from
// a /99 Silver parallel or a raw card from a PSA 10. PriceCharting tracks
// sold prices per exact card (set, number, parallel) and per grade, so for
// items identified as trading cards we look the card up there first.
//
// This path is strictly additive and advisory: no token, a failed request, or
// no confident match all return { ok: false, reason } — never throw — and the
// caller falls back to the existing comps check with a low-confidence flag.
//
// API: https://www.pricecharting.com/api-documentation
//   GET /api/products?t=TOKEN&q=QUERY  → { status, products: [...] }
//   GET /api/product?t=TOKEN&id=ID     → { status, ...product }
// Prices are integer pennies. For cards the generic price fields map to grades
// (loose = ungraded, cib = 7/7.5, new = 8/8.5, graded = 9, box-only = 9.5,
// manual-only = PSA 10, bgs-10, condition-17 = CGC 10, condition-18 = SGC 10).

import type { CardMatch, ListingResult } from "@/lib/types";

const PRICECHARTING_API = "https://www.pricecharting.com/api";
const REQUEST_TIMEOUT_MS = 8_000;

// Minimum match score (0–1) to treat a PriceCharting product as this card.
export const CARD_MATCH_THRESHOLD = 0.7;

export interface CardPriceResult {
  ok: boolean;
  query: string;
  // 0–1 match score of the chosen product (0 when nothing matched).
  confidence: number;
  // Why there's no confident price — shown to the seller. Set when !ok.
  reason?: string;
  // Market value in dollars for the detected grade.
  price?: number;
  match?: CardMatch;
}

// ── Identification ───────────────────────────────────────────────────────────

// eBay leaf categories: Sports Trading Card Singles, CCG Individual Cards.
const CARD_CATEGORY_IDS = new Set(["261328", "183454"]);

// Collectible-ish categories the analysis model sometimes files cards under.
const CARD_ADJACENT_CATEGORIES = new Set(["sports_memorabilia", "collectible", "other"]);

const CARD_ITEM_TYPE_RE =
  /\b(trading|sports|baseball|basketball|football|hockey|soccer|rookie|pok[eé]mon|tcg|ccg)\s+cards?\b/i;

// True only for items the analysis identified as sports/trading cards. Every
// other item (household goods, apparel, …) keeps the existing pricing path.
export function isTradingCard(listing: ListingResult): boolean {
  const category = String(listing.category || "").trim().toLowerCase();
  if (category === "trading_card") return true;
  if (CARD_CATEGORY_IDS.has(String(listing.category_id || "").trim())) return true;
  if (!CARD_ADJACENT_CATEGORIES.has(category)) return false;
  return CARD_ITEM_TYPE_RE.test(`${listing.item_type || ""} ${listing.category_hint || ""}`);
}

// ── Grade ────────────────────────────────────────────────────────────────────

export interface CardGrade {
  label: string; // "Ungraded", "PSA 10", "BGS 9.5", …
  grader?: string;
  value?: number;
}

const GRADE_RE = /\b(PSA|BGS|SGC|CGC|Beckett)\s*(?:GEM\s*(?:MINT|MT)\s*)?(10|[1-9](?:\.5)?)\b/i;

export function detectGrade(listing: ListingResult): CardGrade {
  const specifics = listing.item_specifics ?? {};
  const grader = (specifics["Professional Grader"] || "").trim();
  const grade = (specifics["Grade"] || "").trim();
  // eBay grader values read like "Professional Sports Authenticator (PSA)".
  const graderCode = /\b(PSA|BGS|SGC|CGC|Beckett)\b/i.exec(grader)?.[1];
  const sources = [listing.title, graderCode && grade ? `${graderCode} ${grade}` : ""];
  for (const s of sources) {
    const m = GRADE_RE.exec(String(s || ""));
    if (m) {
      const g = m[1].toUpperCase() === "BECKETT" ? "BGS" : m[1].toUpperCase();
      return { label: `${g} ${m[2]}`, grader: g, value: Number(m[2]) };
    }
  }
  return { label: "Ungraded" };
}

// PriceCharting price field for a grade. null = no tracked price at that grade.
export function priceFieldForGrade(grade: CardGrade): string | null {
  const v = grade.value;
  if (v === undefined) return "loose-price";
  if (v === 10) {
    if (grade.grader === "BGS") return "bgs-10-price";
    if (grade.grader === "CGC") return "condition-17-price";
    if (grade.grader === "SGC") return "condition-18-price";
    return "manual-only-price";
  }
  if (v === 9.5) return "box-only-price";
  if (v === 9) return "graded-price";
  if (v === 8 || v === 8.5) return "new-price";
  if (v === 7 || v === 7.5) return "cib-price";
  return null;
}

// ── Title parsing & matching ─────────────────────────────────────────────────

// Words that don't identify a card (grading jargon, filler).
const STOP_WORDS = new Set([
  "rc", "rookie", "card", "cards", "psa", "bgs", "sgc", "cgc", "beckett", "gem",
  "mint", "mt", "graded", "ungraded", "raw", "the", "and", "of", "nm", "ex",
  "sp", "ssp", "numbered", "serial", "pop", "invest", "hot", "rare", "lot",
]);

// Words that mark a parallel/variant. If the seller's title has one that the
// product doesn't, the product is almost certainly the base card (or a
// different parallel) — a very different price.
const PARALLEL_WORDS = new Set([
  "silver", "gold", "red", "blue", "green", "orange", "purple", "pink", "black",
  "white", "bronze", "yellow", "teal", "aqua", "refractor", "xfractor", "holo",
  "mojo", "shimmer", "wave", "scope", "cracked", "ice", "hyper", "disco",
  "tiger", "camo", "laser", "velocity", "sapphire", "atomic", "superfractor",
  "auto", "autograph", "patch", "relic", "jersey", "reverse", "foil", "neon",
  "pulsar", "snakeskin", "choice", "fast", "break", "lazer", "prizms",
]);

export interface ParsedCard {
  years: string[];
  number?: string;
  serial?: string; // print run, e.g. "99" for "1/99" or "/99"
  words: string[];
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !/^\d+$/.test(w));
}

export function parseCardTitle(title: string): ParsedCard {
  let rest = String(title || "");
  const years: string[] = [];
  rest = rest.replace(/\b((?:19|20)\d{2})(?:\s*[-/]\s*(\d{2,4}))?\b/g, (_m, y: string, y2?: string) => {
    years.push(y);
    if (y2) years.push(y2.length === 2 ? y.slice(0, 2) + y2 : y2);
    return " ";
  });
  let serial: string | undefined;
  rest = rest.replace(/(?:\b\d{1,4})?\s*\/\s*(\d{1,4})\b/, (_m, run: string) => {
    serial = String(Number(run));
    return " ";
  });
  let number: string | undefined;
  rest = rest.replace(/#\s*([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/, (_m, n: string) => {
    number = n.toUpperCase();
    return " ";
  });
  rest = rest.replace(GRADE_RE, " ");
  return {
    years,
    number,
    serial,
    words: [...new Set(words(rest).filter((w) => !STOP_WORDS.has(w)))],
  };
}

// Search text for PriceCharting: the title minus grade, serial, and filler,
// which its catalog names don't contain.
export function buildCardQuery(listing: ListingResult): string {
  const p = parseCardTitle(listing.title);
  const parts = [p.years[0], ...p.words, p.number ? `#${p.number}` : ""];
  return parts.filter(Boolean).join(" ").slice(0, 120);
}

export interface PriceChartingProduct {
  id?: string | number;
  "product-name"?: string;
  "console-name"?: string;
  [field: string]: unknown;
}

// Score how well a PriceCharting product matches the seller's card, 0–1.
// Hard mismatches (different card number, year, parallel, or print run, or a
// player name not in the title) return 0.
export function scoreCardMatch(card: ParsedCard, product: PriceChartingProduct): number {
  const name = String(product["product-name"] || "");
  const set = String(product["console-name"] || "");

  const bracket = /\[([^\]]*)\]/.exec(name)?.[1] ?? "";
  const productNumber = /#\s*([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/.exec(name)?.[1]?.toUpperCase();
  const productSerial = /\/\s*(\d{1,4})\b/.exec(bracket)?.[1];
  const baseName = name.replace(/\[[^\]]*\]/g, " ").replace(/#\s*\S+/g, " ");

  const titleWords = new Set(card.words);
  const parallelWords = words(bracket);
  const productWords = new Set([...words(name), ...words(set)]);

  // Card number: the single strongest identifier.
  if (card.number && productNumber && card.number !== productNumber) return 0;
  // Year: PriceCharting sets carry the season's first year.
  const setYear = /\b((?:19|20)\d{2})\b/.exec(set)?.[1];
  if (card.years.length && setYear && !card.years.includes(setYear)) return 0;
  // Every player/subject word in the product name must be in the title.
  const nameWords = words(baseName);
  if (nameWords.length === 0 || !nameWords.every((w) => titleWords.has(w))) return 0;
  // Parallel must agree in both directions.
  if (!parallelWords.every((w) => titleWords.has(w))) return 0;
  for (const w of card.words) {
    if (PARALLEL_WORDS.has(w) && !productWords.has(w)) return 0;
  }
  // Print run, when both sides state one.
  if (card.serial && productSerial && card.serial !== String(Number(productSerial))) return 0;

  const overlap = card.words.length
    ? card.words.filter((w) => productWords.has(w)).length / card.words.length
    : 0;
  const numberScore = card.number ? (productNumber === card.number ? 1 : 0) : 0.5;
  const yearScore = card.years.length ? (setYear ? 1 : 0.5) : 0.5;
  const serialScore = card.serial && !productSerial ? 0.5 : 1;
  const score = 0.45 * overlap + 0.3 * numberScore + 0.15 * yearScore + 0.1 * serialScore;
  return Math.round(score * 100) / 100;
}

// ── API ──────────────────────────────────────────────────────────────────────

const cardCache = new Map<string, { result: CardPriceResult; expiresAt: number }>();
const CARD_TTL_MS = 10 * 60_000;
const CARD_CACHE_MAX = 200;

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  const resp = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) return null;
  const data = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
  if (!data || data.status !== "success") return null;
  return data;
}

function pennies(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) / 100 : undefined;
}

// Look up a card's market value. `token` is injectable for tests; production
// reads PRICECHARTING_API_TOKEN. Never throws.
export async function lookupCardPrice(
  listing: ListingResult,
  token: string | undefined = process.env.PRICECHARTING_API_TOKEN
): Promise<CardPriceResult> {
  const query = buildCardQuery(listing);
  const fail = (reason: string, confidence = 0): CardPriceResult => ({
    ok: false,
    query,
    confidence,
    reason,
  });

  if (!token?.trim()) return fail("Card price lookup isn't set up (no PriceCharting token).");
  if (!query) return fail("Couldn't read enough of the card title to look it up.");

  const grade = detectGrade(listing);
  const field = priceFieldForGrade(grade);
  if (!field) return fail(`No card price data is tracked for ${grade.label}.`);

  const cacheKey = `${query}|${field}`;
  const cached = cardCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  let result: CardPriceResult;
  try {
    result = await lookupUncached(listing, token.trim(), query, grade, field);
  } catch (e) {
    console.warn(`[cardPricing] PriceCharting lookup failed: ${(e as Error).message}`);
    return fail("Card price lookup failed (PriceCharting unavailable).");
  }
  if (cardCache.size > CARD_CACHE_MAX) cardCache.clear();
  cardCache.set(cacheKey, { result, expiresAt: Date.now() + CARD_TTL_MS });
  return result;
}

async function lookupUncached(
  listing: ListingResult,
  token: string,
  query: string,
  grade: CardGrade,
  field: string
): Promise<CardPriceResult> {
  const fail = (reason: string, confidence = 0): CardPriceResult => ({
    ok: false,
    query,
    confidence,
    reason,
  });

  const search = await getJson(
    `${PRICECHARTING_API}/products?${new URLSearchParams({ t: token, q: query })}`
  );
  if (!search) return fail("Card price lookup failed (PriceCharting unavailable).");
  const products = (Array.isArray(search.products) ? search.products : []) as PriceChartingProduct[];
  if (products.length === 0) return fail("No matching card found on PriceCharting.");

  const card = parseCardTitle(listing.title);
  const ranked = products
    .map((p) => ({ p, score: scoreCardMatch(card, p) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best) return fail("No PriceCharting card matched this exact card (set, number, or parallel differs).");

  // Two different cards scoring about the same → we can't tell which it is.
  let confidence = best.score;
  const runnerUp = ranked[1];
  if (runnerUp && String(runnerUp.p.id) !== String(best.p.id) && best.score - runnerUp.score < 0.05) {
    confidence = Math.round(confidence * 0.8 * 100) / 100;
  }
  if (confidence < CARD_MATCH_THRESHOLD) {
    return fail("PriceCharting found similar cards, but no confident match for this exact card.", confidence);
  }

  // Search results normally carry prices; fetch the product if this one doesn't.
  let product = best.p;
  if (pennies(product[field]) === undefined && product.id !== undefined) {
    product =
      ((await getJson(
        `${PRICECHARTING_API}/product?${new URLSearchParams({ t: token, id: String(product.id) })}`
      )) as PriceChartingProduct | null) ?? product;
  }
  const price = pennies(product[field]);
  if (price === undefined) {
    return fail(`PriceCharting has no ${grade.label} price for this card.`, confidence);
  }

  return {
    ok: true,
    query,
    confidence,
    price,
    match: {
      id: String(best.p.id ?? ""),
      name: String(best.p["product-name"] || ""),
      set: String(best.p["console-name"] || ""),
      grade: grade.label,
    },
  };
}

// For tests: drop cached lookups between cases.
export function clearCardPriceCache(): void {
  cardCache.clear();
}
