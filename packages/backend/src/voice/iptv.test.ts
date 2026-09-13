import { describe, it, expect } from 'vitest';
import { parseM3u, matchChannel, sortChannelNames } from './iptv.js';

const PLAYLIST = `#EXTM3U
#EXTINF:-1 tvg-id="yle1" group-title="FI",Yle TV1
http://example.test/yle1.m3u8
#EXTINF:-1 tvg-id="mtv3" group-title="FI",MTV 3
#EXTVLCOPT:network-caching=1000
http://example.test/mtv3.m3u8
#EXTINF:-1 group-title="Sport",V Sport 1
http://example.test/vsport1.m3u8
`;

describe('parseM3u', () => {
  it('pairs each display name with the following URL', () => {
    const channels = parseM3u(PLAYLIST);
    expect(channels.size).toBe(3);
    expect(channels.get('yle tv1')).toBe('http://example.test/yle1.m3u8');
    expect(channels.get('v sport 1')).toBe('http://example.test/vsport1.m3u8');
  });

  it('skips directives between #EXTINF and the URL', () => {
    // #EXTVLCOPT sits between MTV 3's name and its URL.
    expect(parseM3u(PLAYLIST).get('mtv 3')).toBe('http://example.test/mtv3.m3u8');
  });

  it('takes the name after the last comma, not the first', () => {
    const channels = parseM3u('#EXTINF:-1 tvg-name="a,b",Channel One\nhttp://x.test/1');
    expect(channels.has('channel one')).toBe(true);
  });

  it('keeps only channels matching the filter', () => {
    const channels = parseM3u(PLAYLIST, ['yle', 'sport']);
    expect([...channels.keys()].sort()).toEqual(['v sport 1', 'yle tv1']);
  });

  it('treats an empty filter as no filter', () => {
    expect(parseM3u(PLAYLIST, []).size).toBe(3);
  });

  it('ignores an #EXTINF with no URL after it', () => {
    expect(parseM3u('#EXTINF:-1,Orphan\n#EXTM3U\n').size).toBe(0);
  });
});

describe('matchChannel', () => {
  const channels = parseM3u(PLAYLIST);

  it('matches an exact name', () => {
    expect(matchChannel(channels, 'yle tv1')).toBe('yle tv1');
  });

  it('matches ignoring spaces, so mtv3 finds "MTV 3"', () => {
    expect(matchChannel(channels, 'mtv3')).toBe('mtv 3');
  });

  it('matches a prefix of the channel name', () => {
    expect(matchChannel(channels, 'vsport')).toBe('v sport 1');
  });

  it('returns null when nothing matches', () => {
    expect(matchChannel(channels, 'bbc')).toBeNull();
  });

  it('returns null for an empty query', () => {
    expect(matchChannel(channels, '   ')).toBeNull();
  });
});

describe('sortChannelNames', () => {
  const channels = parseM3u(PLAYLIST);

  it('keeps playlist order when asked to', () => {
    expect(sortChannelNames(channels, 'playlist')).toEqual(['yle tv1', 'mtv 3', 'v sport 1']);
  });

  it('sorts alphabetically when asked to', () => {
    expect(sortChannelNames(channels, 'name')).toEqual(['mtv 3', 'v sport 1', 'yle tv1']);
  });
});
