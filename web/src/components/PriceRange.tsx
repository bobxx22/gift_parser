interface Props {
  min: string;
  max: string;
  onChange: (next: { min: string; max: string }) => void;
  /** Enter в поле — сразу искать. */
  onSubmit?: () => void;
  disabled?: boolean;
}

/** Пустое поле = границы нет; наружу отдаём строки, число собирает вызывающий. */
export function PriceRange({ min, max, onChange, onSubmit, disabled }: Props) {
  const key = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') onSubmit?.();
  };
  return (
    <div className="range">
      <input
        className="range__input"
        type="number"
        min={0}
        step="any"
        placeholder="от"
        value={min}
        disabled={disabled}
        onChange={(event) => onChange({ min: event.target.value, max })}
        onKeyDown={key}
      />
      <span className="range__dash">—</span>
      <input
        className="range__input"
        type="number"
        min={0}
        step="any"
        placeholder="до"
        value={max}
        disabled={disabled}
        onChange={(event) => onChange({ min, max: event.target.value })}
        onKeyDown={key}
      />
      <span className="range__unit">TON</span>
    </div>
  );
}

/** Строка из поля → число для запроса; мусор и ноль считаем «границы нет». */
export function toPrice(value: string): number | null {
  const price = Number(value.replace(',', '.'));
  return Number.isFinite(price) && price > 0 ? price : null;
}
