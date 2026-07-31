// Background script — single point of contact with the meeting-cli daemon.
// Content scripts send messages here; this forwards them to localhost.
// (Content scripts can't fetch localhost directly: the page's CSP and origin apply to them.)

const DAEMON = 'http://127.0.0.1:7899';

let state = {
  inCall: false,
  daemonReachable: false,
};

async function post(path, body) {
  try {
    const res = await fetch(`${DAEMON}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    state.daemonReachable = true;
    return await res.json();
  } catch (err) {
    state.daemonReachable = false;
    console.warn(`[meeting-cli] daemon unreachable (${path}):`, err.message);
    return null;
  }
}

function setBadge(text, color) {
  browser.browserAction.setBadgeText({ text });
  if (color) browser.browserAction.setBadgeBackgroundColor({ color });
}

browser.runtime.onMessage.addListener(async (msg, sender) => {
  switch (msg.type) {
    case 'CALL_STARTED': {
      state.inCall = true;
      setBadge('REC', '#d32f2f');
      const result = await post('/start', {
        title: msg.title,
        platform: msg.platform,
        url: sender.tab && sender.tab.url,
        participants: msg.participants || [],
      });
      return { ok: !!result };
    }

    case 'PARTICIPANTS': {
      if (!msg.participants || msg.participants.length === 0) return { ok: true };
      const result = await post('/participants', { participants: msg.participants });
      return { ok: !!result };
    }

    case 'SPEECH': {
      if (!msg.spans || msg.spans.length === 0) return { ok: true };
      const result = await post('/speech', { spans: msg.spans });
      return { ok: !!result };
    }

    case 'CALL_ENDED': {
      state.inCall = false;
      setBadge('');
      const result = await post('/stop', {});
      return { ok: !!result };
    }

    case 'GET_STATE':
      return state;
  }
});
