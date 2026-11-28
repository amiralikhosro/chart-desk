/**
 * News + economic calendar feed proxy, shared by `server.mjs` (production) and the
 * Vite dev server. None of these publishers send CORS headers, and ForexFactory
 * rate-limits hard, so every feed is fetched server-side, cached in memory and on
 * disk, and served stale when the upstream fails.
 *
 *   GET /feeds/news/<id>   raw RSS/Atom XML of one feed
 *   GET /feeds/calendar    ForexFactory this-week calendar JSON
 *   GET /feeds/index       the feed list (id, label, group)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const NEWS_FEEDS = {
  cointelegraph: { label: 'Cointelegraph', group: 'crypto', url: 'https://cointelegraph.com/rss' },
  coindesk: { label: 'CoinDesk', group: 'crypto', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml' },
  decrypt: { label: 'Decrypt', group: 'crypto', url: 'https://decrypt.co/feed' },
  theblock: { label: 'The Block', group: 'crypto', url: 'https://www.theblock.co/rss.xml' },
  cryptoslate: { label: 'CryptoSlate', group: 'crypto', url: 'https://cryptoslate.com/feed/' },
  commodities: { label: 'Investing.com', group: 'macro', url: 'https://www.investing.com/rss/news_11.rss' },
  fxempire: { label: 'FX Empire', group: 'macro', url: 'https://www.fxempire.com/api/v1/en/articles/rss/news' },
  marketwatch: { label: 'MarketWatch', group: 'macro', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  fed: { label: 'Federal Reserve', group: 'macro', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
};

const CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
/** Same calendar as XML (times in UTC). Rate-limited separately, so it is the fallback. */
const CALENDAR_XML_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml';
/** A cached calendar older than this is last week's: never serve it. */
const CALENDAR_MAX_AGE = 3 * 24 * 3600_000;
const NEWS_TTL = 3 * 60_000;
const CALENDAR_TTL = 60 * 60_000;
/** After a failed calendar fetch (rate limit), wait this long before trying again. */
const FAIL_BACKOFF = 10 * 60_000;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) ChartDesk/1.0';

const cdata = (block, tag) => {
  const m = block.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
  return m ? m[1].trim() : '';
};

/** ForexFactory weekly XML → the JSON feed's shape (`date` as ISO, plus `allDay`). */
export function calendarXmlToJson(xml) {
  const out = [];
  for (const block of xml.split('<event>').slice(1)) {
    const [mm, dd, yyyy] = cdata(block, 'date').split('-').map(Number);
    if (!yyyy) continue;
    const time = cdata(block, 'time');
    const t = time.match(/^(\d{1,2}):(\d{2})(am|pm)$/i);
    let h = 0;
    let min = 0;
    if (t) {
      h = (Number(t[1]) % 12) + (t[3].toLowerCase() === 'pm' ? 12 : 0);
      min = Number(t[2]);
    }
    out.push({
      title: cdata(block, 'title'),
      country: cdata(block, 'country'),
      date: new Date(Date.UTC(yyyy, mm - 1, dd, h, min)).toISOString(),
      allDay: !t,
      impact: cdata(block, 'impact'),
      forecast: cdata(block, 'forecast'),
      previous: cdata(block, 'previous'),
      url: cdata(block, 'url'),
    });
  }
  return out;
}

export function createFeedHandler({ dataDir } = {}) {
  const cacheFile = dataDir ? join(dataDir, 'feeds-cache.json') : null;
  /** key → { at, body, type, failAt? } */
  let cache = {};
  try {
    if (cacheFile) cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
  } catch {
    cache = {};
  }
  const inflight = new Map();
  let saveTimer = null;

  const persist = () => {
    if (!cacheFile || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(cacheFile, JSON.stringify(cache));
      } catch {
        /* read-only data dir: memory cache still works */
      }
    }, 2_000);
  };

  async function load(key, url, ttl, type, validate) {
    const hit = cache[key];
    const now = Date.now();
    if (hit && now - hit.at < ttl) return hit;
    if (hit?.failAt && now - hit.failAt < FAIL_BACKOFF) return hit;
    if (inflight.has(key)) return inflight.get(key);
    const job = (async () => {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': UA, Accept: type === 'json' ? 'application/json' : 'application/rss+xml, application/xml, text/xml, */*' },
          redirect: 'follow',
          signal: AbortSignal.timeout(12_000),
        });
        const body = await res.text();
        if (!res.ok || !validate(body)) throw new Error(`HTTP ${res.status}`);
        cache[key] = { at: Date.now(), body, type };
        persist();
        return cache[key];
      } catch (err) {
        console.warn(`[feeds] ${key}: ${err instanceof Error ? err.message : err}`);
        if (hit) {
          hit.failAt = Date.now();
          return hit;
        }
        cache[key] = { at: 0, body: '', type, failAt: Date.now() };
        return null;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, job);
    return job;
  }

  const reply = (res, code, body, type, extra = {}) => {
    res.writeHead(code, {
      'Content-Type': type === 'json' ? 'application/json; charset=utf-8' : 'application/xml; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    });
    res.end(body);
  };

  /** Returns true when it handled the request. */
  return function handle(req, res) {
    const url = (req.url || '').split('?')[0];
    if (!url.startsWith('/feeds/')) return false;

    if (url === '/feeds/index') {
      const list = Object.entries(NEWS_FEEDS).map(([id, f]) => ({ id, label: f.label, group: f.group }));
      reply(res, 200, JSON.stringify(list), 'json');
      return true;
    }

    if (url === '/feeds/calendar') {
      const ok = (h) => h?.body && Date.now() - h.at < CALENDAR_MAX_AGE;
      // One upstream request per refresh: ForexFactory blocks IPs that poll both copies.
      // The XML copy is only fetched while the JSON one is failing.
      void (async () => {
        const j = await load('calendar', CALENDAR_URL, CALENDAR_TTL, 'json', (b) => b.trimStart().startsWith('['));
        const fresh = j?.body && Date.now() - j.at < CALENDAR_TTL;
        const x = fresh
          ? cache['calendar-xml']
          : await load('calendar-xml', CALENDAR_XML_URL, CALENDAR_TTL, 'xml', (b) => b.includes('<weeklyevents'));
        return [j, x];
      })().then(([j, x]) => {
        // The fresher of the two copies wins.
        const pick = ok(j) && (!ok(x) || j.at >= x.at) ? j : ok(x) ? x : null;
        if (!pick) {
          reply(res, 502, JSON.stringify({ error: 'calendar unavailable' }), 'json');
          return;
        }
        const body = pick === j ? j.body : JSON.stringify(calendarXmlToJson(x.body));
        reply(res, 200, body, 'json', { 'X-Fetched-At': String(pick.at), 'X-Source': pick === j ? 'ff-json' : 'ff-xml' });
      });
      return true;
    }

    const m = url.match(/^\/feeds\/news\/([a-z0-9-]+)$/);
    const feed = m && NEWS_FEEDS[m[1]];
    if (!feed) {
      reply(res, 404, JSON.stringify({ error: 'unknown feed' }), 'json');
      return true;
    }
    void load(`news:${m[1]}`, feed.url, NEWS_TTL, 'xml', (b) => /<(rss|feed|rdf)/i.test(b.slice(0, 2000))).then((hit) => {
      if (!hit?.body) reply(res, 502, '<error>feed unavailable</error>', 'xml');
      else reply(res, 200, hit.body, 'xml', { 'X-Fetched-At': String(hit.at) });
    });
    return true;
  };
}
