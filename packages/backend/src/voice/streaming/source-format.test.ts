import { describe, it, expect } from 'vitest';
import {
  VIDEO_FORMAT_SORT,
  parseResolvedFormat,
  videoCodecFamily,
  videoFormatArgs,
  videoFormatFilter,
} from './source-format.js';

describe('videoFormatFilter', () => {
  it('asks for an SDR video+audio pair up to the height, then falls back', () => {
    expect(videoFormatFilter(1440)).toBe(
      'bestvideo[height<=1440][dynamic_range=SDR]+bestaudio'
        + '/best[height<=1440][dynamic_range=SDR]/best[height<=1440]/best',
    );
  });
});

describe('videoFormatArgs', () => {
  it('always asks yt-dlp to prefer VP9', () => {
    expect(videoFormatArgs(1080)).toEqual(['-f', videoFormatFilter(1080), '-S', VIDEO_FORMAT_SORT]);
    expect(videoFormatArgs(2160)).toEqual(['-f', videoFormatFilter(2160), '-S', VIDEO_FORMAT_SORT]);
  });

  // yt-dlp puts -S fields ahead of its defaults, in the order given. With the
  // codec first, a 1080p VP9 would outrank a 1440p AV1; resolution and frame
  // rate must come first so the preference only breaks ties.
  it('sorts by resolution and frame rate before the codec', () => {
    const fields = VIDEO_FORMAT_SORT.split(',');
    expect(fields.slice(0, 2)).toEqual(['res', 'fps']);
    expect(fields[2]).toBe('vcodec:vp9');
  });
});

describe('videoCodecFamily', () => {
  it("maps yt-dlp's and ffprobe's codec names", () => {
    expect(videoCodecFamily('av01.0.13M.08')).toBe('av1');
    expect(videoCodecFamily('av1')).toBe('av1');
    expect(videoCodecFamily('vp9')).toBe('vp9');
    expect(videoCodecFamily('vp09.00.51.08')).toBe('vp9');
    expect(videoCodecFamily('avc1.42001E')).toBe('h264');
    expect(videoCodecFamily('h264')).toBe('h264');
  });

  it('answers empty for anything else, so the sidecar keeps its default decoder', () => {
    expect(videoCodecFamily('')).toBe('');
    expect(videoCodecFamily('none')).toBe('');
    expect(videoCodecFamily('hevc')).toBe('');
  });
});

describe('parseResolvedFormat', () => {
  // As yt-dlp printed it for a 4K test video: the codec, then video and audio URLs.
  it('reads the codec line and the URLs of a DASH pair', () => {
    const out = 'av01.0.13M.08\nhttps://example.test/v\nhttps://example.test/a\n';
    expect(parseResolvedFormat(out)).toEqual({
      videoCodec: 'av1',
      urls: ['https://example.test/v', 'https://example.test/a'],
    });
  });

  it('reads a progressive format: one URL', () => {
    expect(parseResolvedFormat('avc1.42001E\nhttps://example.test/p\n')).toEqual({
      videoCodec: 'h264',
      urls: ['https://example.test/p'],
    });
  });

  it('takes output without a codec line as URLs only', () => {
    expect(parseResolvedFormat('https://example.test/p\n')).toEqual({
      videoCodec: '',
      urls: ['https://example.test/p'],
    });
  });
});
