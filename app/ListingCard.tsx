"use client";

import { useEffect, useMemo, useState } from "react";
import { SIZE_REQUIRED_CATEGORIES } from "@/lib/categories";
import type { AuctionDuration, ItemGroup, ListingResult, Photo } from "@/lib/types";

const TITLE_LIMIT = 80;

// eBay's pre-owned condition tiers, matching the values the model returns.
const CONDITIONS: { value: string; label: string }[] = [
  { value: "NEW_WITH_TAGS", label: "New with tags" },
  { value: "NEW_NO_TAGS", label: "New without tags" },
  { value: "EXCELLENT", label: "Pre-owned · Excellent" },
  { value: "VERY_GOOD", label: "Pre-owned · Very good" },
  { value: "GOOD", label: "Pre-owned · Good" },
  { value: "FAIR", label: "Pre-owned · Fair" },
];

const AUCTION_DURATION_OPTIONS: { value: AuctionDuration; label: string }[] = [
  { value: "DAYS_1", label: "1 day" },
  { value: "DAYS_3", label: "3 days" },
  { value: "DAYS_5", label: "5 days" },
  { value: "DAYS_7", label: "7 days" },
  { value: "DAYS_10", label: "10 days" },
];

// Starting bid prefilled when the seller switches a listing to Auction.
const DEFAULT_AUCTION_START = 0.99;
// Mirrors AUCTION_BIN_MIN_RATIO in lib/ebay/publish.ts (eBay's 30% rule).
const AUCTION_BIN_MIN_RATIO = 1.3;

function priceNumber(value: ListingResult["suggested_price"]): number | undefined {
  const n = typeof value === "string" ? parseFloat(value) : value;
  return n === undefined || Number.isNaN(n) || n <= 0 ? undefined : n;
}

function formatPrice(value: ListingResult["suggested_price"]): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (n === undefined || Number.isNaN(n)) return "$0.00";
  return `$${n.toFixed(2)}`;
}

function priceToInput(value: ListingResult["suggested_price"]): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  return n === undefined || Number.isNaN(n) ? "" : String(n);
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="btn-ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      {copied ? "✓ Copied" : `📋 Copy ${label}`}
    </button>
  );
}

interface ListingCardProps {
  group: ItemGroup;
  photoById: (id: string) => Photo | undefined;
  ebayConnected: boolean;
  onEdit: (groupId: string, patch: Partial<ListingResult>) => void;
  onRenameSku: (groupId: string, sku: string) => void;
  onRetry: (groupId: string) => void;
  onPost: (groupId: string) => void;
}

export function ListingCard({
  group,
  photoById,
  ebayConnected,
  onEdit,
  onRenameSku,
  onRetry,
  onPost,
}: ListingCardProps) {
  const [open, setOpen] = useState(true);
  const listing = group.listing;
  const cover = photoById(group.photoIds[0]);

  const specifics = useMemo(() => {
    const entries = Object.entries(listing?.item_specifics ?? {});
    return entries.filter(([k, v]) => v && v.trim() !== "" && !k.startsWith("---"));
  }, [listing?.item_specifics]);

  const titleLen = listing?.title?.length ?? 0;

  // eBay's size standardization blocks apparel/footwear listings that are
  // missing a Size, so flag those for the seller before they post.
  const sizeRequired = SIZE_REQUIRED_CATEGORIES.has(listing?.category ?? "");
  const sizeMissing = sizeRequired && !(listing?.size ?? "").trim();

  // Publishing refuses a missing/zero price (no more invented defaults), so
  // flag it here the same way size is flagged — before the seller hits Post.
  // Auctions need a starting bid instead; their Buy It Now price is optional
  // but must clear eBay's 30%-above-start rule when set.
  const isAuction = listing?.listing_format === "AUCTION";
  const priceNum = priceNumber(listing?.suggested_price);
  const startNum = priceNumber(listing?.auction_start_price);
  const priceMissing =
    group.status === "done" && (isAuction ? startNum === undefined : priceNum === undefined);
  const binTooLow =
    group.status === "done" &&
    isAuction &&
    startNum !== undefined &&
    priceNum !== undefined &&
    priceNum < Math.round(startNum * AUCTION_BIN_MIN_RATIO * 100) / 100;

  return (
    <article className={`listing-card status-${group.status}`}>
      <header className="listing-card-head" onClick={() => setOpen((o) => !o)}>
        {cover && (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="listing-cover" src={cover.previewUrl} alt="" />
        )}
        <div className="listing-card-title">
          <strong>
            {group.sku && <span className="sku-tag">{group.sku}</span>}
            {listing?.title || group.name}
          </strong>
          <span className="listing-card-sub">
            {group.status === "writing" && (
              <>
                <span className="spinner small" aria-hidden="true" /> Writing…
              </>
            )}
            {group.status === "done" &&
              (priceMissing ? (
                <span style={{ color: "var(--color-danger)" }}>
                  ⚠️ {isAuction ? "needs a starting bid" : "needs a price"}
                </span>
              ) : isAuction ? (
                <>✅ Auction from {formatPrice(listing?.auction_start_price)} · ready</>
              ) : (
                <>✅ {formatPrice(listing?.suggested_price)} · ready</>
              ))}
            {group.status === "error" && (
              <span style={{ color: "var(--color-danger)" }}>
                ⚠️ {group.error || "Failed"}
              </span>
            )}
            {group.status === "idle" && "Waiting…"}
          </span>
        </div>
        {group.status === "error" ? (
          <button
            type="button"
            className="btn-ghost"
            onClick={(e) => {
              e.stopPropagation();
              onRetry(group.id);
            }}
          >
            ↻ Retry
          </button>
        ) : (
          <span className="chevron" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
        )}
      </header>

      {open && listing && group.status === "done" && (
        <div className="listing-card-body">
          <div className="result-field">
            <label>
              Title
              <span className={`count${titleLen > TITLE_LIMIT ? " over" : ""}`}>
                {titleLen}/{TITLE_LIMIT}
              </span>
            </label>
            <input
              type="text"
              className="title-input"
              value={listing.title}
              onChange={(e) => onEdit(group.id, { title: e.target.value })}
            />
            <div className="copy-row">
              <CopyButton text={listing.title} label="title" />
            </div>
          </div>

          <div className="meta-row">
            {/* SKU stays editable up until the item is posted, so a SKU fix
                never requires going back and re-writing listings (issue #30). */}
            <div className="stat editable">
              <label className="k" htmlFor={`sku-${group.id}`}>
                SKU
              </label>
              <input
                id={`sku-${group.id}`}
                type="text"
                className="size-input"
                value={group.sku}
                disabled={group.postStatus === "posted"}
                onChange={(e) => onRenameSku(group.id, e.target.value)}
              />
            </div>
            <div className="stat editable">
              <label className="k" htmlFor={`format-${group.id}`}>
                Format
              </label>
              <select
                id={`format-${group.id}`}
                value={isAuction ? "AUCTION" : "FIXED_PRICE"}
                disabled={group.postStatus === "posted"}
                onChange={(e) =>
                  onEdit(
                    group.id,
                    e.target.value === "AUCTION"
                      ? {
                          listing_format: "AUCTION",
                          auction_start_price:
                            listing.auction_start_price ?? DEFAULT_AUCTION_START,
                          auction_duration: listing.auction_duration ?? "DAYS_7",
                        }
                      : { listing_format: "FIXED_PRICE" }
                  )
                }
              >
                <option value="FIXED_PRICE">Buy It Now</option>
                <option value="AUCTION">Auction</option>
              </select>
            </div>
            {isAuction && (
              <div className={`stat editable${priceMissing ? " needs-attention" : ""}`}>
                <label className="k" htmlFor={`start-${group.id}`}>
                  Starting bid
                </label>
                <div className="price-input">
                  <span aria-hidden="true">$</span>
                  <input
                    id={`start-${group.id}`}
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    value={priceToInput(listing.auction_start_price)}
                    onChange={(e) =>
                      onEdit(group.id, {
                        auction_start_price:
                          e.target.value === "" ? "" : Number(e.target.value),
                      })
                    }
                  />
                </div>
                <select
                  aria-label="Auction length"
                  value={listing.auction_duration ?? "DAYS_7"}
                  onChange={(e) =>
                    onEdit(group.id, { auction_duration: e.target.value as AuctionDuration })
                  }
                >
                  {AUCTION_DURATION_OPTIONS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div
              className={`stat editable${
                (!isAuction && priceMissing) || binTooLow ? " needs-attention" : ""
              }`}
            >
              <label className="k" htmlFor={`price-${group.id}`}>
                {isAuction ? "Buy It Now (optional)" : "Price"}
              </label>
              <div className="price-input">
                <span aria-hidden="true">$</span>
                <input
                  id={`price-${group.id}`}
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={priceToInput(listing.suggested_price)}
                  onChange={(e) =>
                    onEdit(group.id, {
                      suggested_price:
                        e.target.value === "" ? "" : Number(e.target.value),
                    })
                  }
                />
              </div>
              {group.comps?.ok && group.comps.median !== undefined && (
                <span className="comps-line" title={group.comps.basis}>
                  Market: {group.comps.count} similar active listings, $
                  {group.comps.low?.toFixed(2)}–${group.comps.high?.toFixed(2)}
                  {" · "}
                  <button
                    type="button"
                    className="comps-use"
                    onClick={() =>
                      onEdit(group.id, {
                        suggested_price:
                          group.comps!.listPrice ?? group.comps!.median,
                      })
                    }
                  >
                    {/* listPrice = median + the deployment's storewide markup */}
                    {group.comps.listPrice !== undefined
                      ? `use $${group.comps.listPrice.toFixed(2)} (median + markup)`
                      : `use median $${group.comps.median.toFixed(2)}`}
                  </button>
                </span>
              )}
            </div>
            <div className="stat editable">
              <label className="k" htmlFor={`cond-${group.id}`}>
                Condition
              </label>
              <select
                id={`cond-${group.id}`}
                value={listing.condition ?? "GOOD"}
                onChange={(e) => onEdit(group.id, { condition: e.target.value })}
              >
                {/* Keep an unexpected model value selectable rather than losing it. */}
                {listing.condition &&
                  !CONDITIONS.some((c) => c.value === listing.condition) && (
                    <option value={listing.condition}>
                      {listing.condition.replace(/_/g, " ")}
                    </option>
                  )}
                {CONDITIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            {listing.brand && (
              <div className="stat">
                <div className="k">Brand</div>
                <div className="v">{listing.brand}</div>
              </div>
            )}
            {(sizeRequired || listing.size) && (
              <div className={`stat editable${sizeMissing ? " needs-attention" : ""}`}>
                <label className="k" htmlFor={`size-${group.id}`}>
                  Size
                </label>
                <input
                  id={`size-${group.id}`}
                  type="text"
                  className="size-input"
                  value={listing.size ?? ""}
                  placeholder={sizeRequired ? "e.g. M, 32x34, 10.5" : "—"}
                  onChange={(e) => onEdit(group.id, { size: e.target.value })}
                />
              </div>
            )}
          </div>

          {sizeMissing && (
            <p className="size-warning" role="alert">
              ⚠️ No size found on the tag. eBay now blocks apparel listings
              without a standard size — check the photos or measure the item,
              then fill in Size above before posting.
            </p>
          )}

          {priceMissing && isAuction && (
            <p className="size-warning" role="alert">
              ⚠️ No starting bid yet. Set one above before posting this auction.
            </p>
          )}

          {binTooLow && (
            <p className="size-warning" role="alert">
              ⚠️ eBay requires an auction&rsquo;s Buy It Now price to be at least
              30% above the starting bid (at least{" "}
              {formatPrice(Math.round((startNum ?? 0) * AUCTION_BIN_MIN_RATIO * 100) / 100)}).
              Raise Buy It Now, lower the starting bid, or clear Buy It Now.
            </p>
          )}

          {priceMissing && !isAuction && (
            <p className="size-warning" role="alert">
              ⚠️ No price yet — the analysis couldn&rsquo;t estimate one for
              this item. Set a price above before posting
              {group.comps?.ok ? " (see the market check under Price)" : ""}.
            </p>
          )}

          <div className="result-field">
            <label>Description</label>
            <textarea
              value={listing.description}
              onChange={(e) => onEdit(group.id, { description: e.target.value })}
              rows={8}
            />
            <div className="copy-row">
              <CopyButton text={listing.description} label="description" />
            </div>
          </div>

          {specifics.length > 0 && (
            <details className="specifics-details">
              <summary>{specifics.length} item specifics</summary>
              <div className="specifics">
                {specifics.map(([k, v]) => (
                  <div className="row" key={k}>
                    <span className="k">{k}</span>
                    <span>{v}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* eBay posting */}
          {group.postStatus === "posted" ? (
            <>
              <p className="post-result ok">
                ✅ Posted to eBay
                {group.listingId ? (
                  <>
                    {" "}
                    ·{" "}
                    <a
                      href={`https://www.ebay.com/itm/${group.listingId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View listing ↗
                    </a>
                  </>
                ) : null}
              </p>
              {(group.postWarnings ?? []).map((w) => (
                <p className="post-result warn" key={w}>
                  ⚠️ {w}
                </p>
              ))}
            </>
          ) : ebayConnected ? (
            <div className="post-row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => onPost(group.id)}
                disabled={group.postStatus === "posting"}
              >
                {group.postStatus === "posting" ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Posting to eBay…
                  </>
                ) : (
                  "🚀 Post this to eBay"
                )}
              </button>
              {group.postStatus === "error" && group.postError && (
                <p className="post-result err">⚠️ {group.postError}</p>
              )}
            </div>
          ) : (
            <p className="post-hint">Connect eBay (top of page) to post this listing.</p>
          )}
        </div>
      )}
    </article>
  );
}
