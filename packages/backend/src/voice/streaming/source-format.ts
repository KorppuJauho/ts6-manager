// Which of a site's formats yt-dlp picks for a video stream.

// Prefer a separate video+audio (DASH) pair over a combined progressive
// format: YouTube caps progressive at 720p, so asking for `best` puts a hard
// ceiling on the 1080p preset. The `+` makes yt-dlp print one URL per line,
// which the caller hands to the sidecar joined by SOURCE_SEPARATOR.
//
// dynamic_range=SDR excludes HDR formats — VP9 HDR tone-maps poorly through
// the VAAPI path and arrives washed out.
export function videoFormatFilter(maxHeight: number): string {
  return `bestvideo[height<=${maxHeight}][dynamic_range=SDR]+bestaudio/best[height<=${maxHeight}][dynamic_range=SDR]/best[height<=${maxHeight}]/best`;
}

// Among formats of equal resolution and frame rate, prefer VP9 to AV1 — even
// on a GPU that decodes AV1.
//
// yt-dlp ranks AV1 first, and YouTube offers it for many videos. Without a GPU
// that decodes it, AV1 decodes on the CPU: on the NAS a 1440p60 source took two
// of its six CPU threads. With one, it is still the slower of the two: on the
// NAS's Alder Lake GPU a 4K60 AV1 source ran the pipeline at 0.9x real time
// (the picture stuttered at 22-25 fps), where VP9 kept up at 1.15x. VP9
// decodes on VAAPI and CUDA, and costs a CPU less than AV1 does. Resolution
// and frame rate still sort first, so the preference never costs quality:
// where AV1 is the only format at the best resolution, it is picked, and the
// sidecar decodes it on the GPU if its probe passed (decoders.go).
//
// To prefer AV1 instead, see "VP9 before AV1, even on a GPU that decodes AV1"
// in docs/fork-changes.md.
export const VIDEO_FORMAT_SORT = 'res,fps,vcodec:vp9';

/** The yt-dlp arguments that select a video format up to maxHeight. */
export function videoFormatArgs(maxHeight: number): string[] {
  return ['-f', videoFormatFilter(maxHeight), '-S', VIDEO_FORMAT_SORT];
}

/** The codecs the sidecar accepts as a source's `videoCodec`. */
export type VideoCodecFamily = 'av1' | 'vp9' | 'h264' | '';

/** Map yt-dlp's or ffprobe's codec name (`av01.0.13M.08`, `vp9`, `avc1.64002a`, `h264`) to a family. */
export function videoCodecFamily(vcodec: string): VideoCodecFamily {
  const c = vcodec.trim().toLowerCase();
  if (c.startsWith('av01') || c === 'av1') return 'av1';
  if (c.startsWith('vp09') || c.startsWith('vp9')) return 'vp9';
  if (c.startsWith('avc1') || c === 'h264') return 'h264';
  return '';
}

/**
 * Split yt-dlp's `--print "%(vcodec)s" -g` output: the codec on the first line,
 * then one URL per stream (one for a progressive format, video then audio for
 * a DASH pair). A first line that is already a URL means no codec was printed.
 */
export function parseResolvedFormat(stdout: string): { urls: string[]; videoCodec: VideoCodecFamily } {
  const lines = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length > 0 && !lines[0].includes('://')) {
    return { videoCodec: videoCodecFamily(lines[0]), urls: lines.slice(1) };
  }
  return { videoCodec: '', urls: lines };
}
