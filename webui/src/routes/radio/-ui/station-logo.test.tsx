/**
 * The station logo tile (HANDOFF 55): our own address only, the letters
 * while it loads and when it can't be used.
 */

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { StationLogo, isOwnLogo } from './parts';

afterEach(cleanup);

describe('StationLogo', () => {
  it('shows the letters until the logo has loaded, then the logo', () => {
    const { container } = render(
      <StationLogo
        station={{ name: 'NTS 1', logo_url: '/api/radio/stations/nts-1/logo?v=ab12' }}
      />,
    );
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/api/radio/stations/nts-1/logo?v=ab12');
    expect(container.textContent).toBe('NTS');
    expect(img.dataset.loaded).toBeUndefined();
    fireEvent.load(img);
    expect(container.querySelector('img')!.dataset.loaded).toBe('true');
    expect(container.textContent).toBe('');
  });

  it('keeps the letters when the logo can’t be fetched', () => {
    const { container } = render(
      <StationLogo station={{ name: 'KEXP', logo_url: '/api/radio/stations/kexp/logo?v=1' }} />,
    );
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('KEXP');
  });

  it('never loads another host, even if one is handed to it', () => {
    const { container } = render(
      <StationLogo station={{ name: 'Evil', logo_url: 'https://evil.example.com/x.png' }} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(isOwnLogo('/api/radio/stations/rb-12345678-1234-1234-1234-123456789abc/logo?v=1')).toBe(
      true,
    );
    expect(isOwnLogo('//evil.example.com/api/radio/stations/x/logo')).toBe(false);
    expect(isOwnLogo('/api/radio/stations/../../x/logo')).toBe(false);
  });
});
