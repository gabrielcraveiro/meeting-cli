// Content script for Microsoft Teams (web).
// Detects call join/leave and scrapes the participant roster, forwarding
// everything to the background script → meeting-cli daemon.
//
// Teams' DOM changes frequently and class names are generated, so detection
// relies on data-tid attributes and aria-labels (far more stable), with
// multiple fallbacks per element. Runs in all frames because Teams sometimes
// hosts the calling surface in an iframe.

(() => {
  const POLL_MS = 5000;
  const START_CONFIRM_POLLS = 1;  // hangup button present for N+1 polls → call started
  const END_CONFIRM_POLLS = 2;    // absent for N+1 polls → call ended (survives re-renders)

  let inCall = false;
  let presentPolls = 0;
  let absentPolls = 0;
  let sentParticipants = new Set();

  // ── Call detection ──────────────────────────────────────────

  const HANGUP_SELECTORS = [
    '#hangup-button',
    '[data-tid="hangup-main-btn"]',
    '[data-tid="hangup-btn"]',
    '[data-inp="hangup-button"]',
  ];
  const HANGUP_LABELS = /^(leave|sair|desligar|hang up|raccrocher|auflegen)/i;

  function findHangupButton() {
    for (const sel of HANGUP_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    // Fallback: any button whose aria-label starts with a "leave call" verb
    for (const btn of document.querySelectorAll('button[aria-label]')) {
      if (HANGUP_LABELS.test(btn.getAttribute('aria-label').trim())) return btn;
    }
    return null;
  }

  // ── Title ───────────────────────────────────────────────────

  function getCallTitle() {
    const el =
      document.querySelector('[data-tid="call-title"]') ||
      document.querySelector('[data-tid="calling-header-title"]') ||
      document.querySelector('h1[id*="meeting"], h2[id*="meeting"]');
    if (el && el.textContent.trim()) return el.textContent.trim();

    // document.title looks like "(3) Calendar | Nome da Reunião | Microsoft Teams"
    // — unread count prefix, app section, then the meeting name. Keep the last
    // meaningful segment before the "Microsoft Teams" suffix.
    let t = document.title
      .replace(/^\(\d+\)\s*/, '')                          // unread count "(3) "
      .replace(/\s*[|,–-]\s*Microsoft Teams.*$/i, '')
      .trim();
    const segments = t.split('|').map((s) => s.trim()).filter(Boolean);
    if (segments.length > 1) t = segments[segments.length - 1];
    return t && !/^microsoft teams$/i.test(t) ? t : '';
  }

  // ── Roster scraping ─────────────────────────────────────────

  // Names to discard: UI noise that shows up in aria-labels alongside people
  const NAME_NOISE = /\b(muted|mudo|unmuted|screen|tela|apresenta|sharing|organizer|organizador|convidado|guest|\(voc[eê]\)|\(you\))\b/gi;

  function cleanName(raw) {
    if (!raw) return '';
    let name = raw
      .replace(/,.*$/, '')            // "Fulano, Muted, ..." → aria-labels often comma-append status
      .replace(NAME_NOISE, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    // Plausibility filter: 2..60 chars, at least one letter, not a sentence
    if (name.length < 2 || name.length > 60) return '';
    if (!/\p{L}/u.test(name)) return '';
    if (name.split(' ').length > 6) return '';
    return name;
  }

  function scrapeParticipants() {
    const names = new Set();

    // 1. Participants pane (only populated when the roster panel is open)
    const rosterItems = document.querySelectorAll(
      '[data-tid="participantsInCall"] [role="listitem"], ' +
      '[data-tid="participants-list"] [role="listitem"], ' +
      '[data-tid^="participant-item"], ' +
      '[data-cid="roster-participant"]'
    );
    for (const item of rosterItems) {
      const label = item.getAttribute('aria-label') || item.textContent;
      const name = cleanName(label);
      if (name) names.add(name);
    }

    // 2. Video/audio tiles on the calling stage (works without the panel open)
    const tiles = document.querySelectorAll(
      '[data-tid="video-tile"], [data-cid="calling-participant-stream"], ' +
      '[data-tid^="participant-tile"], [data-stream-type]'
    );
    for (const tile of tiles) {
      const label = tile.getAttribute('aria-label') ||
        (tile.querySelector('[data-tid="tile-name"], [class*="displayName"], [class*="name"]') || {}).textContent;
      const name = cleanName(label);
      if (name) names.add(name);
    }

    return [...names];
  }

  // ── Main loop ───────────────────────────────────────────────

  function send(type, payload) {
    try {
      return browser.runtime.sendMessage({ type, platform: 'teams', ...payload });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  setInterval(() => {
    const hangup = findHangupButton();

    if (hangup) {
      absentPolls = 0;
      presentPolls++;
      if (!inCall && presentPolls > START_CONFIRM_POLLS) {
        inCall = true;
        sentParticipants = new Set();
        const participants = scrapeParticipants();
        participants.forEach((p) => sentParticipants.add(p));
        send('CALL_STARTED', { title: getCallTitle(), participants });
        console.log('[meeting-cli] call started:', getCallTitle());
      } else if (inCall) {
        // Incremental roster updates — new joiners (including silent listeners)
        const current = scrapeParticipants();
        const fresh = current.filter((p) => !sentParticipants.has(p));
        if (fresh.length > 0) {
          fresh.forEach((p) => sentParticipants.add(p));
          send('PARTICIPANTS', { participants: [...sentParticipants] });
          console.log('[meeting-cli] roster +', fresh.join(', '));
        }
      }
    } else {
      presentPolls = 0;
      if (inCall) {
        absentPolls++;
        if (absentPolls > END_CONFIRM_POLLS) {
          inCall = false;
          absentPolls = 0;
          send('CALL_ENDED', {});
          console.log('[meeting-cli] call ended');
        }
      }
    }
  }, POLL_MS);
})();
