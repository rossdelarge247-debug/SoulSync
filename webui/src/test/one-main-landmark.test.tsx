import type { ReactNode } from 'react';

import { render } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import AutomixLab from '@/features/engine/harness/automix-lab';
import { StepFrame } from '@/features/onboarding/ui';
import { AutoSyncBoard } from '@/routes/sync/-ui/autosync-board';

/**
 * UX-28 (gauntlet review M5): the page has one <main>, index.html's, round
 * the routed content. Nothing rendered into it (or over it) brings another.
 */

/** index.html's own landmark, with a view rendered in it */
function inPage(view: ReactNode) {
  return render(<main id="webui-react-root">{view}</main>);
}

describe('one <main> with a view rendered in it', () => {
  it('the auto-mix lab', () => {
    inPage(<AutomixLab />);
    expect(document.querySelectorAll('main')).toHaveLength(1);
  });

  it('the Auto-Sync board', () => {
    inPage(
      <AutoSyncBoard
        playlists={[]}
        playlistSchedules={{}}
        runHistory={[]}
        now={Date.UTC(2026, 0, 1)}
        actions={{
          onDrop: vi.fn(),
          onRun: vi.fn(),
          onUnschedule: vi.fn(),
          onOrganizeChange: vi.fn(),
          onBulkMenu: vi.fn(),
          onRefresh: vi.fn(),
        }}
      />,
    );
    expect(document.querySelector('.auto-sync-lanes')).not.toBeNull();
    expect(document.querySelectorAll('main')).toHaveLength(1);
  });

  it('the setup flow (drawn over the page)', () => {
    inPage(
      <StepFrame step="welcome" title="Welcome">
        <p>Hello</p>
      </StepFrame>,
    );
    expect(document.querySelectorAll('main')).toHaveLength(1);
  });
});

it('no component of the web app draws its own <main>', () => {
  const root = resolve(process.cwd(), 'src');
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name))
        if (/<main[\s>]/.test(readFileSync(path, 'utf8'))) found.push(path.slice(root.length + 1));
    }
  };
  walk(root);
  expect(found).toEqual([]);
});
