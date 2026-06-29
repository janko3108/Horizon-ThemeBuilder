import { CartLinesUpdateEvent, StandardEvents } from '@shopify/events';
import { morphSection } from '@theme/section-renderer';

/**
 * Cart rewards auto-gift controller.
 *
 * Reads the tier config rendered by `snippets/cart-rewards-config.liquid`
 * ({ tiers: [{ amount, variantId }] }, amounts in the shop's minor units) and
 * keeps the cart's free-gift lines in sync with the spend thresholds:
 *   - qualifying spend >= a tier's amount and its gift isn't in the cart -> add it
 *   - qualifying spend  < a tier's amount and its gift IS in the cart     -> remove it
 *
 * Gift lines carry a hidden `_free_gift` line property so they're (a) excluded
 * from the qualifying total, (b) removable, and (c) not shown in the cart (the
 * theme hides `_`-prefixed properties). Making the gift actually $0 is the job
 * of a matching Shopify automatic discount — this only puts it in the cart.
 *
 * The drawer is refreshed via the theme's own CartLinesUpdateEvent (consumed by
 * cart-items-component -> morphSection), so it behaves like any other cart change.
 */

const GIFT_PROPERTY = '_free_gift';
const MAX_PASSES = 6;

class CartRewardsController {
  #busy = false;
  #pending = false;

  constructor() {
    document.addEventListener(StandardEvents.cartLinesUpdate, this.#handleCartUpdate);
    // Reconcile once on load (handles a returning cart that already qualifies).
    this.sync();
  }

  get #config() {
    const el = document.querySelector('[data-cart-rewards-config]');
    if (!el) return null;
    try {
      return JSON.parse(el.textContent);
    } catch {
      return null;
    }
  }

  // Arrow field so it's bound to the instance (private methods can't be reassigned).
  #handleCartUpdate = (event) => {
    // Our own mutations set #busy; queue a re-run instead of dropping the event,
    // so a threshold crossed mid-sync still gets reconciled.
    if (this.#busy) {
      this.#pending = true;
      return;
    }
    // Reconcile only AFTER the triggering mutation has fully settled, so our
    // /cart.js read reflects the committed cart rather than an in-flight one
    // (a too-early read sees the pre-change total and skips the gift).
    const promise = event?.promise;
    if (promise && typeof promise.then === 'function') {
      promise.then(() => this.sync(), () => this.sync());
    } else {
      this.sync();
    }
  };

  #cartUrl(suffix = '') {
    return `${Theme.routes.cart_url}${suffix}`;
  }

  #sectionIds() {
    const ids = new Set();
    document.querySelectorAll('cart-items-component').forEach((node) => {
      if (node instanceof HTMLElement && node.dataset.sectionId) ids.add(node.dataset.sectionId);
    });
    return Array.from(ids).join(',');
  }

  async #fetchCart() {
    // no-store: the cart was just mutated; a cached /cart.js can return the
    // pre-change total, so the spend threshold reads as not-yet-reached and the
    // gift is never added until a full reload re-fetches it fresh.
    const res = await fetch(`${this.#cartUrl('.js')}`, { cache: 'no-store' });
    return res.json();
  }

  /** @param {object} cart */
  #analyze(cart) {
    let qualifying = 0;
    const giftKeyByVariant = new Map();
    for (const item of cart.items) {
      if (item.properties && item.properties[GIFT_PROPERTY]) {
        giftKeyByVariant.set(item.variant_id, item.key);
      } else {
        qualifying += item.final_line_price;
      }
    }
    return { qualifying, giftKeyByVariant };
  }

  async #addGift(variantId, sections) {
    const res = await fetch(Theme.routes.cart_add_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        items: [{ id: variantId, quantity: 1, properties: { [GIFT_PROPERTY]: '1' } }],
        sections,
        sections_url: window.location.pathname,
      }),
    });
    return res.json();
  }

  async #removeGift(lineKey, sections) {
    const res = await fetch(`${Theme.routes.cart_change_url}.js`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        id: lineKey,
        quantity: 0,
        sections,
        sections_url: window.location.pathname,
      }),
    });
    return res.json();
  }

  async sync() {
    if (this.#busy) return;
    const config = this.#config;
    const tiers = config?.tiers || [];
    if (!tiers.length) return;

    this.#busy = true;
    try {
      const sections = this.#sectionIds();
      const performedLines = [];
      let lastSections = null;

      let cart = await this.#fetchCart();
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        const { qualifying, giftKeyByVariant } = this.#analyze(cart);
        let action = null;

        for (const tier of tiers) {
          const reached = qualifying >= tier.amount;
          const inCart = giftKeyByVariant.has(tier.variantId);
          if (reached && !inCart) {
            action = { type: 'add', variantId: tier.variantId };
            break;
          }
          if (!reached && inCart) {
            action = { type: 'remove', key: giftKeyByVariant.get(tier.variantId), variantId: tier.variantId };
            break;
          }
        }

        if (!action) break;

        const response =
          action.type === 'add'
            ? await this.#addGift(action.variantId, sections)
            : await this.#removeGift(action.key, sections);

        if (response?.sections) lastSections = response.sections;
        performedLines.push({ merchandiseId: String(action.variantId), quantity: action.type === 'add' ? 1 : 0 });
        cart = await this.#fetchCart();
      }

      if (performedLines.length > 0) {
        // Directly re-render any OPEN cart drawer so the gift shows live. The
        // dispatched event below also re-renders and notifies other listeners
        // (cart count, etc.), but relying on it alone left an already-open
        // drawer stale until it was closed and reopened — this guarantees the
        // visible drawer reflects the gift immediately. Same HTML, so if the
        // event's morph also runs it's a no-op.
        if (lastSections) {
          for (const node of document.querySelectorAll('cart-items-component[data-drawer]')) {
            const id = node instanceof HTMLElement ? node.dataset.sectionId : null;
            const html = id ? lastSections[id] : null;
            if (typeof html === 'string') morphSection(id, html, { mode: 'hydration' });
          }
        }

        // One render with the final cart + sections, via the theme's own event.
        // `lines` must contain >=1 entry or the event is rejected; the actual
        // re-render reads detail.sections (lines are only for optimistic UI).
        const deferred = CartLinesUpdateEvent.createPromise();
        document.dispatchEvent(
          new CartLinesUpdateEvent({
            action: 'update',
            context: 'cart',
            lines: performedLines,
            promise: deferred.promise,
          })
        );
        deferred.resolve({
          cart: CartLinesUpdateEvent.createCartFromAjaxResponse(cart),
          detail: {
            sections: lastSections,
            items: cart.items,
            source: 'cart-rewards',
            didError: false,
          },
        });
      }
    } catch (error) {
      console.warn('[cart-rewards] sync failed:', error);
    } finally {
      this.#busy = false;
      // A cart change arrived while we were syncing — reconcile again so it
      // isn't lost (e.g. the threshold was crossed mid-sync).
      if (this.#pending) {
        this.#pending = false;
        this.sync();
      }
    }
  }
}

if (!window.__cartRewardsController) {
  window.__cartRewardsController = new CartRewardsController();
}
