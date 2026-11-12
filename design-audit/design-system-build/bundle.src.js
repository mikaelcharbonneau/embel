/* Embel behaviours. Plain JavaScript, no dependencies. Everything is optional: components render without it. */
(function () {
  var E = {};
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* Toast: one at a time, bottom centre, leaves after --toast-duration, pauses on hover and focus, announced politely. */
  E.toast = function (text, opts) {
    opts = opts || {};
    var region = document.querySelector('.e-toast-region');
    if (!region) { region = document.createElement('div'); region.className = 'e-toast-region'; region.setAttribute('role', 'status'); region.setAttribute('aria-live', 'polite'); document.body.appendChild(region); }
    region.textContent = '';
    var el = document.createElement('div'); el.className = 'e-toast e-on-inverse';
    var span = document.createElement('span'); span.className = 'e-toast__text'; span.textContent = text; el.appendChild(span);
    var timer, ms = opts.duration || 5000;
    function close() { clearTimeout(timer); if (el.parentNode) el.parentNode.removeChild(el); }
    function arm() { clearTimeout(timer); timer = setTimeout(close, ms); }
    if (opts.action) { var a = document.createElement('button'); a.type = 'button'; a.className = 'e-toast__action'; a.textContent = opts.action; a.addEventListener('click', function () { close(); if (opts.onAction) opts.onAction(); }); el.appendChild(a); }
    var x = document.createElement('button'); x.type = 'button'; x.className = 'e-toast__close'; x.setAttribute('aria-label', 'Dismiss');
    x.innerHTML = '<span class="e-icon e-icon--sm" data-icon="x" aria-hidden="true"></span>'; x.addEventListener('click', close); el.appendChild(x);
    ['mouseenter', 'focusin'].forEach(function (n) { el.addEventListener(n, function () { clearTimeout(timer); }); });
    ['mouseleave', 'focusout'].forEach(function (n) { el.addEventListener(n, arm); });
    region.appendChild(el); arm(); return close;
  };

  /* Tabs and segmented controls: one tab stop, arrow keys move and select. */
  function initTabs(root) {
    $$('[role="tablist"]', root).forEach(function (list) {
      var tabs = $$('[role="tab"]', list);
      function select(tab) {
        tabs.forEach(function (t) { var on = t === tab; t.setAttribute('aria-selected', on ? 'true' : 'false'); t.tabIndex = on ? 0 : -1; var p = t.getAttribute('aria-controls') && document.getElementById(t.getAttribute('aria-controls')); if (p) p.hidden = !on; });
      }
      tabs.forEach(function (t, i) {
        t.tabIndex = t.getAttribute('aria-selected') === 'true' ? 0 : -1;
        t.addEventListener('click', function () { if (!t.disabled) select(t); });
        t.addEventListener('keydown', function (e) {
          var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0; if (!d) return;
          var n = i; do { n = (n + d + tabs.length) % tabs.length; } while (tabs[n].disabled && n !== i);
          tabs[n].focus(); select(tabs[n]); e.preventDefault();
        });
      });
    });
  }

  /* Menus and popovers: open from a trigger; close on Escape, on an outside press and when focus leaves. The first outside press only closes. */
  function initMenus(root) {
    $$('[data-e-menu]', root).forEach(function (trigger) {
      var menu = document.getElementById(trigger.getAttribute('data-e-menu')); if (!menu) return;
      function open(v) { menu.hidden = !v; trigger.setAttribute('aria-expanded', v ? 'true' : 'false'); if (v) { var f = menu.querySelector('button, a, input'); if (f) f.focus(); } }
      trigger.addEventListener('click', function () { open(menu.hidden); });
      menu.addEventListener('keydown', function (e) { if (e.key === 'Escape') { open(false); trigger.focus(); } });
      document.addEventListener('pointerdown', function (e) { if (!menu.hidden && !menu.contains(e.target) && !trigger.contains(e.target)) { open(false); e.preventDefault(); } }, true);
      menu.addEventListener('focusout', function (e) { if (e.relatedTarget && !menu.contains(e.relatedTarget) && e.relatedTarget !== trigger) open(false); });
    });
  }

  /* Dialogs and drawers are native <dialog> elements: focus is trapped and returns to the opener. */
  function initDialogs(root) {
    $$('[data-e-open]', root).forEach(function (b) { b.addEventListener('click', function () { var d = document.getElementById(b.getAttribute('data-e-open')); if (d && d.showModal) d.showModal(); }); });
    $$('[data-e-close]', root).forEach(function (b) { b.addEventListener('click', function () { var d = b.closest('dialog'); if (d) d.close(); }); });
  }

  /* Range slider: keep the filled part of the track in step with the value. */
  function initRanges(root) {
    $$('.e-range input[type="range"]', root).forEach(function (r) {
      function paint() { var min = +r.min || 0, max = +r.max || 100; r.style.setProperty('--range-fill', ((r.value - min) / (max - min) * 100) + '%'); }
      r.addEventListener('input', paint); paint();
    });
  }

  E.init = function (root) { initTabs(root); initMenus(root); initDialogs(root); initRanges(root); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { E.init(document); }); else E.init(document);
  window.Embel = E;
})();
