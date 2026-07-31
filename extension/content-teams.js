// Content script for Microsoft Teams (web).
// Detects call join/leave, scrapes the participant roster, and builds a
// speaker timeline from Teams live captions — forwarding everything to the
// background script → meeting-cli daemon.
//
// Selectors are based on data-tid attributes (stable across Teams re-renders)
// and cross-checked with the Zerg00s/Live-Captions-Saver extension, which
// maintains them against current Teams. Runs in all frames because Teams
// sometimes hosts the calling surface in an iframe.
//
// Speaker timeline strategy: Teams live captions render "author: text" in the
// DOM with the REAL name per utterance. We sample the active caption every 2s
// and aggregate into spans {who, start, end}. Deepgram remains the quality
// transcript; this timeline is the ground truth for speaker identity.

(() => {
  const POLL_MS = 5000;          // call state + roster
  const SPEECH_POLL_MS = 2000;   // active caption sampling
  const SPEECH_FLUSH_MS = 10000; // send spans to daemon
  const START_CONFIRM_POLLS = 1; // hangup button present for N+1 polls → call started
  const END_CONFIRM_POLLS = 2;   // absent for N+1 polls → call ended (survives re-renders)

  const SEL = {
    HANGUP: [
      '#hangup-button',
      'div#hangup-button button',
      "button[data-tid='hangup-main-btn']",
      "button[data-tid='hangup-leave-button']",
      "button[data-tid='hangup-end-meeting-button']",
      '[data-tid="hangup-main-btn"]',
    ].join(','),
    // Captions (Live-Captions-Saver battle-tested)
    CAPTIONS_RENDERER: "[data-tid='closed-caption-v2-window-wrapper'], [data-tid='closed-captions-renderer'], [data-tid*='closed-caption']",
    CAPTION_MESSAGE: '.fui-ChatMessageCompact',
    CAPTION_AUTHOR: '[data-tid="author"]',
    // Captions auto-enable chain
    MORE_BUTTON: "button[data-tid='more-button'], button[id='callingButtons-showMoreBtn']",
    LANGUAGE_SPEECH_MENU: "div[id='LanguageSpeechMenuControl-id']",
    TURN_ON_CAPTIONS: "div[id='closed-captions-button']",
    // Roster
    ROSTER_ITEM: "[data-tid^='participantsInCall-']",
    ROSTER_NAME: "[id^='roster-avatar-img-']",
    PEOPLE_BUTTON: "button[data-tid='calling-toolbar-people-button'], button[id='roster-button']",
  };

  let inCall = false;
  let presentPolls = 0;
  let absentPolls = 0;
  let callStartMs = 0;
  let sentParticipants = new Set();

  // Speech timeline state
  let speechSpans = [];        // finalized spans {who, start, end} (secs since call start)
  let currentSpan = null;      // span being extended
  let lastFlushedCount = 0;
  let captionsEnableAttempts = 0;
  let lastEnableAttempt = 0;

  const HANGUP_LABELS = /^(leave|sair|desligar|hang up|raccrocher|auflegen)/i;

  function findHangupButton() {
    const el = document.querySelector(SEL.HANGUP);
    if (el) return el;
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
    let t = document.title
      .replace(/^\(\d+\)\s*/, '')
      .replace(/\s*[|,–-]\s*Microsoft Teams.*$/i, '')
      .trim();
    const segments = t.split('|').map((s) => s.trim()).filter(Boolean);
    if (segments.length > 1) t = segments[segments.length - 1];
    return t && !/^microsoft teams$/i.test(t) ? t : '';
  }

  // ── Roster scraping ─────────────────────────────────────────

  const NAME_NOISE = /\b(muted|mudo|unmuted|screen|tela|apresenta|sharing|organizer|organizador|convidado|guest|\(voc[eê]\)|\(you\))\b/gi;

  function cleanName(raw) {
    if (!raw) return '';
    let name = raw
      .replace(/,.*$/, '')
      .replace(NAME_NOISE, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (name.length < 2 || name.length > 60) return '';
    if (!/\p{L}/u.test(name)) return '';
    if (name.split(' ').length > 6) return '';
    return name;
  }

  function scrapeParticipants() {
    const names = new Set();

    // Roster panel items (needs the people panel opened at least once)
    for (const item of document.querySelectorAll(SEL.ROSTER_ITEM)) {
      const nameEl = item.querySelector(SEL.ROSTER_NAME);
      const name = cleanName(nameEl ? nameEl.textContent : (item.getAttribute('aria-label') || item.textContent));
      if (name) names.add(name);
    }

    // Video/audio tiles on the calling stage (works without the panel)
    for (const tile of document.querySelectorAll('[data-tid="video-tile"], [data-cid="calling-participant-stream"], [data-tid^="participant-tile"], [data-stream-type]')) {
      const label = tile.getAttribute('aria-label') ||
        (tile.querySelector('[data-tid="tile-name"], [class*="displayName"], [class*="name"]') || {}).textContent;
      const name = cleanName(label);
      if (name) names.add(name);
    }

    // Caption authors are participants too (and 100% correctly named)
    for (const span of speechSpans) names.add(span.who);
    if (currentSpan) names.add(currentSpan.who);

    return [...names];
  }

  function openPeoplePanel() {
    const btn = document.querySelector(SEL.PEOPLE_BUTTON);
    if (btn) {
      btn.click();
      console.log('[meeting-cli] painel de participantes aberto para carregar roster');
    }
  }

  // ── Captions: auto-enable + speaker timeline ────────────────

  function captionsVisible() {
    return !!document.querySelector(SEL.CAPTIONS_RENDERER);
  }

  // Click chain: More → Language & speech → Turn on captions.
  // Captions in Teams are per-user (private) — enabling them doesn't notify others.
  function tryEnableCaptions() {
    if (captionsVisible() || captionsEnableAttempts >= 3) return;
    const now = Date.now();
    if (now - lastEnableAttempt < 60000) return;
    lastEnableAttempt = now;
    captionsEnableAttempts++;

    const more = document.querySelector(SEL.MORE_BUTTON);
    if (!more) return;
    more.click();
    setTimeout(() => {
      const langMenu = document.querySelector(SEL.LANGUAGE_SPEECH_MENU);
      if (!langMenu) { more.click(); return; }  // close menu, try next cycle
      langMenu.click();
      setTimeout(() => {
        const turnOn = document.querySelector(SEL.TURN_ON_CAPTIONS);
        if (turnOn) {
          turnOn.click();
          console.log('[meeting-cli] legendas ativadas automaticamente (tentativa ' + captionsEnableAttempts + ')');
        } else {
          document.body.click();  // dismiss dangling menu
        }
      }, 400);
    }, 400);
  }

  // Sample the ACTIVE (last) caption — author name is the ground truth of who
  // is speaking right now. Aggregation into spans tolerates caption text
  // mutating as the ASR refines; we only care about author + time.
  function sampleActiveSpeaker() {
    if (!inCall) return;
    const renderer = document.querySelector(SEL.CAPTIONS_RENDERER);
    if (!renderer) return;
    const messages = renderer.querySelectorAll(SEL.CAPTION_MESSAGE);
    if (messages.length === 0) return;

    const last = messages[messages.length - 1];
    const authorEl = last.querySelector(SEL.CAPTION_AUTHOR);
    const who = cleanName(authorEl ? authorEl.textContent : '');
    if (!who) return;

    const t = Math.round((Date.now() - callStartMs) / 1000);
    if (currentSpan && currentSpan.who === who) {
      currentSpan.end = t;
    } else {
      if (currentSpan) speechSpans.push(currentSpan);
      currentSpan = { who, start: t, end: t };
    }
  }

  function flushSpeech() {
    if (!inCall) return;
    const toSend = currentSpan ? [...speechSpans, currentSpan] : speechSpans;
    if (toSend.length === 0 || toSend.length === lastFlushedCount && !currentSpan) return;
    lastFlushedCount = speechSpans.length;
    send('SPEECH', { spans: toSend });
  }

  // ── Messaging ───────────────────────────────────────────────

  function send(type, payload) {
    try {
      return browser.runtime.sendMessage({ type, platform: 'teams', ...payload });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  // ── Main loops ──────────────────────────────────────────────

  setInterval(() => {
    const hangup = findHangupButton();

    if (hangup) {
      absentPolls = 0;
      presentPolls++;
      if (!inCall && presentPolls > START_CONFIRM_POLLS) {
        inCall = true;
        callStartMs = Date.now();
        sentParticipants = new Set();
        speechSpans = [];
        currentSpan = null;
        lastFlushedCount = 0;
        captionsEnableAttempts = 0;
        lastEnableAttempt = 0;
        const participants = scrapeParticipants();
        participants.forEach((p) => sentParticipants.add(p));
        send('CALL_STARTED', { title: getCallTitle(), participants });
        console.log('[meeting-cli] call started:', getCallTitle());
        setTimeout(openPeoplePanel, 1500);   // force roster to load
        setTimeout(tryEnableCaptions, 4000); // captions → speaker timeline
      } else if (inCall) {
        tryEnableCaptions();
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
          flushSpeech();  // final spans before stop
          send('CALL_ENDED', {});
          console.log('[meeting-cli] call ended,', speechSpans.length, 'spans de fala capturados');
        }
      }
    }
  }, POLL_MS);

  setInterval(sampleActiveSpeaker, SPEECH_POLL_MS);
  setInterval(flushSpeech, SPEECH_FLUSH_MS);
})();
