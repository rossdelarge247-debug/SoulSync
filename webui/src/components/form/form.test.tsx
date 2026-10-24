import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  Button,
  Checkbox,
  FormActions,
  FormError,
  FormField,
  OptionButton,
  OptionButtonGroup,
  OptionCard,
  OptionCardGroup,
  RangeInput,
  Select,
  Switch,
  TextArea,
  TextInput,
} from './form';

function FormDemo() {
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [category, setCategory] = useState<'wrong_cover' | 'wrong_metadata'>('wrong_cover');
  const [priority, setPriority] = useState<'low' | 'normal' | 'high'>('normal');
  const [status, setStatus] = useState('open');
  const [archive, setArchive] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [confidence, setConfidence] = useState(90);

  return (
    <form>
      <FormField label="Title" helperText="Short summary" htmlFor="title-input">
        <TextInput
          id="title-input"
          placeholder="Enter title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </FormField>

      <FormField label="Details" helperText="Longer explanation" htmlFor="details-input">
        <TextArea
          id="details-input"
          placeholder="Enter details"
          rows={3}
          value={details}
          onChange={(event) => setDetails(event.target.value)}
        />
      </FormField>

      <FormField label="Category" helperText="Pick one">
        <OptionCardGroup>
          <OptionCard
            description="Album art is wrong"
            icon="🖼️"
            onClick={() => setCategory('wrong_cover')}
            selected={category === 'wrong_cover'}
            title="Wrong Cover"
          />
          <OptionCard
            description="Metadata needs fixing"
            icon="🏷️"
            onClick={() => setCategory('wrong_metadata')}
            selected={category === 'wrong_metadata'}
            title="Wrong Metadata"
          />
        </OptionCardGroup>
      </FormField>

      <FormField label="Priority" helperText="Set urgency">
        <OptionButtonGroup>
          {(['low', 'normal', 'high'] as const).map((value) => (
            <OptionButton
              key={value}
              onClick={() => setPriority(value)}
              selected={priority === value}
            >
              {value[0].toUpperCase()}
              {value.slice(1)}
            </OptionButton>
          ))}
        </OptionButtonGroup>
      </FormField>

      <FormField label="Status" helperText="Shared select primitive" htmlFor="status-select">
        <Select
          id="status-select"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="open">Open</option>
          <option value="in_progress">In Progress</option>
          <option value="resolved">Resolved</option>
        </Select>
      </FormField>

      <FormField label="Archive" helperText="Shared checkbox primitive">
        <Checkbox checked={archive} onCheckedChange={setArchive} />
      </FormField>

      <FormField label="Enabled" helperText="Shared switch primitive">
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </FormField>

      <FormField label="Confidence" helperText="Shared range primitive">
        <RangeInput
          label="Confidence"
          min={50}
          max={100}
          value={confidence}
          onValueChange={setConfidence}
        />
      </FormField>

      <FormError message="Validation failed" />

      <FormActions>
        <Button type="button">Cancel</Button>
        <Button type="submit" variant="primary">
          Save
        </Button>
      </FormActions>
    </form>
  );
}

describe('form primitives', () => {
  it('render accessible controls and support selection state', () => {
    render(<FormDemo />);

    expect(screen.getByLabelText('Title')).toHaveAttribute('placeholder', 'Enter title');
    expect(screen.getByLabelText('Details')).toHaveAttribute('placeholder', 'Enter details');
    expect(screen.getByText('Short summary')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Validation failed');
    expect(screen.getByLabelText('Status')).toHaveValue('open');
    expect(screen.getByLabelText('Status')).toHaveAttribute('data-size', 'md');
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'resolved' } });
    expect(screen.getByLabelText('Status')).toHaveValue('resolved');

    const archiveCheckbox = screen.getByRole('checkbox', { name: 'Archive' });
    expect(archiveCheckbox).not.toBeChecked();
    fireEvent.click(archiveCheckbox);
    expect(archiveCheckbox).toBeChecked();

    const enabledSwitch = screen.getByRole('switch', { name: 'Enabled' });
    expect(enabledSwitch).toBeChecked();
    fireEvent.click(enabledSwitch);
    expect(enabledSwitch).not.toBeChecked();

    const confidenceSlider = screen.getByLabelText('Confidence', { selector: 'input' });
    expect(confidenceSlider).toHaveValue('90');
    fireEvent.change(confidenceSlider, { target: { value: '75' } });
    expect(confidenceSlider).toHaveValue('75');

    const wrongCover = screen.getByRole('button', { name: /wrong cover/i });
    const wrongMetadata = screen.getByRole('button', { name: /wrong metadata/i });
    expect(wrongCover).toHaveAttribute('aria-pressed', 'true');
    expect(wrongMetadata).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(wrongMetadata);
    expect(wrongCover).toHaveAttribute('aria-pressed', 'false');
    expect(wrongMetadata).toHaveAttribute('aria-pressed', 'true');

    const highPriority = screen.getByRole('button', { name: 'High' });
    expect(highPriority).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(highPriority);
    expect(highPriority).toHaveAttribute('aria-pressed', 'true');

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('data-variant', 'primary');
  });

  it('supports compact option button groups', () => {
    const { container } = render(
      <OptionButtonGroup size="sm">
        <OptionButton selected>All</OptionButton>
        <OptionButton variant="ghost">Pending</OptionButton>
      </OptionButtonGroup>,
    );

    expect(container.querySelector('[data-size="sm"]')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pending' })).toHaveAttribute(
      'data-variant',
      'ghost',
    );
  });

  it('supports compact select sizing', () => {
    render(
      <Select aria-label="Compact" defaultValue="one" size="sm">
        <option value="one">One</option>
        <option value="two">Two</option>
      </Select>,
    );

    expect(screen.getByLabelText('Compact')).toHaveAttribute('data-size', 'sm');
  });
});

describe('Button: disabled is neutral, with its reason', () => {
  const REASON = 'Tick "I checked the list" to move the files.';

  it('with a reason: stays focusable (aria-disabled), neutral, and says why', () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" size="lg" disabled disabledReason={REASON} onClick={onClick}>
        Move 1,204 files
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Move 1,204 files' });

    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toHaveAttribute('disabled');
    expect(button.className).toMatch(/disabledNeutral/);
    // the reason is on screen, beside the button, and read out with it
    const reason = screen.getByText(REASON);
    expect(reason).toHaveAttribute('data-slot', 'disabled-reason');
    expect(button.nextElementSibling).toBe(reason);
    expect(button).toHaveAccessibleDescription(REASON);

    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps a caller aria-describedby alongside the reason', () => {
    render(
      <>
        <p id="extra">Large move.</p>
        <Button disabled disabledReason="Not yet." aria-describedby="extra">
          Go
        </Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Go' })).toHaveAccessibleDescription(
      'Large move. Not yet.',
    );
  });

  it('without a reason: the native disabled attribute, still the neutral class', () => {
    render(
      <Button variant="primary" disabled>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toBeDisabled();
    expect(button.className).toMatch(/disabledNeutral/);
  });

  it('once enabled: no reason, no aria-disabled, no neutral class', () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" disabledReason={REASON} onClick={onClick}>
        Move 1,204 files
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Move 1,204 files' });
    expect(screen.queryByText(REASON)).toBeNull();
    expect(button).not.toHaveAttribute('aria-disabled');
    expect(button).not.toHaveAttribute('aria-describedby');
    expect(button.className).not.toMatch(/disabledNeutral/);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('marks lg buttons for the 44px size', () => {
    render(<Button size="lg">Cancel</Button>);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute('data-size', 'lg');
  });
});

describe('Button: the warning tone (234)', () => {
  it('marks a primary in the warning tone, and only when asked', () => {
    render(
      <>
        <Button variant="primary" tone="warning">
          Replace it
        </Button>
        <Button variant="primary">Save 23 tracks</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Replace it' })).toHaveAttribute(
      'data-tone',
      'warning',
    );
    expect(screen.getByRole('button', { name: 'Save 23 tracks' })).not.toHaveAttribute('data-tone');
  });
});

describe('FormField error', () => {
  it('marks the control invalid and shows the message', () => {
    render(
      <FormField label="Playlist link" htmlFor="link" error="That isn't a playlist link.">
        <TextInput id="link" defaultValue="spotify.com/sunday" />
      </FormField>,
    );
    expect(screen.getByLabelText('Playlist link')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent("That isn't a playlist link.");
  });

  it('supports the 44px select', () => {
    render(
      <Select aria-label="Search for" defaultValue="all" size="lg">
        <option value="all">everything on Wanted</option>
      </Select>,
    );
    expect(screen.getByLabelText('Search for')).toHaveAttribute('data-size', 'lg');
  });
});
