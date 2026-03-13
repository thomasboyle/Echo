const GIPHY_API_KEY = "zj74abuyVxBzfZ0knJ4NuihTb81AlOvI";
const GIPHY_SEARCH_URL = "https://api.giphy.com/v1/gifs/search";
const DEBOUNCE_MS = 400;
const PAGE_SIZE = 15;
const CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 20;

const cache = new Map();
let debounceTimer = null;
let abortController = null;

function cacheKey(q, offset) {
  return `${q.toLowerCase().trim()}|${offset}`;
}

function pruneCache() {
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  const entries = Array.from(cache.entries());
  entries.sort((a, b) => a[1].ts - b[1].ts);
  for (let i = 0; i < entries.length - CACHE_MAX_ENTRIES; i++) {
    cache.delete(entries[i][0]);
  }
}

export async function searchGifs(query, offset = 0) {
  const q = (query || "").trim();
  if (!q) return { data: [], pagination: { total_count: 0 } };
  const key = cacheKey(q, offset);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_MAX_AGE_MS) return cached.data;
  if (abortController) abortController.abort();
  abortController = new AbortController();
  const url = new URL(GIPHY_SEARCH_URL);
  url.searchParams.set("api_key", GIPHY_API_KEY);
  url.searchParams.set("q", q);
  url.searchParams.set("limit", String(PAGE_SIZE));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("rating", "g");
  const res = await fetch(url.toString(), { signal: abortController.signal });
  if (!res.ok) throw new Error("Giphy search failed");
  const data = await res.json();
  cache.set(key, { data, ts: Date.now() });
  pruneCache();
  return data;
}

export function debouncedSearchGifs(query, offset, onResult) {
  if (debounceTimer) clearTimeout(debounceTimer);
  const q = (query || "").trim();
  if (!q) {
    onResult({ data: [], pagination: { total_count: 0 } });
    return;
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    searchGifs(q, offset).then(onResult).catch(() => onResult({ data: [], pagination: { total_count: 0 } }));
  }, DEBOUNCE_MS);
}

export function gifToAttachment(gif) {
  const img = gif.images?.fixed_height?.webp || gif.images?.fixed_height?.url || gif.images?.original?.url;
  const url = img || gif.embed_url;
  if (!url) return null;
  return { url, filename: "gif.gif", content_type: "image/gif" };
}
