/**
 * Wishlist (Favorites) — self-contained, localStorage-based.
 * Ported from mimoa's favorites behavior, adapted for the Horizon (Tinker) base.
 * No framework dependencies: defines its own <wishlist-drawer> element and
 * delegates all clicks globally so it works on any page.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'productFavoritesHandles';
  var MAX = 50;
  var REMOVAL_MS = 5000;

  var data = window.wishlistData || {};
  var STR = Object.assign(
    {
      add: 'Add to favorites',
      remove: 'Remove from favorites',
      removedTemplate: '[[product]] removed',
      undo: 'Undo',
      guestMessage: 'Log in to save your favorites across devices.'
    },
    data.strings || {}
  );

  function root() {
    if (window.Shopify && Shopify.routes && Shopify.routes.root) return Shopify.routes.root;
    return (data.root || '/');
  }

  /* ---------- storage ---------- */
  function parse(raw) {
    if (!raw) return [];
    try {
      var p = JSON.parse(raw);
      return Array.isArray(p) ? p.filter(Boolean) : [];
    } catch (e) {
      return [];
    }
  }
  function read() {
    return parse(localStorage.getItem(STORAGE_KEY));
  }
  function write(handles) {
    var normalized = (Array.isArray(handles) ? handles : []).filter(Boolean).slice(0, MAX);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    } catch (e) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized.slice(0, 20)));
      } catch (e2) {}
    }
    document.dispatchEvent(new CustomEvent('update-favorites'));
    return normalized;
  }

  /* ---------- card cache ---------- */
  var cache = new Map();

  function cacheFromHtml(html) {
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    tmp.querySelectorAll('.favorite__item').forEach(function (item) {
      var handle = item.getAttribute('data-handle');
      if (handle && !cache.has(handle)) cache.set(handle, item.cloneNode(true));
    });
  }

  function fetchCard(handle) {
    return fetch(root() + 'products/' + encodeURIComponent(handle) + '?view=favorite')
      .then(function (res) {
        if (!res.ok) {
          if (res.status === 404) {
            write(read().filter(function (h) { return h !== handle; }));
            cache.delete(handle);
          }
          return null;
        }
        return res.text();
      })
      .then(function (html) {
        if (html) cacheFromHtml(html);
        return cache.get(handle) || null;
      })
      .catch(function () { return null; });
  }

  /* ---------- cart attribute mirror ---------- */
  var lastMirrored = data.serverHasFavorites === true;
  function syncCartAttribute(hasFavorites) {
    if (hasFavorites === lastMirrored) return;
    lastMirrored = hasFavorites;
    fetch(root() + 'cart/update.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attributes: { user_favorites: hasFavorites } })
    }).catch(function () {});
  }

  /* ---------- cross-site sync ---------- */
  function updateAcrossSite(scope) {
    var handles = read();
    var set = new Set(handles);
    var hasFavorites = handles.length > 0;
    var rootEl = scope || document;

    rootEl.querySelectorAll('[data-action="toggle-favorites"]').forEach(function (btn) {
      var handle = btn.getAttribute('data-handle');
      if (!handle) {
        var card = btn.closest('[handle]');
        handle = card ? card.getAttribute('handle') : null;
        if (handle) btn.setAttribute('data-handle', handle);
      }
      if (!handle) return;
      var active = set.has(handle);
      btn.setAttribute('state', active ? 'active' : 'not-active');
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.setAttribute('aria-label', active ? STR.remove : STR.add);
    });

    document.querySelectorAll('.wishlist-count').forEach(function (el) {
      el.textContent = handles.length > 0 ? '(' + handles.length + ')' : '';
    });
    document.querySelectorAll('.wishlist-trigger').forEach(function (el) {
      el.classList.toggle('has-favorites', hasFavorites);
    });
  }

  /* ---------- drawer element ---------- */
  var WishlistDrawer = class extends HTMLElement {
    constructor() {
      super();
      this._open = false;
      this._removalTimeout = null;
      this._removalActive = false;
      this._undoHandle = null;
      this._undoTitle = '';
    }

    connectedCallback() {
      this.content = this.querySelector('.js-favorites-drawer-content');
      this.sectionId = this.getAttribute('section-id') || 'favorites-drawer';
      this.guestEnabled = this.getAttribute('data-guest-message') === 'true';

      this.addEventListener('click', function (e) {
        if (e.target.closest('[data-wishlist-close]')) this.close();
      }.bind(this));

      var undo = this.querySelector('[data-removal-undo]');
      if (undo) undo.addEventListener('click', this.onUndo.bind(this));

      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && this._open) this.close();
      }.bind(this));

      window.addEventListener('storage', function (e) {
        if (e.key === STORAGE_KEY) {
          updateAcrossSite();
          if (this._open) this.render();
        }
      }.bind(this));
    }

    open() {
      this._open = true;
      this.classList.add('is-open');
      this.setAttribute('aria-hidden', 'false');
      document.documentElement.classList.add('wishlist-open');
      this.render();
      this.updateGuestMessage();
      var closeBtn = this.querySelector('[data-wishlist-close]');
      if (closeBtn) closeBtn.focus();
    }

    close() {
      this._open = false;
      this.classList.remove('is-open');
      this.setAttribute('aria-hidden', 'true');
      document.documentElement.classList.remove('wishlist-open');
      this.hideRemovalToast(true);
      this.hideGuestMessage();
    }

    toggle() {
      if (this._open) this.close(); else this.open();
    }

    /* render the drawer body from storage */
    render() {
      if (!this.content) return;
      var handles = read();
      if (handles.length === 0) {
        this.renderEmptyState();
        return;
      }
      this.content.classList.add('favorites-grid');
      this.content.innerHTML = '';
      var missing = [];
      handles.forEach(function (handle) {
        var node = cache.get(handle);
        if (node) {
          var wrap = document.createElement('div');
          wrap.className = 'favorite__item';
          wrap.setAttribute('data-handle', handle);
          wrap.innerHTML = node.innerHTML;
          this.content.appendChild(wrap);
        } else {
          missing.push(handle);
        }
      }.bind(this));
      if (missing.length) {
        Promise.all(missing.map(fetchCard)).then(function () {
          if (this._open) this.render();
        }.bind(this));
      }
      updateAcrossSite(this.content);
    }

    renderEmptyState() {
      if (!this.content) return;
      this.content.classList.remove('favorites-grid');
      fetch(root() + '?sections=' + encodeURIComponent(this.sectionId))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (json) {
          if (!json || !this.content) return;
          var html = json[this.sectionId];
          if (!html) return;
          var tmp = document.createElement('div');
          tmp.innerHTML = html;
          var src = tmp.querySelector('.js-favorites-drawer-content');
          if (src) this.content.innerHTML = src.innerHTML;
        }.bind(this))
        .catch(function () {});
    }

    /* toggle a favorite */
    toggleFavorite(trigger) {
      var handle = trigger.getAttribute('data-handle');
      if (!handle) {
        var card = trigger.closest('[handle]');
        handle = card ? card.getAttribute('handle') : null;
        if (handle) trigger.setAttribute('data-handle', handle);
      }
      if (!handle) return;
      var handles = read();
      var isFavorite = handles.indexOf(handle) !== -1;
      if (isFavorite) {
        this.removeFavorite(handle, trigger);
      } else {
        this.addFavorite(handle, trigger);
      }
    }

    addFavorite(handle, trigger) {
      var handles = read();
      if (handles.indexOf(handle) === -1) {
        handles.unshift(handle);
        var saved = write(handles);
        syncCartAttribute(saved.length > 0);
      }
      updateAcrossSite();
      // cache card from the originating product card if present
      var sourceCard = trigger && trigger.closest ? trigger.closest('[handle]') : null;
      if (!cache.has(handle)) {
        fetchCard(handle).then(function () {
          if (this._open) this.render();
        }.bind(this));
      } else if (this._open) {
        this.render();
      }
      if (this._open) this.render();
    }

    removeFavorite(handle, trigger) {
      var title = (trigger && trigger.getAttribute('data-title')) || '';
      var handles = read().filter(function (h) { return h !== handle; });
      var saved = write(handles);
      cache.delete(handle);
      syncCartAttribute(saved.length > 0);
      updateAcrossSite();
      if (this._open) {
        var card = this.content && this.content.querySelector('.favorite__item[data-handle="' + (window.CSS && CSS.escape ? CSS.escape(handle) : handle) + '"]');
        if (card) card.remove();
        if (read().length === 0) this.renderEmptyState();
      }
      this.showRemovalToast(title, handle);
    }

    /* removal toast + undo */
    showRemovalToast(title, handle) {
      var toast = this.querySelector('[data-removal-toast]');
      var text = this.querySelector('.favorites-removal-toast__text');
      var undo = this.querySelector('[data-removal-undo]');
      var fill = this.querySelector('[data-removal-border]');
      if (!toast || !text) return;
      this._removalActive = true;
      this._undoHandle = handle;
      this._undoTitle = title;
      toast.classList.remove('is-persistent');
      text.textContent = STR.removedTemplate.indexOf('[[product]]') !== -1
        ? STR.removedTemplate.replace(/\[\[product\]\]/g, title || '')
        : (STR.removedTemplate || title || '');
      if (undo) undo.hidden = !handle;
      if (fill) {
        fill.classList.remove('is-running');
        fill.style.animationDuration = '';
        void fill.offsetWidth;
        fill.style.animationDuration = (REMOVAL_MS / 1000) + 's';
        fill.classList.add('is-running');
      }
      toast.classList.add('is-visible');
      if (this._removalTimeout) clearTimeout(this._removalTimeout);
      this._removalTimeout = setTimeout(this.hideRemovalToast.bind(this), REMOVAL_MS);
    }

    hideRemovalToast(skipGuest) {
      var toast = this.querySelector('[data-removal-toast]');
      var undo = this.querySelector('[data-removal-undo]');
      var fill = this.querySelector('[data-removal-border]');
      if (this._removalTimeout) { clearTimeout(this._removalTimeout); this._removalTimeout = null; }
      this._removalActive = false;
      if (toast) toast.classList.remove('is-visible', 'is-persistent');
      if (undo) undo.hidden = true;
      this._undoHandle = null;
      this._undoTitle = '';
      if (fill) { fill.classList.remove('is-running'); fill.style.animationDuration = ''; }
      if (!skipGuest) this.updateGuestMessage();
    }

    onUndo(e) {
      if (e) e.preventDefault();
      var handle = this._undoHandle;
      if (!handle) return;
      var title = this._undoTitle;
      if (this._removalTimeout) { clearTimeout(this._removalTimeout); this._removalTimeout = null; }
      this._undoHandle = null;
      this._undoTitle = '';
      var handles = read();
      if (handles.indexOf(handle) === -1) {
        handles.unshift(handle);
        var saved = write(handles);
        syncCartAttribute(saved.length > 0);
      }
      updateAcrossSite();
      if (!cache.has(handle)) {
        fetchCard(handle).then(function () { if (this._open) this.render(); }.bind(this));
      } else if (this._open) {
        this.render();
      }
      this.hideRemovalToast();
    }

    /* guest "log in to save" message */
    updateGuestMessage() {
      if (!this._open || this._removalActive) return;
      var show = false; /* guest prompt is now a static footer (.wishlist-drawer__account) in favorites-drawer.liquid */
      if (show) this.showGuestMessage(); else this.hideGuestMessage();
    }
    showGuestMessage() {
      var toast = this.querySelector('[data-removal-toast]');
      var text = this.querySelector('.favorites-removal-toast__text');
      var undo = this.querySelector('[data-removal-undo]');
      var fill = this.querySelector('[data-removal-border]');
      if (!toast || !text) return;
      text.textContent = STR.guestMessage;
      if (undo) undo.hidden = true;
      if (fill) { fill.classList.remove('is-running'); fill.style.animationDuration = ''; }
      toast.classList.add('is-visible', 'is-persistent');
    }
    hideGuestMessage() {
      var toast = this.querySelector('[data-removal-toast]');
      if (!toast || this._removalActive) return;
      toast.classList.remove('is-visible', 'is-persistent');
    }
  };

  if (!customElements.get('wishlist-drawer')) {
    customElements.define('wishlist-drawer', WishlistDrawer);
  }

  function drawer() {
    return document.querySelector('wishlist-drawer');
  }

  /* ---------- global delegation ---------- */
  document.addEventListener('click', function (e) {
    var openTrigger = e.target.closest('[data-wishlist-open]');
    if (openTrigger) {
      e.preventDefault();
      var d = drawer();
      if (d) d.open();
      return;
    }
    var toggle = e.target.closest('[data-action="toggle-favorites"]');
    if (toggle) {
      e.preventDefault();
      e.stopPropagation();
      var d2 = drawer();
      if (d2) d2.toggleFavorite(toggle);
      else updateAcrossSite();
      return;
    }
  }, true);

  document.addEventListener('update-favorites', function () { updateAcrossSite(); });

  function init() {
    // The header trigger is rendered server-side in header-actions.liquid
    // (so it follows the header Utilities settings). We just sync state here.
    updateAcrossSite();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
