import { describe, expect, it } from 'vitest';

import { parseQuery, parseType, searchUrlFor, validateSearchUrl } from './-search.url';

describe('the Search URL', () => {
  it('keeps the query and type, leaving defaults out', () => {
    expect(validateSearchUrl({ q: 'pale harbour', type: 'albums' })).toEqual({
      q: 'pale harbour',
      type: 'albums',
    });
    expect(validateSearchUrl({ q: 'pale harbour', type: 'everything' })).toEqual({
      q: 'pale harbour',
    });
    expect(validateSearchUrl({})).toEqual({});
  });

  it('reads a number or boolean query as the text that was searched', () => {
    // TanStack JSON-parses search values: ?q=311 arrives as a number
    expect(parseQuery(311)).toBe('311');
    expect(parseQuery(true)).toBe('true');
    expect(validateSearchUrl({ q: 311 })).toEqual({ q: '311' });
    expect(parseQuery({ nope: 1 })).toBe('');
  });

  it('trims the query and drops a blank one', () => {
    expect(validateSearchUrl({ q: '  low light  ' })).toEqual({ q: 'low light' });
    expect(validateSearchUrl({ q: '   ' })).toEqual({});
  });

  it('falls back to Everything for a type it doesn’t know', () => {
    expect(parseType('playlists')).toBe('everything');
    expect(parseType(undefined)).toBe('everything');
    expect(parseType('tracks')).toBe('tracks');
  });

  it('builds the URL for a query and type', () => {
    expect(searchUrlFor(' pale harbour ', 'tracks')).toEqual({ q: 'pale harbour', type: 'tracks' });
    expect(searchUrlFor('', 'everything')).toEqual({});
  });
});
