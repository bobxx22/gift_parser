/** Мелкие помощники: разбор дат и чисел, слаги, ранжирование поиска. */

/** Разбирает ISO-время из API. У .NET-бэкенда MRKT бывает 7 знаков в долях секунды. */
export function parseTs(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value < 1e12 ? value * 1000 : value);
  if (typeof value !== 'string' || !value.trim()) return new Date();
  let text = value.trim().replace(' ', 'T');
  const dot = text.indexOf('.');
  if (dot >= 0) {
    let index = dot + 1;
    let digits = '';
    while (index < text.length && text[index] >= '0' && text[index] <= '9') {
      digits += text[index];
      index += 1;
    }
    text = text.slice(0, dot + 1) + digits.slice(0, 3) + text.slice(index);
  }
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) text += 'Z';
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export function toNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** «Bounty Hunter» -> bountyhunter (правило имён файлов и слагов площадок). */
export function slugify(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Имя файла картинки в том же виде, в каком их складывает main.py. */
export function safeFileName(value: string): string {
  return String(value ?? '').replace(/[^\p{L}\p{N} _\-()]/gu, '_');
}

/** «HeroicHelmet» из «Heroic Helmet» — для ссылок t.me/nft/... */
export function pascalName(value: string): string {
  return String(value ?? '')
    .split(/[\s\-']+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

export function normalizeAttr(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]/gi, '');
}

/** Совпадают ли значения атрибутов (площадки пишут их чуть по-разному). */
export function sameAttr(left?: string | null, right?: string | null): boolean {
  if (!left) return true;
  if (!right) return false;
  return normalizeAttr(left) === normalizeAttr(right);
}

/**
 * Оценка совпадения для поиска: ищем по любым словам, не обязательно с начала.
 * Возвращает -1, если хотя бы одно слово запроса не найдено.
 */
export function rank(name: string, query: string): number {
  const text = String(name ?? '').toLowerCase();
  const needle = query.trim().toLowerCase();
  if (!needle) return 1;
  const words = text.split(/[\s\-/]+/);
  let score = 0;
  for (const token of needle.split(/\s+/)) {
    if (text.startsWith(token)) score += 100;
    else if (words.some((word) => word.startsWith(token))) score += 70;
    else if (text.includes(token)) score += 40;
    else {
      const ratio = Math.max(0, ...words.map((word) => similarity(token, word)));
      if (ratio >= 0.72) score += 25 * ratio;
      else return -1;
    }
  }
  return score - text.length * 0.01;
}

/** Похожесть строк 0..1 (расстояние Левенштейна, нормированное). */
export function similarity(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  if (a === b) return 1;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = new Array<number>(cols);
  let current = new Array<number>(cols);
  for (let j = 0; j < cols; j += 1) previous[j] = j;
  for (let i = 1; i < rows; i += 1) {
    current[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    [previous, current] = [current, previous];
  }
  return 1 - previous[cols - 1] / Math.max(a.length, b.length);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ссылка на подарок в Telegram: t.me/nft/HeroicHelmet-1349 */
export function giftLink(giftName?: string | null, collection?: string, num?: number | null): string | null {
  if (giftName && giftName.includes('-')) return `https://t.me/nft/${giftName}`;
  if (collection && num) return `https://t.me/nft/${pascalName(collection)}-${num}`;
  return null;
}

export function dayKey(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 10);
}
