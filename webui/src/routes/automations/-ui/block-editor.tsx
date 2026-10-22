/**
 * The block editor's moving parts (board 3b, 3l): the Then blocks' drag
 * handle (drag to reorder, or open it for Move up / Move down from the
 * keyboard), and the empty follow-up line where "/" opens the menu of what
 * can follow: Notify, Fire a signal, Run a script (admins) and Ask the
 * Assistant.
 */

import { Menu } from '@base-ui/react/menu';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { MAX_THEN_STEPS } from '../-automations.draft';
import styles from './automations.module.css';
import { ADD_STEP_TYPES } from './editor-fields';

function GripIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="9" cy="6" r="1.6" />
      <circle cx="15" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" />
      <circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" />
      <circle cx="15" cy="18" r="1.6" />
    </svg>
  );
}

/**
 * A Then block's handle: drag it to reorder; press it (or Enter / Space) for
 * Move up and Move down, so the order changes without a mouse too.
 */
export function DragHandle({
  index,
  count,
  onMove,
  onDragStart,
  onDragEnd,
}: {
  /** 1-based. */
  index: number;
  count: number;
  onMove: (by: number) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        className={styles.dragHandle}
        aria-label={`Move Then ${index} (${index} of ${count})`}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', String(index));
          onDragStart();
        }}
        onDragEnd={onDragEnd}
      >
        <GripIcon />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className={styles.menuPositioner} align="start" sideOffset={6}>
          <Menu.Popup className={styles.menu}>
            <Menu.Item
              className={styles.menuItem}
              disabled={index === 1}
              onClick={() => onMove(-1)}
            >
              Move up
            </Menu.Item>
            <Menu.Item
              className={styles.menuItem}
              disabled={index === count}
              onClick={() => onMove(1)}
            >
              Move down
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Reordering by drag: who's being dragged, where it would land, and the move. */
export function useBlockDrag<T extends { key: string }>(
  items: T[],
  onReorder: (from: number, to: number) => void,
) {
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const propsFor = (key: string) => ({
    dragging: dragKey === key,
    dropTarget: dragKey != null && overKey === key && dragKey !== key,
    onDragOver: (event: React.DragEvent<HTMLLIElement>) => {
      if (dragKey == null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (overKey !== key) setOverKey(key);
    },
    onDrop: (event: React.DragEvent<HTMLLIElement>) => {
      if (dragKey == null) return;
      event.preventDefault();
      const from = items.findIndex((i) => i.key === dragKey);
      const to = items.findIndex((i) => i.key === key);
      setDragKey(null);
      setOverKey(null);
      if (from >= 0 && to >= 0 && from !== to) onReorder(from, to);
    },
  });
  return {
    propsFor,
    start: (key: string) => setDragKey(key),
    end: () => {
      setDragKey(null);
      setOverKey(null);
    },
  };
}

export type SlashChoice = { kind: 'step'; type: string } | { kind: 'assistant'; text: string };

interface SlashItem {
  id: string;
  label: string;
  description: string;
  choice: SlashChoice;
}

/**
 * The empty line under the last Then: "Type / to add a follow-up · N of 3
 * left". "/" opens the menu; what you type after it narrows it; arrows,
 * Enter and Escape work as in any menu. On a phone the line is a button
 * ("/" isn't always on the keyboard). At three Thens it says so and offers
 * nothing.
 */
export function SlashLine({
  count,
  isAdmin,
  phone,
  assistant,
  onPick,
}: {
  count: number;
  isAdmin: boolean;
  phone: boolean;
  /** Whether "Ask the Assistant" is offered. */
  assistant: boolean;
  onPick: (choice: SlashChoice) => void;
}) {
  const left = MAX_THEN_STEPS - count;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const items = useMemo<SlashItem[]>(() => {
    const steps: SlashItem[] = ADD_STEP_TYPES.filter((t) => isAdmin || !t.adminOnly).map((t) => ({
      id: t.type,
      label: t.label,
      description: t.description,
      choice: { kind: 'step', type: t.type },
    }));
    if (assistant) {
      steps.push({
        id: 'assistant',
        label: 'Ask the Assistant',
        description: 'Describe the follow-up in words',
        choice: { kind: 'assistant', text: query },
      });
    }
    const q = query.trim().toLowerCase();
    return q
      ? steps.filter((i) => i.label.toLowerCase().includes(q) || i.id === 'assistant')
      : steps;
  }, [assistant, isAdmin, query]);

  useEffect(() => {
    if (active >= items.length) setActive(Math.max(0, items.length - 1));
  }, [active, items.length]);

  // the line is often the last thing on the page: bring the menu into view
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) menuRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open]);

  const close = (refocus = true) => {
    setOpen(false);
    setQuery('');
    setActive(0);
    if (refocus) (phone ? buttonRef : inputRef).current?.focus();
  };
  const pick = (item: SlashItem) => {
    close(false);
    onPick(item.choice.kind === 'assistant' ? { kind: 'assistant', text: query } : item.choice);
  };

  if (left <= 0) {
    return (
      <li className={styles.block} data-variant="slash" data-full="true">
        <div className={styles.blockLabelCol}>
          <span className={styles.blockLabel}>Then</span>
        </div>
        <p className={styles.slashFull}>
          Three follow-ups is the most an automation can have. Remove one to add another.
        </p>
        <div className={styles.blockAside} />
      </li>
    );
  }

  const leftWords = `${left} of ${MAX_THEN_STEPS} left`;
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!open) {
      if (event.key === '/') {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((a) => (a + 1) % Math.max(1, items.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((a) => (a - 1 + items.length) % Math.max(1, items.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (items[active]) pick(items[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Backspace' && !query) {
      close();
    }
  };

  return (
    <li className={styles.block} data-variant="slash">
      <div className={styles.blockLabelCol}>
        <span className={styles.blockLabel}>Then</span>
      </div>
      <div className={styles.slashBody}>
        {phone ? (
          <button
            ref={buttonRef}
            type="button"
            className={styles.slashButton}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            onClick={() => (open ? close() : setOpen(true))}
            onKeyDown={onKeyDown}
          >
            <kbd className={styles.slashKey}>/</kbd>
            <span>Add a follow-up · {leftWords}</span>
          </button>
        ) : (
          <div className={styles.slashRow}>
            {open ? null : (
              <button
                type="button"
                className={styles.slashKey}
                aria-label="Open the follow-up menu"
                aria-haspopup="menu"
                aria-expanded={false}
                onClick={() => {
                  setOpen(true);
                  inputRef.current?.focus();
                }}
              >
                /
              </button>
            )}
            <input
              ref={inputRef}
              className={styles.slashInput}
              aria-label={`Add a follow-up: type / for the menu. ${leftWords}`}
              role="combobox"
              aria-haspopup="menu"
              aria-expanded={open}
              aria-controls={open ? menuId : undefined}
              aria-activedescendant={
                open && items[active] ? `${menuId}-${items[active].id}` : undefined
              }
              placeholder={`Type / to add a follow-up · ${leftWords}`}
              value={open ? `/${query}` : ''}
              onChange={(event) => {
                const value = event.target.value;
                if (!open) {
                  if (value.startsWith('/')) {
                    setOpen(true);
                    setQuery(value.slice(1));
                  }
                  return;
                }
                if (!value.startsWith('/')) close();
                else setQuery(value.slice(1));
              }}
              onKeyDown={onKeyDown}
              onBlur={(event) => {
                if (
                  !event.currentTarget.parentElement?.parentElement?.contains(event.relatedTarget)
                )
                  setTimeout(() => setOpen(false), 120);
              }}
            />
          </div>
        )}
        {open ? (
          <div
            ref={menuRef}
            className={styles.slashMenu}
            id={menuId}
            role="menu"
            aria-label="Add a follow-up"
          >
            <p className={styles.slashMenuLabel} aria-hidden="true">
              Add a follow-up
            </p>
            {items.map((item, i) => (
              <button
                key={item.id}
                id={`${menuId}-${item.id}`}
                type="button"
                role="menuitem"
                className={styles.slashItem}
                data-active={i === active ? 'true' : undefined}
                data-separated={item.id === 'assistant' ? 'true' : undefined}
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(item)}
              >
                <span className={styles.slashItemLabel}>{item.label}</span>
                <span className={styles.slashItemDesc}>{item.description}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className={styles.blockAside} />
    </li>
  );
}
