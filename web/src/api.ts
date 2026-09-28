import type {
  AttributeItem,
  CollectionItem,
  Deal,
  GiftLookup,
  ScannerStatus,
  RatesInfo,
  Snapshot,
  SourceInfo,
  Trade,
} from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status}: ${text.slice(0, 200)}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  sources: () => request<SourceInfo[]>('/api/sources'),
  rates: () => request<RatesInfo>('/api/rates'),

  authStatus: () => request<{ authorized: boolean; user: string | null }>('/api/auth/telegram/status'),
  authStart: (phone: string) =>
    request<{ sent: boolean }>('/api/auth/telegram/start', {
      method: 'POST',
      body: JSON.stringify({ phone }),
    }),
  authConfirm: (code: string, password?: string) =>
    request<{ user: string | null }>('/api/auth/telegram/confirm', {
      method: 'POST',
      body: JSON.stringify({ code, password }),
    }),

  collections: (query: string) =>
    request<CollectionItem[]>(`/api/catalog/collections?q=${encodeURIComponent(query)}`),
  attributes: (collection: string, kind: string, query: string) =>
    request<AttributeItem[]>(
      `/api/catalog/attributes?collection=${encodeURIComponent(collection)}&kind=${kind}&q=${encodeURIComponent(query)}`,
    ),

  gift: (url: string) => request<GiftLookup>(`/api/gift?url=${encodeURIComponent(url)}`),

  search: (body: Record<string, unknown>) =>
    request<Snapshot>('/api/search', { method: 'POST', body: JSON.stringify(body) }),
  closeSearch: (sessionId: string) =>
    request<{ ok: boolean }>(`/api/search/${sessionId}`, { method: 'DELETE' }).catch(() => undefined),
  loadMore: (sessionId: string) =>
    request<{ trades: Trade[]; snapshot: Snapshot }>(`/api/search/${sessionId}/more`, { method: 'POST' }),
  snapshot: (sessionId: string) => request<Snapshot>(`/api/search/${sessionId}`),

  deals: (options: {
    minDiscount: number;
    hours?: number;
    markets?: string[];
    sort?: string;
    minPrice?: number | null;
    maxPrice?: number | null;
  }) => {
    const params = new URLSearchParams({
      minDiscount: String(options.minDiscount),
      hours: String(options.hours ?? 24),
      limit: '80',
      sort: options.sort ?? 'time',
    });
    if (options.markets?.length) params.set('markets', options.markets.join(','));
    if (options.minPrice) params.set('minPrice', String(options.minPrice));
    if (options.maxPrice) params.set('maxPrice', String(options.maxPrice));
    return request<Deal[]>(`/api/deals?${params.toString()}`);
  },
  scanner: () => request<ScannerStatus>('/api/scanner'),
  scannerUpdate: (patch: Partial<ScannerStatus>) =>
    request<ScannerStatus>('/api/scanner', { method: 'POST', body: JSON.stringify(patch) }),
};
