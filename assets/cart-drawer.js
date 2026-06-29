import { Component } from '@theme/component';
import { StandardEvents } from '@shopify/events';
import { DrawerOpenEvent, DrawerCloseEvent } from '@theme/theme-drawer';

/**
 * A custom element that manages cart drawer behavior within a `<theme-drawer>`.
 *
 * Dialog lifecycle (open/close, squeeze, history, animations) is owned by `<theme-drawer>`.
 * The `cart:view` event is auto-dispatched by `CartItemsComponent` via the
 * `view-event-trigger="dialog"` attribute (see `snippets/cart-items-component.liquid`).
 * Cart count announcements are owned by `<header-actions>`.
 * This component handles the remaining cart-specific concerns: auto-open on add-to-cart,
 * sticky summary layout, and the installments CTA close-on-click.
 *
 * @extends {Component}
 */
class CartDrawerComponent extends Component {
  /** @type {number} */
  #summaryThreshold = 0.5;

  /** @type {import('@theme/theme-drawer').ThemeDrawer | null} */
  get #themeDrawer() {
    return /** @type {import('@theme/theme-drawer').ThemeDrawer | null} */ (this.closest('theme-drawer'));
  }

  /** @type {HTMLDialogElement | null} */
  get #dialog() {
    return this.closest('dialog');
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener(StandardEvents.cartLinesUpdate, this.#handleCartLinesUpdate);
    this.#themeDrawer?.addEventListener(DrawerOpenEvent.eventName, this.#handleDrawerOpen);
    this.#themeDrawer?.addEventListener(DrawerCloseEvent.eventName, this.#handleDrawerClose);

    // The restore path sets [open] before this module loads, so the
    // theme-drawer:open event will have already fired. Use the attribute
    // check so this works even before <theme-drawer> upgrades.
    if (this.#themeDrawer?.hasAttribute('open')) {
      this.#handleDrawerOpen();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener(StandardEvents.cartLinesUpdate, this.#handleCartLinesUpdate);
    this.#themeDrawer?.removeEventListener(DrawerOpenEvent.eventName, this.#handleDrawerOpen);
    this.#themeDrawer?.removeEventListener(DrawerCloseEvent.eventName, this.#handleDrawerClose);
  }

  /**
   * Handles the theme-drawer opening — updates sticky state and wires up the installments CTA.
   */
  #handleDrawerOpen = () => {
    // Freeze background page scroll while the drawer is open. The drawer is a
    // modal overlay at all widths, so the page behind must not scroll — without
    // this the page keeps its own scrollbar next to the drawer's, giving the
    // appearance of "two scrollbars". Idempotent with the theme's modal lock.
    document.documentElement.setAttribute('scroll-lock', '');

    // Reconcile free-gift rewards whenever the drawer opens. Opening the drawer
    // is the moment the shopper sees the cart, so this guarantees an eligible
    // gift is added/shown even if the live cartLinesUpdate reconcile was missed
    // or raced — no hard refresh required. sync() no-ops if already in sync.
    /** @type {any} */ (window).__cartRewardsController?.sync?.();

    this.#updateStickyState();

    // Close cart drawer when installments CTA is clicked to avoid overlapping dialogs.
    // Re-queried on every open so it survives cart content re-renders that
    // replace the shopify-payment-terms shadow root.
    customElements.whenDefined('shopify-payment-terms').then(() => {
      const cta = this.querySelector('shopify-payment-terms')?.shadowRoot?.querySelector('#shopify-installments-cta');
      cta?.addEventListener('click', () => this.#themeDrawer?.close(), { once: true });
    });
  };

  /**
   * Releases the background scroll lock once the drawer closes — but only if no
   * other drawer is still open. The closing drawer's [open] attribute is already
   * removed before DrawerCloseEvent fires, so it won't match its own selector.
   */
  #handleDrawerClose = () => {
    if (!document.querySelector('theme-drawer[open]')) {
      document.documentElement.removeAttribute('scroll-lock');
    }
  };

  /**
   * @param {import('@shopify/events').CartLinesUpdateEvent} event
   */
  #handleCartLinesUpdate = (event) => {
    const shouldAutoOpen = this.hasAttribute('auto-open') && event.action === 'add' && !this.#themeDrawer?.isOpen;

    // When the event originates inside an open MODAL <dialog> (e.g. quick-add),
    // defer the auto-open until that dialog's native `close` fires so its focus
    // restoration runs first — otherwise we'd capture the wrong
    // `#previouslyFocused`. Non-modal dialogs (e.g. the hotspot preview) don't
    // close on add and don't move focus, so `:modal` excludes them.
    const sourceModal = /** @type {HTMLDialogElement | null} */ (
      event.target instanceof Element ? event.target.closest('dialog:modal') : null
    );

    if (shouldAutoOpen && !sourceModal && !this.#isCartEmpty()) {
      this.#themeDrawer?.open();
    }

    event.promise
      ?.then(({ detail }) => {
        const settle = () => requestAnimationFrame(() => this.#updateStickyState());

        if (!shouldAutoOpen || detail?.didError) {
          settle();
          return;
        }

        const openAndSettle = () => {
          if (!this.#themeDrawer?.isOpen) this.#themeDrawer?.open();
          settle();
        };

        if (sourceModal?.open) {
          sourceModal.addEventListener('close', openAndSettle, { once: true });
        } else {
          openAndSettle();
        }
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') console.warn('[cart-drawer] Event promise rejected:', error);
      });
  };

  #isCartEmpty() {
    return Boolean(this.querySelector('.cart-drawer--empty'));
  }

  #updateStickyState() {
    const dialog = this.#dialog;
    if (!dialog) return;

    // Refs do not cross nested `*-component` boundaries (e.g., `cart-items-component`), so we query within the dialog.
    const content = dialog.querySelector('.cart-drawer__content');
    const summary = dialog.querySelector('.cart-drawer__summary');

    if (!content || !summary) {
      // Ensure the dialog doesn't get stuck in "unsticky" mode when summary disappears (e.g., empty cart).
      dialog.setAttribute('cart-summary-sticky', 'false');
      return;
    }

    const drawerHeight = dialog.getBoundingClientRect().height;
    const summaryHeight = summary.getBoundingClientRect().height;
    const ratio = summaryHeight / drawerHeight;
    dialog.setAttribute('cart-summary-sticky', ratio > this.#summaryThreshold ? 'false' : 'true');
  }
}

if (!customElements.get('cart-drawer-component')) {
  customElements.define('cart-drawer-component', CartDrawerComponent);
}
