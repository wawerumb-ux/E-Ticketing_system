/**
 * ProfileDialog — vanilla JS implementation following the project's existing
 * patterns (TicketingApp class structure, Icons.render, CSS variables, focus
 * trap from session-expired dialog). No frameworks, no JSX, no build step.
 *
 * Keyboard:
 *   - Open: Trigger button (Enter/Space)
 *   - Flip:   ArrowRight front→back, ArrowLeft back→front when focus is on the
 *             dialog container or non-list controls. When focus is inside an
 *             option list (quick links, toggle buttons), arrows rove within the
 *             list instead.
 *   - Close:  Escape key, focus returns to trigger
 *   - Trigger:  aria-haspopup="dialog", aria-expanded
 *   - RTL:      mirror flip direction and swap arrow key bindings
 *   - Reduced-motion: 150ms crossfade via prefers-reduced-motion
 */

class ProfileDialog {
  /**
   * @param {string} triggerSel  CSS selector for the profile trigger button
   */
  constructor(triggerSel) {
    this.trigger = document.querySelector(triggerSel);
    if (!this.trigger) {
      console.error('ProfileDialog: trigger not found', triggerSel);
      return;
    }

    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.flipState = 'closed'; // 'closed' | 'front' | 'back'
    this.dialog = null;
    this.portal = null;
    this.flipCard = null;
    this.frontFace = null;
    this.backFace = null;
    this.liveRegion = null;
    this.focusableInFront = [];
    this.focusableInBack = [];

    this.init();
  }

  /** ----------------------------------------------------------- creation */
  init() {
    // 1. portal
    this.portal = document.createElement('div');
    this.portal.className = 'profile-dialog-portal';
    document.body.appendChild(this.portal);

    // 2. dialog element
    this.dialog = document.createElement('div');
    this.dialog.className = 'profile-dialog';
    this.portal.appendChild(this.dialog);

    // 3. flip card + faces
    this.flipCard = document.createElement('div');
    this.flipCard.className = 'profile-flip-card';
    this.dialog.appendChild(this.flipCard);

    this.frontFace = document.createElement('div');
    this.frontFace.className = 'profile-face profile-front';
    this.flipCard.appendChild(this.frontFace);

    this.backFace = document.createElement('div');
    this.backFace.className = 'profile-face profile-back';
    this.flipCard.appendChild(this.backFace);

    // 4. live region for aria-live announcements
    this.liveRegion = document.createElement('div');
    this.liveRegion.className = 'profile-live-region';
    this.liveRegion.setAttribute('role', 'status');
    this.liveRegion.setAttribute('aria-live', 'polite');
    this.liveRegion.setAttribute('aria-busy', 'false');
    document.body.appendChild(this.liveRegion);

    // 5. populate faces
    this._populateFrontFace();
    this._populateBackFace();

    // 6. flip buttons (chevron) on each face
    this._addFlipButtons();

    // 7. trigger button click opens/closes the dialog
    this.trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.isOpen()) this.close();
      else this._open();
    });

    // 7. focus trap setup
    this._setupFocusTrap();

    // 8. keyboard handling
    this._setupKeyHandlers();

    // 9. initial ARIA on trigger
    this._updateTriggerAria('expanded', false);

  /** ----------------------------------------------------------- content */
  _populateFrontFace() {
    // avatar area
    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'profile-avatar-wrap';
    const initialSVG = Icons.render('user');
    avatarWrap.innerHTML = initialSVG;
    this.frontFace.appendChild(avatarWrap);

    const name = document.createElement('div');
    name.className = 'profile-name';
    name.textContent = 'Jane Doe';
    this.frontFace.appendChild(name);

    const handle = document.createElement('div');
    handle.className = 'profile-handle';
    handle.textContent = '@jdoe';
    this.frontFace.appendChild(handle);

    // status selector
    const statusWrap = document.createElement('div');
    statusWrap.className = 'profile-status';
    const statusLabel = document.createElement('span');
    statusLabel.textContent = 'Status:';
    statusWrap.appendChild(statusLabel);
    const statusChoices = ['Online', 'Away', 'Busy'];
    statusChoices.forEach((choice, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'profile-status-btn';
      btn.dataset.value = choice;
      btn.tabIndex = 0;
      btn.textContent = choice;
      if (i === 0) btn.classList.add('profile-status-btn--selected');
      btn.addEventListener('click', () => {
        document.querySelectorAll('.profile-status-btn')
          .forEach(b => b.classList.remove('profile-status-btn--selected'));
        btn.classList.add('profile-status-btn--selected');
      });
      this.frontFace.appendChild(btn);
    });

    // quick links (option list — arrow roving navigation applies here)
    const quickLinks = document.createElement('ul');
    quickLinks.className = 'profile-quick-links';
    quickLinks.setAttribute('role', 'list');
    const links = ['Tickets', 'Knowledge', 'Settings', 'Help'];
    links.forEach(text => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = text;
      a.className = 'profile-quick-link';
      li.appendChild(a);
      quickLinks.appendChild(li);
    });
    this.frontFace.appendChild(quickLinks);

    this.focusableInFront = this._getFocusable(this.frontFace);
  }

  _populateBackFace() {
    // grouped settings
    const settings = document.createElement('div');
    settings.className = 'profile-settings';

    // Appearance toggle
    const appearance = this._makeToggleRow('Appearance', 'Light', 'Dark', 'High contrast');
    settings.appendChild(appearance);

    // Language toggle
    const language = this._makeToggleRow('Language', 'English', 'Français', 'Español');
    settings.appendChild(language);

    // Notifications toggle
    const notifications = this._makeToggleRow('Notifications', 'On', 'Off');
    settings.appendChild(notifications);

    // Sign-out pinned at bottom
    const signout = document.createElement('div');
    signout.className = 'profile-signout-section';
    const signBtn = document.createElement('button');
    signBtn.className = 'profile-signout';
    signBtn.textContent = 'Sign out';
    signBtn.addEventListener('click', () => this._handleSignOut());
    signout.appendChild(signBtn);
    settings.appendChild(signout);

    this.backFace.appendChild(settings);

    this.focusableInBack = this._getFocusable(this.backFace);
  }

  _makeToggleRow(label, opt1, opt2, fallback) {
    const row = document.createElement('div');
    row.className = 'profile-toggle-row';

    const lbl = document.createElement('span');
    lbl.textContent = label;
    row.appendChild(lbl);

    const grp = document.createElement('div');
    grp.className = 'profile-toggle-group';

    const r1 = document.createElement('button');
    r1.type = 'button';
    r1.className = 'profile-toggle-btn';
    r1.dataset.value = opt1;
    r1.tabIndex = 0;
    r1.textContent = opt1;
    r1.addEventListener('click', () => this._toggleSelect(r1, opt1));

    const r2 = document.createElement('button');
    r2.type = 'button';
    r2.className = 'profile-toggle-btn';
    r2.classList.add('profile-toggle-btn--secondary');
    r2.data.value = opt2;
    r2.tabIndex = 0;
    r2.textContent = opt2;
    r2.addEventListener('click', () => this._toggleSelect(r2, opt2));

    grp.appendChild(r1);
    grp.appendChild(r2);
    row.appendChild(grp);

    return row;
  }

  _toggleSelect(selectedBtn, value) {
    document.querySelectorAll('.profile-toggle-btn')
      .forEach(b => b.classList.remove('profile-toggle-btn--selected'));
    selectedBtn.classList.add('profile-toggle-btn--selected');
  }

  _addFlipButtons() {
    // front face flip button
    const frontBtn = document.createElement('button');
    frontBtn.className = 'profile-flip-button';
    frontBtn.setAttribute('aria-label', 'Show settings');
    frontBtn.innerHTML = Icons.render('chevron-down');
    frontBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._flipTo('back');
    });
    this.frontFace.appendChild(frontBtn);

    // back face flip button
    const backBtn = document.createElement('button');
    backBtn.className = 'profile-flip-button';
    backBtn.setAttribute('aria-label', 'Show profile');
    backBtn.innerHTML = Icons.render('chevron-up');
    backBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._flipTo('front');
    });
    this.backFace.appendChild(backBtn);
  }

  /** ----------------------------------------------------------- focus trap */
  _setupFocusTrap() {
    // collect all focusable elements within the dialog (portal-level)
    this._dialogFocusables = this._getFocusable(this.dialog);

    this.dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.close();
        return;
      }
      if (e.key !== 'Tab') return;

      const focusables = this._dialogFocusables;
      if (focusables.length === 0) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const previouslyFocused = document.activeElement;

      if (e.shiftKey) {
        if (previouslyFocused === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (previouslyFocused === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });
  }

  /** ----------------------------------------------------------- key handling */
  _setupKeyHandlers() {
    // global keydown: arrow flip, escape close
    const rtl = document.documentElement.getAttribute('dir') === 'rtl';
    const arrowMap = {
      // LTR: ArrowRight = front→back, ArrowLeft = back→front
      // RTL:  ArrowRight = back→front,  ArrowLeft = front→back
      // we build the direction map dynamically below
    };

    document.addEventListener('keydown', (e) => {
      // Escape always closes when pressing outside the dialog or from inside
      if (e.key === 'Escape') {
        if (this.isOpen()) this.close();
        return;
      }

      // Arrow flips only when dialog is open and focus is in the right place
      if (!this.isOpen()) return;
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;

      // Determine if focus is inside an option list that should use roving nav
      const focusedInOptionList = this._focusedInOptionList(e.target);
      if (focusedInOptionList) {
        // handle roving navigation within the option list
        this._roveWithinOptionList(e);
        return;
      }

      // Determine flip direction, accounting for RTL
      const isRightKey = e.key === 'ArrowRight';
      // In LTR: right arrow = front→back (if currently front) or back→front (if currently back)
      // In RTL: right arrow = back→front, left arrow = front→back (mirrored)
      const forwardKey = rtl ? !isRightKey : isRightKey; // ArrowRight maps to "forward" direction
      const to = forwardKey
        ? this.flipState === 'front' ? 'back' : 'front'
        : this.flipState === 'back' ? 'front' : 'back';
      this._flipTo(to);
    });
  }

  _focusedInOptionList(target) {
    // Check if the focused element (or its ancestor) is inside a quick-links
    // or settings option list where arrow roving takes precedence over flip.
    const candidates = [
      ...document.querySelectorAll('.profile-quick-links li'),
      ...document.querySelectorAll('.profile-toggle-btn'),
      ...document.querySelectorAll('.profile-option'),
    ];
    return candidates.some(el => el.contains(target) || target === el);
  }

  /** ----------------------------------------------------------- roving navigation within option lists */
  _roveWithinOptionList(e) {
    // determine direction: ArrowRight = next, ArrowLeft = previous
    const isRTL = document.documentElement.getAttribute('dir') === 'rtl';
    const step = isRTL ? (e.key === 'ArrowLeft' ? 1 : -1) : (e.key === 'ArrowRight' ? 1 : -1);

    // find which option list the focused element belongs to, and move focus
    const focusableSelectors = [
      '.profile-quick-links li a',
      '.profile-toggle-btn',
    ].join(', ');

    const focusableEls = Array.from(document.querySelectorAll(focusableSelectors));
    const currentIdx = focusableEls.indexOf(document.activeElement);
    if (currentIdx === -1) return; // not currently in a list

    const nextIdx = (currentIdx + step + focusableEls.length) % focusableEls.length;
    focusableEls[nextIdx].focus();
  }

  /** ----------------------------------------------------------- flip logic */
  _flipTo(target) {
    if (this.flipState === target) return;

    // Announce
    this._announceFace(target);

    // Reduced-motion crossfade
    if (this.reducedMotion) {
      this._crossfadeTo(target);
      this.flipState = target;
      this._moveFocusToFirstFocusable(target);
      return;
    }

    // 3D flip — mirror direction in RTL
    const rtl = document.documentElement.getAttribute('dir') === 'rtl';
    const card = this.flipCard;
    this.flipState = target;

    if (target === 'front') {
      // Back→front: normally rotate -180deg (direction continuity)
      // In RTL, mirror by using +180deg
      card.classList.toggle('flipped', !rtl);
      card.classList.toggle('flipped-reverse', rtl);
    } else {
      // front→back: normally rotate +180deg
      // In RTL, mirror by using -180deg
      card.classList.toggle('flipped', rtl);
      card.classList.toggle('flipped-reverse', !rtl);
    }
    // force a style recalc so the transition animates from the current state
    card.offsetWidth; // eslint-disable-line

    // focus moves to the revealed face
    this._moveFocusToFirstFocusable(target);

    // remove transition classes after animation so the next flip starts clean
    const resolve = () => {
      card.classList.remove('flipped', 'flipped-reverse');
    };
    setTimeout(resolve, 600);
  }

  _crossfadeTo(target) {
    // swap opacities instead of 3D transform
    const fromFace = this.flipState === 'front' ? this.frontFace : this.backFace;
    const toFace = target === 'front' ? this.frontFace : this.backFace;

    fromFace.style.transition = 'opacity 150ms ease-in-out';
    toFace.style.transition = 'opacity 150ms ease-in-out';

    fromFace.style.opacity = '0';
    toFace.style.opacity = '1';

    // after animation, reset classes / inline styles so the next crossfade works
    setTimeout(() => {
      fromFace.style.opacity = '';
      fromFace.style.transition = '';
      toFace.style.opacity = '';
      toFace.style.transition = '';
    }, 150);
  }

  _moveFocusToFirstFocusable(target) {
    const focusables = target === 'front'
      ? this.focusableInFront
      : this.focusableInBack;
    // When focus lands on the back face, pick the first focusable that is
    // NOT a toggle button, so that ArrowLeft/Right default to flipping
    // rather than roving within the toggle list.
    if (target === 'back') {
      const nonToggle = focusables.filter(el => !el.classList.contains('profile-toggle-btn'));
      if (nonToggle.length > 0) {
        nonToggle[0].focus();
        return;
      }
    }
    if (focusables.length > 0) {
      focusables[0].focus();
    }
  }

  /** ----------------------------------------------------------- announcements */
  _announceFace(face) {
    const texts = {
      front: 'Profile front face visible',
      back: 'Settings face visible',
    };
    this.liveRegion.textContent = texts[face] || '';
    this.liveRegion.setAttribute('aria-busy', 'false');
  }

  /** ----------------------------------------------------------- open/close */
  _open() {
    this.dialog.classList.add('profile-dialog--open');
    this.portal.classList.add('profile-dialog-portal--active');
    this.trigger.setAttribute('aria-expanded', 'true');
    // move focus into the dialog
    const firstFocusable = this._dialogFocusables[0];
    if (firstFocusable) firstFocusable.focus();
    this._updateTriggerAria('expanded', true);
  }

  close() {
    if (!this.isOpen()) return;

    this.dialog.classList.remove('profile-dialog--open');
    this.portal.classList.remove('profile-dialog-portal--active');
    this.trigger.setAttribute('aria-expanded', 'false');
    // restore focus to trigger
    if (typeof this.trigger.focus === 'function') this.trigger.focus();
    this._updateTriggerAria('expanded', false);
  }

  isOpen() {
    return this.dialog.classList.contains('profile-dialog--open');
  }

  _updateTriggerAria(prop, value) {
    this.trigger.setAttribute(prop, value);
  }

  /** ----------------------------------------------------------- sign out */
  _handleSignOut() {
    // destructive action — just close the dialog for this demo
    this.close();
    // in a real app: show confirmation, clear session, etc.
  }

  /** ----------------------------------------------------------- utility */
  _getFocusable(container) {
    const selectors = [
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ];
    return Array.from(container.querySelectorAll(selectors))
      .filter(el => el.offsetParent !== null); // visible
  }
}

/* eslint-disable no-unused-vars */