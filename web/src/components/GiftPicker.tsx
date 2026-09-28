import { useEffect, useMemo, useRef, useState } from 'react';

import type { BackdropColors } from '../types';

export interface PickerOption {
  value: string;
  label: string;
  subtitle: string;
  image: string | null;
  colors: BackdropColors | null;
}

interface Props {
  title: string;
  value: string | null;
  placeholder?: string;
  allowAny?: boolean;
  disabled?: boolean;
  load: (query: string) => Promise<PickerOption[]>;
  onChange: (value: string | null) => void;
}

const ANY = '— любой —';

export function gradient(colors: BackdropColors | null): string | undefined {
  if (!colors) return undefined;
  const hex = (value: number) => `#${(value >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
  return `radial-gradient(circle at 50% 45%, ${hex(colors.center)}, ${hex(colors.edge)})`;
}

/**
 * Поле поиска со списком: картинка, название и флор.
 * Ищет по любому слову, закрывается кликом вне поля и по Escape.
 */
export function GiftPicker({ title, value, placeholder, allowAny, disabled, load, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<PickerOption[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      load(query)
        .then((items) => {
          if (cancelled) return;
          const list = allowAny
            ? [{ value: '', label: ANY, subtitle: '', image: null, colors: null }, ...items]
            : items;
          setOptions(list);
          // Набранный текст важнее строки «любой».
          setActive(allowAny && query.trim() && list.length > 1 ? 1 : 0);
        })
        .catch(() => setOptions([]))
        .finally(() => !cancelled && setLoading(false));
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query, load, allowAny]);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const display = useMemo(() => (open ? query : value ?? ''), [open, query, value]);

  const choose = (option: PickerOption) => {
    onChange(option.value || null);
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="picker" ref={boxRef}>
      <label className="picker__label">{title}</label>
      <input
        className="picker__input"
        value={display}
        placeholder={placeholder ?? 'начни вводить…'}
        disabled={disabled}
        onFocus={() => {
          setQuery('');
          setOpen(true);
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive((index) => Math.min(index + 1, options.length - 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
          } else if (event.key === 'Enter') {
            event.preventDefault();
            const pick = (list: PickerOption[]) => {
              const needle = query.trim().toLowerCase();
              const exact = list.find((option) => option.label.toLowerCase() === needle);
              const option = exact ?? list[active] ?? list.find((item) => item.value);
              if (option) choose(option);
            };
            if (options.length) pick(options);
            else if (query.trim()) {
              // Список ещё грузится — дожидаемся и берём первое совпадение.
              load(query).then(pick).catch(() => undefined);
            }
          } else if (event.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {value && !open ? (
        <button className="picker__clear" onClick={() => onChange(null)} title="Очистить">
          ×
        </button>
      ) : null}

      {open ? (
        <div className="picker__menu">
          {loading && !options.length ? <div className="picker__empty">Ищу…</div> : null}
          {!loading && !options.length ? <div className="picker__empty">Ничего не найдено</div> : null}
          {options.map((option, index) => (
            <div
              key={`${option.value}-${option.label}`}
              className={`picker__row ${index === active ? 'picker__row--active' : ''}`}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(option);
              }}
            >
              <div className="picker__icon" style={{ background: gradient(option.colors) }}>
                {option.image ? <img src={option.image} alt="" loading="lazy" /> : null}
              </div>
              <div className="picker__name">{option.label}</div>
              <div className="picker__meta">{option.subtitle}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
