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
  const CAPTION_ALIVE_MS = 30000; // legenda recente = call viva, mesmo sem botão de desligar

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
    // Screen sharing (self) — "stop sharing" only exists while YOU present
    STOP_SHARING: "[data-tid='stop-sharing-button'], button[data-tid='call-control-stop-sharing'], [data-tid='screen-share-stop-button']",
    // Sinais de call viva FORA da tela de call: navegar pro chat do Teams com a
    // call rolando esconde o botão de desligar, mas a mini-janela/monitor fica.
    // ATENÇÃO: o painel de LEGENDAS fica de fora — o Teams mantém o nó montado
    // depois da call, e tê-lo aqui criava sessão eterna (3 calls + silêncio
    // numa nota de 88min). Legendas ativas já seguram via lastCaptionAt (30s).
    CALL_ALIVE: [
      "[data-tid='call-monitor']",
      "[data-tid='call-monitor-v2']",
      "[data-tid='call-duration']",
    ].join(','),
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
  let lastCaptionAt = 0;       // última vez que o painel de legendas tinha conteúdo
  let lastCaptionsRecovery = 0; // última rodada do watchdog de legendas mortas

  let lastFlushedCount = 0;
  let captionsEnableAttempts = 0;
  let lastEnableAttempt = 0;
  let sharingActive = false;
  let callTitle = '';        // título da call atual — muda = trocou de reunião
  let titleChangePolls = 0;  // confirmação (2 polls) pra ignorar flicker de título

  const SHARING_LABELS = /(stop (sharing|presenting)|parar de (compartilhar|apresentar))/i;

  // True while the LOCAL user is presenting — daemon suppresses notifications
  // so nothing pops over a shared screen.
  function isSharing() {
    if (document.querySelector(SEL.STOP_SHARING)) return true;
    for (const btn of document.querySelectorAll('button[aria-label]')) {
      if (SHARING_LABELS.test(btn.getAttribute('aria-label'))) return true;
    }
    return false;
  }

  const HANGUP_LABELS = /^(leave|sair|desligar|hang up|raccrocher|auflegen)/i;

  function findHangupButton() {
    const el = document.querySelector(SEL.HANGUP);
    if (el) return el;
    // Fallback por aria-label é ambíguo: o Calendário tem "Sair" (da reunião/
    // série do convite) sem call nenhuma. Só vale acompanhado de outro sinal
    // de call ativa (duração/monitor/legendas/toolbar de chamada).
    const inCallContext =
      document.querySelector(SEL.CALL_ALIVE) || document.querySelector(SEL.PEOPLE_BUTTON);
    if (!inCallContext) return null;
    for (const btn of document.querySelectorAll('button[aria-label]')) {
      if (HANGUP_LABELS.test(btn.getAttribute('aria-label').trim())) return btn;
    }
    return null;
  }

  // ── Title ───────────────────────────────────────────────────

  /** Título vindo SÓ de elementos da call — confiável para detectar troca de
   * reunião. Inclui o mini-monitor (call-monitor-title), que segue mostrando o
   * título real quando o usuário navega pro chat com a call rolando. */
  function getCallTitleFromDom() {
    const el =
      document.querySelector('[data-tid="call-title"]') ||
      document.querySelector('[data-tid="calling-header-title"]') ||
      document.querySelector('[data-tid="call-monitor-title"]') ||
      document.querySelector('h1[id*="meeting"], h2[id*="meeting"]');
    return el && el.textContent.trim() ? el.textContent.trim() : '';
  }

  function getCallTitle() {
    const dom = getCallTitleFromDom();
    if (dom) return dom;

    // document.title looks like "(3) Calendar | Nome da Reunião | Microsoft Teams".
    // ATENÇÃO: reuniões podem ter "|" no PRÓPRIO nome ("Arquitetura | Bots | Data")
    // — pegar o último segmento truncava o título. Remove só o prefixo de view
    // conhecido e preserva o resto inteiro.
    let t = document.title
      .replace(/^\(\d+\)\s*/, '')
      .replace(/\s*[|,–-]\s*Microsoft Teams.*$/i, '')
      .trim();
    const segments = t.split('|').map((s) => s.trim()).filter(Boolean);
    const VIEW_NAMES = /^(chat|calendar|calend[aá]rio|activity|atividade|teams|equipes|calls?|chamadas?|files|arquivos|community|comunidade)$/i;
    while (segments.length > 1 && VIEW_NAMES.test(segments[0])) segments.shift();
    t = segments.join(' | ');
    return t && !/^microsoft teams$/i.test(t) ? t : '';
  }

  // O Teams usa o nome de quem fala/está fixado como título da aba em vários
  // estados da call — um "título" que bate com participante conhecido é pessoa,
  // não reunião. Comparação frouxa: um contém o outro (título pode vir truncado).
  function isParticipantName(title) {
    const t = title.toLowerCase();
    const all = [...sentParticipants, ...speechSpans.map((s) => s.who)];
    return all.some((p) => {
      const n = p.toLowerCase();
      return n === t || n.includes(t) || t.includes(n);
    });
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

  // Esconde o painel de legendas VISUALMENTE, mantendo-o vivo no DOM (a
  // raspagem continua). opacity+pointer-events em vez de display:none para a
  // virtualização do Teams seguir renderizando/atualizando as mensagens.
  const HIDE_STYLE_ID = 'meeting-cli-hide-captions';
  function hideCaptionsPanel() {
    if (!document.getElementById(HIDE_STYLE_ID)) {
      const style = document.createElement('style');
      style.id = HIDE_STYLE_ID;
      // height/max-height 0 (não display:none): o elemento continua NO layout
      // engine e o React do Teams segue atualizando as legendas — nós só
      // tiramos o espaço que ele ocupava na tela da call.
      style.textContent =
        "[data-tid='closed-caption-v2-window-wrapper'], [data-tid='closed-captions-renderer']," +
        ' [data-meeting-cli-hide] {' +
        ' opacity: 0 !important; pointer-events: none !important; user-select: none !important;' +
        ' height: 0 !important; max-height: 0 !important; min-height: 0 !important;' +
        ' padding: 0 !important; margin: 0 !important; overflow: hidden !important; }';
      document.head.appendChild(style);
    }
    // O Teams recria E às vezes renomeia o container das legendas entre
    // re-renders — regra estática só nos data-tids conhecidos deixa variantes
    // novas visíveis. Marcamos o container VIVO a cada ciclo: recriações
    // reaparecem por no máximo um tick do sampler (2s) e somem de novo.
    const el = document.querySelector(SEL.CAPTIONS_RENDERER);
    if (el && !el.hasAttribute('data-meeting-cli-hide')) {
      const win = el.closest("[data-tid*='closed-caption'][data-tid*='window']") || el;
      win.setAttribute('data-meeting-cli-hide', '1');
      console.log('[meeting-cli] painel de legendas ocultado (captura segue ativa)');
    }
  }

  function unhideCaptionsPanel() {
    document.getElementById(HIDE_STYLE_ID)?.remove();
    document
      .querySelectorAll('[data-meeting-cli-hide]')
      .forEach((el) => el.removeAttribute('data-meeting-cli-hide'));
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

  // Scrape caption utterances: author (real name — ground truth) + text.
  // Caption text mutates while the ASR refines and the list is virtualized
  // (old messages leave the DOM), so we merge each poll's snapshot into an
  // accumulated utterance list anchored on the last known utterance.
  function getCaptionSnapshot() {
    const renderer = document.querySelector(SEL.CAPTIONS_RENDERER);
    if (!renderer) return [];
    const out = [];
    for (const msg of renderer.querySelectorAll(SEL.CAPTION_MESSAGE)) {
      const authorEl = msg.querySelector(SEL.CAPTION_AUTHOR);
      const textEl = msg.querySelector('[data-tid="closed-caption-text"]');
      const who = cleanName(authorEl ? authorEl.textContent : '');
      const text = (textEl ? textEl.textContent : '').trim().slice(0, 500);
      if (who && text) out.push({ who, text });
    }
    return out;
  }

  function sameUtterance(a, b) {
    if (a.who !== b.who) return false;
    const shorter = a.text.length <= b.text.length ? a.text : b.text;
    const longer = a.text.length <= b.text.length ? b.text : a.text;
    return longer.startsWith(shorter.slice(0, 40));
  }

  function sampleCaptions() {
    if (!inCall) return;
    hideCaptionsPanel();  // ciclo de 2s: re-oculta o painel se o Teams o recriou
    const snapshot = getCaptionSnapshot();
    if (snapshot.length === 0) return;
    lastCaptionAt = Date.now();
    const t = Math.round((Date.now() - callStartMs) / 1000);

    if (speechSpans.length === 0) {
      for (const m of snapshot) speechSpans.push({ who: m.who, text: m.text, start: t, end: t });
      return;
    }

    // Anchor: find our last utterance inside the snapshot (search from the end)
    const lastU = speechSpans[speechSpans.length - 1];
    let anchor = -1;
    for (let i = snapshot.length - 1; i >= 0; i--) {
      if (sameUtterance(snapshot[i], lastU)) { anchor = i; break; }
    }

    if (anchor >= 0) {
      // Refresh the anchored utterance (ASR may have refined/extended it)
      if (snapshot[anchor].text.length > lastU.text.length) lastU.text = snapshot[anchor].text;
      lastU.end = Math.max(lastU.end, t);
      // Everything after the anchor is new
      for (let i = anchor + 1; i < snapshot.length; i++) {
        speechSpans.push({ who: snapshot[i].who, text: snapshot[i].text, start: t, end: t });
      }
    } else {
      // No overlap found (burst of new captions between polls) — take the last
      // message only, to avoid re-appending history we already captured.
      const m = snapshot[snapshot.length - 1];
      speechSpans.push({ who: m.who, text: m.text, start: t, end: t });
    }
  }

  function flushSpeech() {
    if (!inCall || speechSpans.length === 0) return;
    lastFlushedCount = speechSpans.length;
    send('SPEECH', { spans: speechSpans });
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
        lastCaptionAt = 0;
        lastCaptionsRecovery = 0;

        lastFlushedCount = 0;
        captionsEnableAttempts = 0;
        lastEnableAttempt = 0;
        const participants = scrapeParticipants();
        participants.forEach((p) => sentParticipants.add(p));
        callTitle = getCallTitle();
        titleChangePolls = 0;
        send('CALL_STARTED', { title: callTitle, participants });
        console.log('[meeting-cli] call started:', callTitle);
        setTimeout(openPeoplePanel, 1500);   // force roster to load
        setTimeout(tryEnableCaptions, 4000); // captions → speaker timeline
      } else if (inCall) {
        // Troca de reunião SEM sair da tela de call: o botão de desligar nunca
        // some, mas o título muda. Confirmado por 3 polls (~15s) contra flicker,
        // encerramos a call antiga — o próximo ciclo re-entra como call nova.
        // SÓ o elemento da tela de call conta aqui: o document.title muda quando
        // o usuário navega pra outro chat com a call rolando (nome do chat) e
        // pelo nome de quem fala — nenhum dos dois é troca de reunião.
        // Sufixo entre parênteses NÃO diferencia reunião: o Teams alterna
        // "Reunião (Externo)" ↔ "Reunião" no mesmo call — comparar cru fatiava.
        const baseTitle = (t) => t.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
        const nowTitle = getCallTitleFromDom();
        if (nowTitle && callTitle && baseTitle(nowTitle) === baseTitle(callTitle) && nowTitle !== callTitle) {
          callTitle = nowTitle;  // variante do mesmo título — só adota a mais recente
          titleChangePolls = 0;
        } else if (nowTitle && callTitle && baseTitle(nowTitle) !== baseTitle(callTitle)) {
          if (isParticipantName(nowTitle)) {
            // Falso título (nome de pessoa). Se o atual também era nome de
            // pessoa e nada melhor apareceu, mantém; nunca conta como troca.
            titleChangePolls = 0;
          } else if (isParticipantName(callTitle)) {
            // Estávamos com nome de pessoa como título e o título real da
            // reunião apareceu — adota sem encerrar a sessão.
            console.log('[meeting-cli] título corrigido:', callTitle, '→', nowTitle);
            callTitle = nowTitle;
            titleChangePolls = 0;
            send('TITLE_CHANGED', { title: callTitle });
          } else {
            titleChangePolls++;
            if (titleChangePolls >= 3) {
              console.log('[meeting-cli] troca de reunião:', callTitle, '→', nowTitle);
              flushSpeech();
              unhideCaptionsPanel();
              send('CALL_ENDED', {});
              inCall = false;
              presentPolls = 0;
              titleChangePolls = 0;
              return;
            }
          }
        } else {
          titleChangePolls = 0;
        }
        tryEnableCaptions();
        hideCaptionsPanel();  // assim que o painel existir, some da tela

        // Watchdog de legendas: estamos NA TELA da call (hangup presente) mas
        // sem fala nova há 60s+. captionsVisible() não detecta legendas
        // DESLIGADAS (o Teams mantém o painel montado) — só a ausência de
        // conteúdo novo detecta. A cada 5min: reabre o ciclo de auto-enable
        // (as 3 tentativas zeram) e avisa o daemon pra alertar o usuário.
        {
          const nowMs = Date.now();
          const captionAge = lastCaptionAt ? nowMs - lastCaptionAt : nowMs - callStartMs;
          if (captionAge > 60000 && nowMs - lastCaptionsRecovery > 5 * 60000) {
            lastCaptionsRecovery = nowMs;
            captionsEnableAttempts = 0;
            lastEnableAttempt = 0;
            send('CAPTIONS_STALE', { sinceSec: Math.round(captionAge / 1000) });
            console.log('[meeting-cli] legendas sem atividade há', Math.round(captionAge / 1000), 's — reabrindo auto-enable');
          }
        }
        const sharing = isSharing();
        if (sharing !== sharingActive) {
          sharingActive = sharing;
          send('SHARING', { active: sharing });
          console.log('[meeting-cli] compartilhamento de tela:', sharing ? 'INICIADO' : 'encerrado');
        }
        const current = scrapeParticipants();
        const fresh = current.filter((p) => !sentParticipants.has(p));
        if (fresh.length > 0) {
          fresh.forEach((p) => sentParticipants.add(p));
          send('PARTICIPANTS', { participants: [...sentParticipants] });
          console.log('[meeting-cli] roster +', fresh.join(', '));
        }
      }
    } else if (
      inCall &&
      (document.querySelector(SEL.CALL_ALIVE) ||
        (lastCaptionAt && Date.now() - lastCaptionAt < CAPTION_ALIVE_MS))
    ) {
      // Sem botão de desligar, mas a call segue viva em segundo plano — o
      // usuário navegou pro chat do Teams (mini-janela/monitor presente, ou
      // legendas chegando há <30s). Não é fim de call; segura o contador.
      presentPolls = 0;
      absentPolls = 0;
    } else {
      presentPolls = 0;
      if (inCall) {
        absentPolls++;
        if (absentPolls > END_CONFIRM_POLLS) {
          inCall = false;
          absentPolls = 0;
          flushSpeech();  // final spans before stop
          unhideCaptionsPanel();
          send('CALL_ENDED', {});
          console.log('[meeting-cli] call ended,', speechSpans.length, 'spans de fala capturados');
        }
      }
    }
  }, POLL_MS);

  setInterval(sampleCaptions, SPEECH_POLL_MS);
  setInterval(flushSpeech, SPEECH_FLUSH_MS);
})();
