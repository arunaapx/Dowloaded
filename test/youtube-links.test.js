// Every shape of YouTube link an admin might paste into a help guide.
//
// Nobody copies a canonical URL: they copy the address bar, the Share button,
// the embed dialog, or a short — often with a timestamp or a playlist stuck on
// the end. A link the parser does not recognise shows a guide with no video and
// no error, which is the kind of broken nobody reports.
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

let failures = 0;
const check = (ok, msg, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  [' + extra + ']' : ''}`);
  if (!ok) failures++;
};

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'site', 'src', 'youtube.js')).href);
  const { youtubeId, youtubeThumb, youtubeEmbed } = mod;

  const ID = 'dQw4w9WgXcQ';
  const forms = {
    'a watch URL': `https://www.youtube.com/watch?v=${ID}`,
    'a watch URL with a timestamp': `https://www.youtube.com/watch?v=${ID}&t=42s`,
    'a watch URL inside a playlist': `https://www.youtube.com/watch?v=${ID}&list=PLabc123&index=4`,
    'the Share button short link': `https://youtu.be/${ID}`,
    'a short link with a timestamp': `https://youtu.be/${ID}?t=90`,
    'the embed dialog': `https://www.youtube.com/embed/${ID}`,
    'a short': `https://www.youtube.com/shorts/${ID}`,
    'a live stream': `https://www.youtube.com/live/${ID}`,
    'no scheme, as typed': `youtube.com/watch?v=${ID}`,
    'the mobile site': `https://m.youtube.com/watch?v=${ID}`,
    'the id on its own': ID,
    'with spaces around it': `  https://youtu.be/${ID}  `,
  };

  for (const [name, url] of Object.entries(forms)) {
    check(youtubeId(url) === ID, `reads the id from ${name}`, youtubeId(url) || 'nothing');
  }

  // Things that are not a video must not become one: a guide with an image and
  // no video should show the image.
  for (const [name, value] of Object.entries({
    'an empty box': '',
    'only spaces': '   ',
    'nothing at all': null,
    'a channel page': 'https://www.youtube.com/@somechannel',
    'a plain website': 'https://example.com/help',
    'a sentence': 'see the video on our channel',
    'an image url': 'https://example.com/pictures/guide.png',
  })) {
    check(youtubeId(value) === '', `finds no video in ${name}`, JSON.stringify(youtubeId(value)));
  }

  // An id is 11 characters; a shorter or longer run must not be mistaken for one.
  check(youtubeId('https://youtu.be/tooshort') === '', 'refuses a short id');
  check(youtubeId('abcdefghij') === '', 'refuses ten characters on their own');

  check(youtubeThumb(ID) === `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`,
    'a video brings its own thumbnail, so a guide needs no artwork');
  check(youtubeThumb('') === '', 'and no video means no thumbnail');

  check(youtubeEmbed(ID).startsWith('https://www.youtube-nocookie.com/embed/'),
    'the player is the no-cookie one — reading a help page should not be tracked',
    youtubeEmbed(ID));
  check(youtubeEmbed(ID).includes('rel=0'), 'and it does not offer other channels afterwards');

  console.log(`\n${failures ? failures + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED'}`);
  process.exitCode = failures ? 1 : 0;
})().catch((e) => {
  console.error('TEST CRASHED:', e.message);
  process.exitCode = 2;
});
