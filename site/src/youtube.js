// The video id out of whatever YouTube link someone pastes into the admin
// panel.
//
// Nobody copies a canonical URL. They copy what the browser had, what the
// Share button gave them, or what the embed dialog produced — and a help guide
// that silently shows no video because the link had "&t=42s" on the end is a
// guide nobody notices is broken.
//
// It lives in its own file, away from the JSX, so the forms below can be
// checked without building the site.

const PATTERNS = [
  /[?&]v=([A-Za-z0-9_-]{11})/,        // watch?v=ID, with anything after it
  /youtu\.be\/([A-Za-z0-9_-]{11})/,   // the Share button's short link
  /\/embed\/([A-Za-z0-9_-]{11})/,     // what the embed dialog hands out
  /\/shorts\/([A-Za-z0-9_-]{11})/,    // a short
  /\/live\/([A-Za-z0-9_-]{11})/,      // a stream
];

export function youtubeId(url) {
  const text = String(url == null ? '' : url).trim();
  if (!text) return '';
  for (const pattern of PATTERNS) {
    const hit = text.match(pattern);
    if (hit) return hit[1];
  }
  // Someone may paste the id on its own, which is 11 characters of exactly
  // this alphabet and nothing else.
  return /^[A-Za-z0-9_-]{11}$/.test(text) ? text : '';
}

// The picture YouTube already has for a video, so a guide looks finished
// without anyone making artwork for it.
export function youtubeThumb(id) {
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : '';
}

// nocookie: a customer reading a help page should not be tracked for it.
export function youtubeEmbed(id) {
  return id ? `https://www.youtube-nocookie.com/embed/${id}?rel=0` : '';
}
