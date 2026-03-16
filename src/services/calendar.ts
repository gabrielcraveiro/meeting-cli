import * as https from 'https';
import * as http from 'http';

export interface CalendarEvent {
  title: string;
  start: Date;
  end: Date;
  attendees: string[];
  organizer?: string;
}

// Unfold iCal line-folding: CRLF/LF + space/tab = continuation
function unfold(raw: string): string {
  return raw.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}

// Parse DTSTART or DTEND line value (handles UTC Z suffix and local time)
function parseDtLine(dtLine: string): Date {
  const colonIdx = dtLine.indexOf(':');
  if (colonIdx < 0) return new Date(NaN);
  const value = dtLine.slice(colonIdx + 1).trim();
  const isUtc = value.endsWith('Z');
  const v = value.replace('Z', '');
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?$/);
  if (!m) return new Date(NaN);
  const [, yr, mo, dy, hr = '0', mn = '0', sc = '0'] = m;
  if (isUtc) {
    return new Date(Date.UTC(+yr, +mo - 1, +dy, +hr, +mn, +sc));
  }
  // Local (TZID) — Node.js will interpret as system local time
  return new Date(+yr, +mo - 1, +dy, +hr, +mn, +sc);
}

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, (res) => {
      // Follow redirects up to 3 hops
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchText(res.headers.location).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// Extract CN display name from a property line (ATTENDEE or ORGANIZER)
function extractCN(line: string): string | null {
  const m = line.match(/CN=["']?([^"';:,\n]+)/i);
  return m ? m[1].trim() : null;
}

export async function getUpcomingMeetings(icsUrl: string, windowHours = 2): Promise<CalendarEvent[]> {
  const raw = await fetchText(icsUrl);
  const unfolded = unfold(raw);
  const events: CalendarEvent[] = [];
  const now = new Date();
  const windowEnd = new Date(now.getTime() + windowHours * 60 * 60 * 1000);

  // Split on VEVENT blocks
  const blocks = unfolded.split('BEGIN:VEVENT').slice(1);

  for (const block of blocks) {
    const endIdx = block.indexOf('END:VEVENT');
    const content = endIdx >= 0 ? block.slice(0, endIdx) : block;
    const lines = content.split(/\r?\n/).filter(Boolean);

    const props: Record<string, string> = {};
    const attendees: string[] = [];
    let dtStartLine = '';
    let dtEndLine = '';

    for (const line of lines) {
      const propName = line.split(/[;:]/)[0].toUpperCase();

      if (propName === 'DTSTART') {
        dtStartLine = line;
      } else if (propName === 'DTEND') {
        dtEndLine = line;
      } else if (propName === 'ATTENDEE') {
        const cn = extractCN(line);
        if (cn) attendees.push(cn);
      } else {
        const colonIdx = line.indexOf(':');
        if (colonIdx >= 0) {
          props[propName] = line.slice(colonIdx + 1).trim();
        }
      }
    }

    if (!dtStartLine || !props['SUMMARY']) continue;

    const start = parseDtLine(dtStartLine);
    const end = dtEndLine
      ? parseDtLine(dtEndLine)
      : new Date(start.getTime() + 60 * 60 * 1000);

    if (isNaN(start.getTime())) continue;

    // Include events happening now OR starting within the window
    if (start <= windowEnd && end >= now) {
      const organizer = props['ORGANIZER'] ? extractCN('X:' + props['ORGANIZER']) ?? undefined : undefined;
      events.push({ title: props['SUMMARY'], start, end, attendees, organizer });
    }
  }

  return events.sort((a, b) => a.start.getTime() - b.start.getTime());
}

export function formatEventTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
