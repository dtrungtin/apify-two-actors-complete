// Pay-per-event pricing rules for the customer Actor. Pure functions, no Apify calls, so they can be unit-tested.
//
// Events must be defined in Apify Console (Actor > Publication > Monetization > Pay per event) with exactly these
// names. Prices are set there; this code only decides which event to charge and whether the run can pay for it.

export const EVENTS = {
    standard: 'actor-generated-standard',
    advanced: 'actor-generated-advanced',
    revision: 'actor-revision',
};

export const TIERS = ['standard', 'advanced', 'revision', 'free'];

/** Event that every request must be able to pay for before the work starts. */
export const PRECHECK_EVENT = EVENTS.standard;

/**
 * Tier chosen by the operator at delivery time (GENERATED_ACTOR_META.tier), with sensible defaults:
 * revisions are billed as revisions, everything else as standard.
 */
export function resolveTier(metaTier, isRevision) {
    const tier = typeof metaTier === 'string' ? metaTier.trim().toLowerCase() : '';
    if (TIERS.includes(tier)) return tier;
    return isRevision ? 'revision' : 'standard';
}

/** Event name for a tier, or null for free deliveries. */
export function eventForTier(tier) {
    return EVENTS[tier] ?? null;
}

/**
 * Decide what to charge. `chargeableCount(eventName)` tells how many events of that type the run's spending cap
 * still allows. Returns { eventName, fallback } where fallback is true when an advanced delivery had to be
 * charged at the standard price because the cap did not cover the advanced one, or { eventName: null, reason }.
 */
export function planCharge({ isPayPerEvent, perEventPrices, tier, chargeableCount }) {
    if (!isPayPerEvent) return { eventName: null, reason: 'not-pay-per-event' };
    const eventName = eventForTier(tier);
    if (!eventName) return { eventName: null, reason: 'free' };
    if (perEventPrices?.[eventName] === undefined) return { eventName: null, reason: 'event-not-configured' };
    if (chargeableCount(eventName) >= 1) return { eventName, fallback: false };
    if (tier === 'advanced' && perEventPrices?.[EVENTS.standard] !== undefined && chargeableCount(EVENTS.standard) >= 1) {
        return { eventName: EVENTS.standard, fallback: true };
    }
    return { eventName: null, reason: 'limit-reached' };
}

/**
 * Message for a run whose spending cap cannot pay for a standard generation, or null when the run may proceed.
 * Runs that are not pay-per-event, or where the pre-check event is not configured, always proceed.
 */
export function precheckMessage({ isPayPerEvent, perEventPrices, maxTotalChargeUsd, chargeableCount }) {
    if (!isPayPerEvent) return null;
    const price = perEventPrices?.[PRECHECK_EVENT];
    if (price === undefined) return null;
    if (chargeableCount(PRECHECK_EVENT) >= 1) return null;
    const cap = Number.isFinite(maxTotalChargeUsd) ? `$${maxTotalChargeUsd.toFixed(2)}` : 'unset';
    return `This run's "Maximum total charge" (${cap}) is below the price of an Actor generation ($${price.toFixed(2)}). `
        + `Raise it to at least $${price.toFixed(2)} and start the run again. Revisions of an Actor you already received are charged less.`;
}
