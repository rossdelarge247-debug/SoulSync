import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  LARGE_MOVE_CHECK_LABEL,
  LARGE_MOVE_REASON,
  refusalTitle,
  SafeActionDialog,
  type SafeActionDialogProps,
  type SafeActionPhase,
} from './safe-action-dialog';

const EXPIRED = 'That preview is out of date. Preview again so you confirm what is on disk now.';

const stats = [
  { label: 'Files', value: '1,204' },
  { label: 'Size', value: '38.2 GB' },
  { label: 'Share of library', value: '31%' },
];

function base(overrides: Partial<SafeActionDialogProps> = {}): SafeActionDialogProps {
  return {
    open: true,
    onClose: vi.fn(),
    phase: { kind: 'review' },
    title: 'Move 1,204 files to staging?',
    stats,
    lead: 'They move to the staging folder for you to review. Nothing is deleted.',
    columns: ['File', 'Goes to'],
    rows: [{ key: 'a', cells: ['Saltmarsh/Lantern/03 Static Bloom.flac', 'Staging'] }],
    shownLabel: '1 of 1,204 files shown',
    confirmLabel: 'Move 1,204 files',
    onConfirm: vi.fn(),
    secondary: { label: 'Scan without moving', onClick: vi.fn() },
    onPreviewAgain: vi.fn(),
    ...overrides,
  };
}

/** The dialog with a working large-move box, the way the deep scan uses it. */
function Guarded({ onConfirm }: { onConfirm: () => void }) {
  const [ticked, setTicked] = useState(false);
  return (
    <SafeActionDialog
      {...base({ onConfirm })}
      guard={{ message: 'Large move.', checked: ticked, onChange: setTicked }}
      confirmDisabled={!ticked}
    />
  );
}

describe('SafeActionDialog v2: the disabled confirm', () => {
  it('is neutral and focusable until the box is ticked, with the reason beside it', () => {
    const onConfirm = vi.fn();
    render(<Guarded onConfirm={onConfirm} />);
    const dialog = screen.getByRole('dialog');
    const move = within(dialog).getByRole('button', { name: 'Move 1,204 files' });

    expect(move).toHaveAttribute('aria-disabled', 'true');
    expect(move).not.toHaveAttribute('disabled');
    expect(move.className).toMatch(/disabledNeutral/);
    expect(move).toHaveAttribute('data-size', 'lg');
    expect(within(dialog).getByText(LARGE_MOVE_REASON)).toHaveAttribute(
      'data-slot',
      'disabled-reason',
    );
    expect(move).toHaveAccessibleDescription(LARGE_MOVE_REASON);
    fireEvent.click(move);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByLabelText(LARGE_MOVE_CHECK_LABEL));
    expect(move).not.toHaveAttribute('aria-disabled');
    expect(move.className).not.toMatch(/disabledNeutral/);
    expect(within(dialog).queryByText(LARGE_MOVE_REASON)).toBeNull();
    fireEvent.click(move);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('takes the reason from the caller when there is one', () => {
    render(
      <SafeActionDialog
        {...base()}
        confirmDisabled
        confirmDisabledReason="Pick at least one file to fix."
      />,
    );
    expect(screen.getByRole('button', { name: 'Move 1,204 files' })).toHaveAccessibleDescription(
      'Pick at least one file to fix.',
    );
  });

  it('says nothing beside a confirm that is only busy', () => {
    render(<SafeActionDialog {...base()} confirmBusy />);
    const busy = screen.getByRole('button', { name: 'Working…' });
    expect(busy).toBeDisabled();
    expect(document.querySelector('[data-slot="disabled-reason"]')).toBeNull();
  });

  it('keeps the danger tone for permanent deletes', () => {
    render(
      <SafeActionDialog {...base({ confirmLabel: 'Delete 418 files' })} confirmTone="danger" />,
    );
    expect(screen.getByRole('button', { name: 'Delete 418 files' })).toHaveAttribute(
      'data-tone',
      'danger',
    );
  });

  it('every footer button is the 44px size', () => {
    render(<SafeActionDialog {...base()} />);
    const footer = screen.getByRole('button', { name: 'Cancel' }).parentElement as HTMLElement;
    for (const button of within(footer).getAllByRole('button')) {
      expect(button).toHaveAttribute('data-size', 'lg');
    }
  });
});

describe('SafeActionDialog v2: a preview that expired', () => {
  const expired: SafeActionPhase = {
    kind: 'refused',
    code: 'plan_expired',
    message: EXPIRED,
    previewAgain: true,
  };

  it('keeps the title, shows a warning Notice with the backend sentence, fades the counts', () => {
    render(<SafeActionDialog {...base({ phase: expired })} />);
    const dialog = screen.getByRole('dialog');

    expect(
      within(dialog).getByRole('heading', { name: 'Move 1,204 files to staging?' }),
    ).toBeTruthy();
    const notice = within(dialog).getByRole('alert');
    expect(notice).toHaveAttribute('data-tone', 'warning');
    expect(notice).toHaveAttribute('data-code', 'plan_expired');
    expect(within(notice).getByText('This preview has expired')).toBeTruthy();
    expect(within(notice).getByText(EXPIRED)).toBeTruthy();
    expect(within(notice).getByText('Nothing was moved or deleted.')).toBeTruthy();
    // never the code alone
    expect(within(dialog).queryByText(/plan_expired/)).toBeNull();

    const counts = dialog.querySelector('dl') as HTMLElement;
    expect(counts).toHaveAttribute('data-faded', 'true');
    expect(counts).toHaveAttribute('aria-hidden', 'true');
    expect(counts).toHaveTextContent('1,204');
    // the review body is gone: no table, no confirm
    expect(within(dialog).queryByRole('table')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Move 1,204 files' })).toBeNull();
  });

  it('offers Cancel and a primary Preview again', () => {
    const props = base({ phase: expired });
    render(<SafeActionDialog {...props} />);
    const dialog = screen.getByRole('dialog');

    const again = within(dialog).getByRole('button', { name: 'Preview again' });
    expect(again).toHaveAttribute('data-variant', 'primary');
    fireEvent.click(again);
    expect(props.onPreviewAgain).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(props.onClose).toHaveBeenCalled();
  });

  it('says a used or unknown preview can no longer be used', () => {
    expect(refusalTitle({ code: 'plan_unknown', previewAgain: true })).toBe(
      'This preview can no longer be used',
    );
    expect(refusalTitle({ code: 'plan_expired', previewAgain: true })).toBe(
      'This preview has expired',
    );
  });

  it('a failure that is not a plan refusal is a danger Notice with Close', () => {
    render(
      <SafeActionDialog
        {...base({
          phase: {
            kind: 'refused',
            message: 'The delete did not go through.',
            previewAgain: false,
          },
        })}
      />,
    );
    const notice = screen.getByRole('alert');
    expect(notice).toHaveAttribute('data-tone', 'danger');
    expect(within(notice).getByText("That didn't go through")).toBeTruthy();
    expect(within(notice).queryByText('Nothing was moved or deleted.')).toBeNull();
    // the footer's Close (the header's × is also called Close)
    const closes = screen.getAllByRole('button', { name: 'Close' });
    expect(closes.some((b) => b.getAttribute('data-variant') === 'primary')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Preview again' })).toBeNull();
  });
});
