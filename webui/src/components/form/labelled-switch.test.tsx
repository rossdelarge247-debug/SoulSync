import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { LabelledSwitch } from './form';

describe('LabelledSwitch (10a’s Blend, 4d)', () => {
  it('is one switch with its state in words', () => {
    function Host() {
      const [on, setOn] = useState(true);
      return (
        <LabelledSwitch aria-label="Blend between presets" checked={on} onCheckedChange={setOn} />
      );
    }
    render(<Host />);
    const sw = screen.getByRole('switch', { name: 'Blend between presets' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(sw).toHaveTextContent('On');
    fireEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw).toHaveTextContent('Off');
  });

  it('disabled stays focusable and doesn’t change', () => {
    const change = vi.fn();
    render(<LabelledSwitch aria-label="Peaks" checked={false} disabled onCheckedChange={change} />);
    const sw = screen.getByRole('switch', { name: 'Peaks' });
    expect(sw).toHaveAttribute('aria-disabled', 'true');
    expect(sw).not.toBeDisabled();
    fireEvent.click(sw);
    expect(change).not.toHaveBeenCalled();
  });
});
