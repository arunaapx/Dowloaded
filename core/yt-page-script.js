// The script run inside a signed-in youtube.com page to read a video's streams.
//
// It is a string rather than a file because it is handed to
// webContents.executeJavaScript, which evaluates source in the page.
//
// Why ask the page at all: YouTube's web client now answers with SABR (a POST
// to /videoplayback carrying protobuf, no itag, no plain URL), and it refuses
// some videos outright to anonymous requests. Asking its own InnerTube endpoint
// from inside the page, as a mobile client, gives back ordinary https URLs and
// carries the user's sign-in with it. Measured on a video that nine yt-dlp
// clients could not touch: ANDROID returned 35 formats up to 2160p.
//
// ANDROID is tried before IOS because IOS caps at 1080p.
const CLIENTS = [
  ['ANDROID', { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 34 }],
  ['IOS', { clientName: 'IOS', clientVersion: '20.03.02', deviceModel: 'iPhone16,2' }],
];

function build(videoId) {
  return `(async () => {
    const clients = ${JSON.stringify(CLIENTS)};
    const cfg = (window.ytcfg && window.ytcfg.data_) || {};
    const key = cfg.INNERTUBE_API_KEY;
    const base = cfg.INNERTUBE_CONTEXT;
    if (!key || !base) return { ok: false, error: 'youtube-page-not-ready' };

    let lastReason = null;
    for (const [name, patch] of clients) {
      try {
        const ctx = JSON.parse(JSON.stringify(base));
        Object.assign(ctx.client, patch);
        const res = await fetch('/youtubei/v1/player?key=' + encodeURIComponent(key), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            videoId: ${JSON.stringify(videoId)},
            context: ctx,
            contentCheckOk: true,
            racyCheckOk: true,
          }),
          credentials: 'include',
        });
        const json = await res.json();
        const status = (json.playabilityStatus || {}).status;
        if (status !== 'OK') { lastReason = (json.playabilityStatus || {}).reason || status; continue; }

        const sd = json.streamingData || {};
        const all = (sd.adaptiveFormats || []).concat(sd.formats || []);
        // Anything still hidden behind signatureCipher would need the player's
        // own crypto; those are dropped rather than half-handled.
        const formats = all.filter((f) => !!f.url).map((f) => ({
          itag: f.itag,
          url: f.url,
          mimeType: f.mimeType || '',
          height: f.height || 0,
          width: f.width || 0,
          fps: f.fps || 0,
          bitrate: f.bitrate || 0,
          contentLength: f.contentLength || '',
          qualityLabel: f.qualityLabel || '',
          audioChannels: f.audioChannels || 0,
        }));
        if (!formats.length) { lastReason = 'no-plain-urls'; continue; }

        const vd = json.videoDetails || {};
        return {
          ok: true,
          client: name,
          videoId: vd.videoId || ${JSON.stringify(videoId)},
          title: vd.title || '',
          author: vd.author || '',
          durationSeconds: Number(vd.lengthSeconds) || 0,
          formats,
        };
      } catch (e) {
        lastReason = String((e && e.message) || e).slice(0, 120);
      }
    }
    return { ok: false, error: lastReason || 'no-client-succeeded' };
  })()`;
}

// Pick the streams for a requested quality. Video and audio come separately
// above 720p, so the caller usually gets two URLs to merge.
function choose(formats, opts = {}) {
  const wantAudioOnly = opts.mode === 'audio';
  const cap = {
    best: null, '4k': 2160, '1440p': 1440, '1080p': 1080,
    '720p': 720, '480p': 480, '360p': 360,
  }[opts.quality];

  const audios = formats
    .filter((f) => /audio\//.test(f.mimeType) || (!f.height && f.audioChannels))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  // Prefer mp4/avc1 at equal height so the merge is a remux, not a re-encode.
  const byBest = (a, b) => (b.height - a.height)
    || (/avc1/.test(b.mimeType) ? 1 : 0) - (/avc1/.test(a.mimeType) ? 1 : 0)
    || (b.bitrate || 0) - (a.bitrate || 0);

  const allVideos = formats
    .filter((f) => /video\//.test(f.mimeType) && f.height)
    .sort(byBest);
  let videos = cap ? allVideos.filter((f) => f.height <= cap) : allVideos;
  // Asking for 480p when the video only exists at 720p and above should give
  // the smallest copy there is, not nothing at all.
  if (!videos.length && allVideos.length) videos = [allVideos[allVideos.length - 1]];

  if (wantAudioOnly) {
    if (!audios.length) return null;
    return { video: audios[0], audio: null };
  }
  if (!videos.length) return null;
  return { video: videos[0], audio: audios[0] || null };
}

module.exports = { build, choose };
