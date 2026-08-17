import { memo, useEffect, useRef } from 'react';
import type { FilterDef } from '../filters';

export interface FilterSelectorProps {
  filters: readonly FilterDef[];
  activeId: string;
  onSelect: (id: string) => void;
}

/**
 * Horizontally scrollable filter rail. Memoised because the engine pushes a
 * status update roughly twice a second and this list never needs to follow it.
 */
export const FilterSelector = memo(function FilterSelector({
  filters,
  activeId,
  onSelect,
}: FilterSelectorProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // Keep the selected chip in view when it changes from outside (keyboard, etc).
  useEffect(() => {
    activeRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'center',
    });
  }, [activeId]);

  return (
    <div className="rail" ref={railRef} role="tablist" aria-label="Filters">
      {filters.map((f) => {
        const active = f.id === activeId;
        return (
          <button
            key={f.id}
            ref={active ? activeRef : undefined}
            type="button"
            role="tab"
            aria-selected={active}
            className={`chip${active ? ' chip--active' : ''}`}
            onClick={() => onSelect(f.id)}
            style={
              {
                '--c1': f.accent[0],
                '--c2': f.accent[1],
              } as React.CSSProperties
            }
          >
            <span className="chip__swatch" aria-hidden="true" />
            <span className="chip__label">{f.name}</span>
          </button>
        );
      })}
    </div>
  );
});
