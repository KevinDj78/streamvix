/**
 * StreamingCommunity Provider per StreamViX
 * Flusso: IMDB ID -> TMDB (nome IT) -> SC search -> VixCloud embed -> MFP proxy
 */

import type { StreamForStremio } from '../types/animeunity';

export interface ScProviderConfig {
  enabled: boolean;
  tmdbApiKey?: string;
  mfpUrl?: string;
  mfpPassword?: string;
}

interface ScSearchResult { id: number; name: string; slug: string; type: 'movie' | 'tv'; }
interface ScEpisode { id: number; number: number; }
interface CachedTitle { scId: number; slug: string; type: string; ts: number; }

const TTL_MS = 6 * 60 * 60 * 1000;
const FT_MS = 12000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function log(...a: unknown[]) { console.log('[SC]', ...a); }
function warn(...a: unknown[]) { console.warn('[SC]', ...a); }

function getScBase(): string {
  try { return ((globalThis as any).process?.env?.SC_BASE_URL || 'https://streamingcommunityz.pet').replace(/\/+$/, ''); }
  catch { return 'https://streamingcommunityz.pet'; }
}

async function ft(url: string, opts: RequestInit = {}, ms = FT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal as any }); } finally { clearTimeout(t); }
}

function decodeHE(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function parseDP(html: string): any {
  const m = html.match(/data-page="([^"]+)"/);
  if (!m) return null;
  try { return JSON.parse(decodeHE(m[1])).props || null; } catch { return null; }
}

function parseEmbed(html: string): string | null {
  const m = html.match(/src="(https?:\/\/vixcloud\.co\/embed\/[^"]+)"/);
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

function mfpHls(m3u8: string, referer: string, mfp: string, psw: string): string {
  const origin = new URL(referer).origin;
  const hdrs = JSON.stringify({ Referer: referer, Origin: origin });
  const pp = psw ? '&api_password=' + encodeURIComponent(psw) : '';
  return mfp.replace(/\/+$/, '') + '/proxy/hls/manifest.m3u8?d=' + encodeURIComponent(m3u8) + '&headers=' + encodeURIComponent(hdrs) + pp;
}

export class ScProvider {
  private cache = new Map<string, CachedTitle>();
  constructor(private cfg: ScProviderConfig) {}

  async handleImdbRequest(imdbId: string, season: number|null, episode: number|null, isMovie: boolean): Promise<{streams: StreamForStremio[]}> {
    if (!this.cfg.enabled) return { streams: [] };
    const id = imdbId.split(':')[0];
    log('request', { id, season, episode, isMovie });
    try {
      const title = await this.resolveTitle(id, isMovie);
      if (!title) return { streams: [] };
      if (isMovie) return this.movieStreams(title.scId, title.slug);
      if (season == null || episode == null) return { streams: [] };
      return this.seriesStreams(title.scId, title.slug, season, episode);
    } catch(e) { warn('error:', (e as Error)?.message); return { streams: [] }; }
  }

  private async resolveTitle(imdbId: string, isMovie: boolean): Promise<CachedTitle|null> {
    const cached = this.cache.get(imdbId);
    if (cached && Date.now() - cached.ts < TTL_MS) return cached;
    const name = await this.tmdbName(imdbId, isMovie);
    if (!name) return null;
    log('TMDB name:', name);
    const type = isMovie ? 'movie' : 'tv';
    const results = await this.searchSc(name, type);
    if (!results.length) { log('no SC results for:', name); return null; }
    const match = this.bestMatch(results, name);
    if (!match) return null;
    log('SC match:', match.id, match.name);
    const entry: CachedTitle = { scId: match.id, slug: match.slug, type: match.type, ts: Date.now() };
    this.cache.set(imdbId, entry);
    return entry;
  }

  private async tmdbName(imdbId: string, isMovie: boolean): Promise<string|null> {
    const key = this.cfg.tmdbApiKey || (globalThis as any).process?.env?.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0';
    try {
      const r = await ft('https://api.themoviedb.org/3/find/' + imdbId + '?api_key=' + key + '&external_source=imdb_id&language=it-IT');
      if (r.ok) {
        const d: any = await r.json();
        const arr = isMovie ? (d.movie_results || []) : (d.tv_results || []);
        if (arr.length) return arr[0].title || arr[0].name || arr[0].original_title || arr[0].original_name || null;
      }
    } catch(e) { warn('TMDB:', (e as Error)?.message); }
    return null;
  }

  private async searchSc(q: string, type: 'movie'|'tv'): Promise<ScSearchResult[]> {
    const base = getScBase();
    try {
      const r = await ft(base + '/api/search?q=' + encodeURIComponent(q), {
        headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': base + '/' }
      });
      if (!r.ok) return [];
      const d: any = await r.json();
      const raw: any[] = Array.isArray(d) ? d : (d?.data || []);
      return raw.filter(t => t.type === type).map(t => ({ id: t.id, name: t.name, slug: t.slug, type: t.type }));
    } catch(e) { warn('search:', (e as Error)?.message); return []; }
  }

  private bestMatch(r: ScSearchResult[], q: string): ScSearchResult|null {
    const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    const qn = n(q);
    return r.find(x => n(x.name) === qn)
      || r.find(x => { const xn=n(x.name); return xn.includes(qn)||qn.includes(xn); })
      || r[0] || null;
  }

  private async movieStreams(scId: number, slug: string): Promise<{streams: StreamForStremio[]}> {
    try {
      const html = await this.iframeHtml(scId, null);
      if (!html) return { streams: [] };
      const s = await this.fromEmbed(html, 'Film');
      return { streams: s ? [s] : [] };
    } catch(e) { warn('movie:', (e as Error)?.message); return { streams: [] }; }
  }

  private async seriesStreams(scId: number, slug: string, season: number, episode: number): Promise<{streams: StreamForStremio[]}> {
    const base = getScBase();
    try {
      const path = season === 1 ? '/it/titles/' + scId + '-' + slug : '/it/titles/' + scId + '-' + slug + '/season-' + season;
      const r = await ft(base + path, { headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': base + '/' } });
      if (!r.ok) return { streams: [] };
      const props = parseDP(await r.text());
      if (!props) return { streams: [] };
      const eps: ScEpisode[] = (props.loadedSeason?.episodes || []).map((e: any) => ({ id: e.id, number: e.number }));
      const ep = eps.find(e => e.number === episode);
      if (!ep) { warn('S' + season + 'E' + episode + ' not found'); return { streams: [] }; }
      const html = await this.iframeHtml(scId, ep.id);
      if (!html) return { streams: [] };
      const s = await this.fromEmbed(html, 'S' + season + 'E' + episode);
      return { streams: s ? [s] : [] };
    } catch(e) { warn('series:', (e as Error)?.message); return { streams: [] }; }
  }

  private async iframeHtml(scId: number, epId: number|null): Promise<string|null> {
    const base = getScBase();
    const qs = epId ? '?episode_id=' + epId + '&next_episode=1' : '';
    try {
      const r = await ft(base + '/it/iframe/' + scId + qs, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': base + '/it/watch/' + scId }
      });
      return r.ok ? r.text() : null;
    } catch(e) { warn('iframe:', (e as Error)?.message); return null; }
  }

  private async fromEmbed(iframeHtml: string, label: string): Promise<StreamForStremio|null> {
    const base = getScBase();
    const embedUrl = parseEmbed(iframeHtml);
    if (!embedUrl) { warn('embed URL not found'); return null; }
    log('embed:', embedUrl);
    let html: string;
    try {
      const r = await ft(embedUrl, { headers: { 'User-Agent': UA, 'Referer': base + '/', 'Origin': base } });
      if (!r.ok) { warn('vixcloud HTTP', r.status); return null; }
      html = await r.text();
    } catch(e) { warn('vixcloud:', (e as Error)?.message); return null; }

    // Parse window.masterPlaylist
    const mm = html.match(/window\.masterPlaylist\s*=\s*\{([\s\S]*?)\}\s*[\n;]/);
    if (!mm) { warn('masterPlaylist not found'); return null; }
    const blk = mm[1];
    const tok = blk.match(/'token'\s*:\s*'([^']+)'/)?.[1];
    const exp = blk.match(/'expires'\s*:\s*'([^']*)'/)?.[1] || '';
    const bu  = blk.match(/url\s*:\s*'([^']+)'/)?.[1];
    if (!tok || !bu) { warn('token/url not found'); return null; }

    // Parse window.streams
    let baseUrl = bu;
    const sm = html.match(/window\.streams\s*=\s*(\[[\s\S]*?\]);/);
    if (sm) {
      try {
        const arr: any[] = JSON.parse(sm[1]);
        const active = arr.find(s => s.active === 1 || s.active === true);
        baseUrl = (active || arr[0])?.url || bu;
      } catch {}
    }

    // Costruisci m3u8 con token + h=1 (sempre, per FHD 1080p)
    let m3u8: string;
    try {
      const u = new URL(baseUrl);
      u.searchParams.append('token', tok);
      if (exp) u.searchParams.append('expires', exp);
      u.searchParams.append('h', '1');
      m3u8 = u.toString();
    } catch {
      const sep = baseUrl.includes('?') ? '&' : '?';
      m3u8 = baseUrl + sep + 'token=' + encodeURIComponent(tok) + '&expires=' + encodeURIComponent(exp) + '&h=1';
    }
    log('m3u8:', m3u8);

    const mfp = (this.cfg.mfpUrl || '').replace(/\/+$/, '');
    const psw = this.cfg.mfpPassword || '';

    if (mfp) {
      return {
        title: '🎬 ' + label + '\n🗣 🇮🇹 [ITA]\n🌐 Proxy (ON)\n🤌 StreamingCommunity 🍿',
        url: mfpHls(m3u8, base + '/', mfp, psw),
        behaviorHints: { notWebReady: false },
      } as StreamForStremio;
    }
    return {
      title: '🎬 ' + label + '\n🗣 🇮🇹 [ITA]\n🌐 Proxy (OFF)\n🤌 StreamingCommunity 🍿',
      url: m3u8,
      behaviorHints: { notWebReady: false, proxyHeaders: { request: { Referer: base + '/', Origin: base } } } as any,
    } as StreamForStremio;
  }
}
