import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  Badge,
  EmptyState,
  LoadingState,
  Notice,
  Show,
  Skeleton,
  SkeletonList,
  Spinner,
  StatusTag,
} from './primitives';

describe('Show', () => {
  it('renders children when the condition is true', () => {
    render(
      <Show when={true}>
        <span>Visible</span>
      </Show>,
    );

    expect(screen.getByText('Visible')).toBeInTheDocument();
  });

  it('renders fallback when the condition is false', () => {
    render(
      <Show fallback={<span>Hidden</span>} when={false}>
        <span>Visible</span>
      </Show>,
    );

    expect(screen.getByText('Hidden')).toBeInTheDocument();
    expect(screen.queryByText('Visible')).not.toBeInTheDocument();
  });

  it('supports render-prop children', () => {
    render(<Show when="Ada">{(name) => <span>{name}</span>}</Show>);

    expect(screen.getByText('Ada')).toBeInTheDocument();
  });
});

describe('Notice', () => {
  it('stacked (12a): the title row, then the sentence and the actions from the padding edge', () => {
    const { container } = render(
      <Notice
        layout="stacked"
        tone="warning"
        title="Spotify asked us to wait 11 min"
        actions={<button type="button">Try again now</button>}
      >
        <p>After checking an artist's albums.</p>
      </Notice>,
    );
    const notice = container.firstElementChild as HTMLElement;
    expect(notice.dataset.layout).toBe('stacked');
    const parts = [...notice.children].map((el) => el.getAttribute('data-slot') ?? 'main');
    // the body and the actions are the Notice's own children, not inside the title's column
    expect(parts).toEqual(['main', 'notice-body', 'notice-actions']);
    expect(notice.querySelector('[data-slot="notice-title"]')!.textContent).toBe(
      'Spotify asked us to wait 11 min',
    );
  });

  it('renders as a note by default', () => {
    render(<Notice>Fallback message</Notice>);

    expect(screen.getByText('Fallback message')).toHaveAttribute('role', 'note');
    expect(screen.getByText('Fallback message')).toHaveAttribute('data-tone', 'info');
  });

  it('supports tone overrides', () => {
    render(
      <Notice tone="warning">
        <span>Provider fallback</span>
      </Notice>,
    );

    expect(screen.getByRole('note')).toHaveAttribute('data-tone', 'warning');
  });
});

describe('Badge', () => {
  it('renders with neutral styling by default', () => {
    render(<Badge>12</Badge>);

    expect(screen.getByText('12')).toHaveAttribute('data-slot', 'badge');
    expect(screen.getByText('12')).toHaveAttribute('data-tone', 'neutral');
  });

  it('supports tone overrides', () => {
    render(<Badge tone="warning">12</Badge>);

    expect(screen.getByText('12')).toHaveAttribute('data-tone', 'warning');
  });
});

describe('Spinner', () => {
  it('is decorative, 16px and accent-toned by default', () => {
    const { container } = render(<Spinner />);
    const spinner = container.querySelector('[data-slot="spinner"]');

    expect(spinner).toHaveAttribute('aria-hidden', 'true');
    expect(spinner).toHaveAttribute('data-tone', 'accent');
    expect(spinner).toHaveStyle({ '--spinner-size': '16px', '--spinner-ring': '2px' });
  });

  it('becomes a labelled status when given a label', () => {
    render(<Spinner label="Searching" />);

    expect(screen.getByRole('status', { name: 'Searching' })).not.toHaveAttribute('aria-hidden');
  });

  it('supports size and tone overrides', () => {
    render(<Spinner label="Loading" size={32} tone="tinted" />);

    const spinner = screen.getByRole('status', { name: 'Loading' });
    expect(spinner).toHaveAttribute('data-tone', 'tinted');
    expect(spinner).toHaveStyle({ '--spinner-size': '32px', '--spinner-ring': '3px' });
  });
});

describe('Skeleton', () => {
  it('renders a hidden placeholder that keeps the caller class', () => {
    const { container } = render(<Skeleton className="card" />);
    const skeleton = container.querySelector('[data-slot="skeleton"]');

    expect(skeleton).toHaveAttribute('aria-hidden', 'true');
    expect(skeleton).toHaveClass('card');
  });
});

describe('EmptyState', () => {
  it('renders the title as a heading with its description', () => {
    render(<EmptyState title="No issues found" description="Try adjusting your filters" />);

    expect(screen.getByRole('heading', { name: 'No issues found' })).toBeInTheDocument();
    expect(screen.getByText('Try adjusting your filters')).toHaveAttribute(
      'data-slot',
      'empty-state-description',
    );
  });

  it('hides the icon from assistive tech and renders children as actions', () => {
    const { container } = render(
      <EmptyState icon="🔍" title="Nothing here">
        <button type="button">Retry</button>
      </EmptyState>,
    );

    expect(container.querySelector('[data-slot="empty-state-icon"]')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('leaves out the slots it is not given', () => {
    const { container } = render(<EmptyState title="Empty" />);

    expect(container.querySelector('[data-slot="empty-state-icon"]')).toBeNull();
    expect(container.querySelector('[data-slot="empty-state-description"]')).toBeNull();
  });
});

describe('EmptyState variant="panel"', () => {
  it('a heading, two short paragraphs and one primary action, in a card', () => {
    const { container } = render(
      <EmptyState
        variant="panel"
        title="Nothing wanted yet"
        description="Add tracks or albums you want and SoulSync looks for them on every scheduled search."
        hint="You can add from Search, from a playlist, or from an artist page."
        actions={<button type="button">Search for music</button>}
      />,
    );

    const panel = container.querySelector('[data-slot="empty-state"]');
    expect(panel).toHaveAttribute('data-variant', 'panel');
    expect(screen.getByRole('heading', { level: 2, name: 'Nothing wanted yet' })).toBeTruthy();
    expect(screen.getByText(/looks for them on every scheduled search/)).toHaveAttribute(
      'data-slot',
      'empty-state-description',
    );
    expect(screen.getByText(/You can add from Search/)).toHaveAttribute(
      'data-slot',
      'empty-state-hint',
    );
    expect(container.querySelector('[data-slot="empty-state-actions"]')?.textContent).toBe(
      'Search for music',
    );
  });

  it('the default variant is unchanged and still takes actions', () => {
    render(<EmptyState title="Empty" actions={<button type="button">Retry</button>} />);
    expect(screen.getByRole('heading', { level: 3, name: 'Empty' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});

describe('LoadingState', () => {
  it('says what is loading in words beside the spinner, in a live region', () => {
    const { container } = render(<LoadingState label="Loading your list…" />);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading your list…');
    expect(status.querySelector('[data-slot="spinner"]')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('[data-slot="loading-state"]')).toHaveAttribute(
      'aria-busy',
      'true',
    );
  });

  it('then shows five placeholder rows in a list shape by default', () => {
    const { container } = render(<LoadingState label="Loading your list…" />);

    const list = container.querySelector('[data-slot="skeleton-list"]');
    expect(list).toHaveAttribute('aria-hidden', 'true');
    expect(list?.children).toHaveLength(5);
  });

  it('takes placeholders in the content’s own shape', () => {
    const { container } = render(
      <LoadingState label="Loading the last 7 days…">
        <SkeletonList rows={2} art={0} />
      </LoadingState>,
    );
    const list = container.querySelector('[data-slot="skeleton-list"]');
    expect(list?.children).toHaveLength(2);
    expect(list?.querySelector('[data-art]')).toBeNull();
  });
});

describe('SkeletonList', () => {
  it('rows of art, two lines and a tag; faded behind an error', () => {
    const { container } = render(<SkeletonList rows={2} faded roundArt />);
    const list = container.querySelector('[data-slot="skeleton-list"]');

    expect(list).toHaveAttribute('data-faded', 'true');
    expect(list?.children).toHaveLength(2);
    const row = list?.children[0] as HTMLElement;
    expect(row).toHaveAttribute('data-art', 'true');
    expect(row).toHaveAttribute('data-tag', 'true');
    expect(row.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(4);
    expect(row.querySelector('[data-round="true"]')).toBeTruthy();
  });
});

describe('StatusTag', () => {
  it('is a dot and a word, neutral by default', () => {
    render(<StatusTag>Not found yet</StatusTag>);

    const tag = screen.getByText('Not found yet');
    expect(tag).toHaveAttribute('data-slot', 'status-tag');
    expect(tag).toHaveAttribute('data-tone', 'neutral');
    expect(tag.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(tag).not.toHaveAttribute('data-live');
  });

  it('takes a tone and a live pulse', () => {
    render(
      <StatusTag tone="info" live>
        Searching
      </StatusTag>,
    );
    const tag = screen.getByText('Searching');
    expect(tag).toHaveAttribute('data-tone', 'info');
    expect(tag).toHaveAttribute('data-live', 'true');
  });
});

describe('Notice with a title', () => {
  it('a title that says what didn’t happen, why, and the actions that help', () => {
    render(
      <Notice
        tone="danger"
        role="alert"
        title="Couldn't load your list"
        actions={<button type="button">Try again</button>}
      >
        SoulSync didn&apos;t answer in 10 seconds. Your list is safe.
      </Notice>,
    );

    const notice = screen.getByRole('alert');
    expect(notice).toHaveAttribute('data-tone', 'danger');
    expect(notice).toHaveAttribute('data-slot', 'notice');
    expect(screen.getByText("Couldn't load your list")).toHaveAttribute(
      'data-slot',
      'notice-title',
    );
    expect(screen.getByText(/Your list is safe/)).toHaveAttribute('data-slot', 'notice-body');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('without a title it is the compact note it always was', () => {
    render(<Notice tone="warning">Heads up</Notice>);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('Heads up');
    expect(note).not.toHaveAttribute('data-slot');
  });
});
