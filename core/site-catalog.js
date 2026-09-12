// Velox site catalog.
//
// One entry per site the Search tab can target. Every entry carries a search
// URL so the user can always fall back to searching inside the built-in
// browser tab; entries that also name an `adapter` return real results
// (title + thumbnail + duration) straight into the Search tab.
//
// Fields:
//   id       stable key used by the renderer and by site-search.js
//   name     display name
//   domain   primary domain (used for the favicon and for URL matching)
//   cat      category id (see CATEGORIES below)
//   home     landing page, opened when a site has no usable search URL
//   s        search URL template, {q} is replaced with the encoded query
//   adapter  optional: name of a handler in site-search.js
//   prefix   optional: yt-dlp search prefix, for adapter 'ytdlp-prefix'
//   nsfw     optional: true for adult sites (hidden unless the user opts in)

const CATEGORIES = [
  { id: 'all', name: 'All sites' },
  { id: 'social', name: 'Social & short video' },
  { id: 'video', name: 'Video hosting' },
  { id: 'live', name: 'Live & gaming' },
  { id: 'music', name: 'Music & podcasts' },
  { id: 'news', name: 'News' },
  { id: 'broadcast', name: 'Public broadcasters' },
  { id: 'ott', name: 'OTT, TV & movies' },
  { id: 'edu', name: 'Education' },
  { id: 'sports', name: 'Sports' },
  { id: 'asia', name: 'Asian platforms' },
  { id: 'cloud', name: 'Cloud & creators' },
  { id: 'adult', name: 'Adult' },
  { id: 'other', name: 'Other Velox sites' },
];

const SITES = [
  // ---------- 1. Global social media & short video ----------
  { id: 'youtube', name: 'YouTube', domain: 'youtube.com', cat: 'social', home: 'https://www.youtube.com', s: 'https://www.youtube.com/results?search_query={q}', adapter: 'youtube', prefix: 'ytsearch' },
  { id: 'facebook', name: 'Facebook', domain: 'facebook.com', cat: 'social', home: 'https://www.facebook.com', s: 'https://www.facebook.com/search/videos/?q={q}' },
  { id: 'instagram', name: 'Instagram', domain: 'instagram.com', cat: 'social', home: 'https://www.instagram.com', s: 'https://www.instagram.com/explore/search/keyword/?q={q}' },
  { id: 'tiktok', name: 'TikTok', domain: 'tiktok.com', cat: 'social', home: 'https://www.tiktok.com', s: 'https://www.tiktok.com/search?q={q}' },
  { id: 'twitter', name: 'X (Twitter)', domain: 'x.com', cat: 'social', home: 'https://x.com', s: 'https://x.com/search?q={q}&f=video' },
  { id: 'reddit', name: 'Reddit', domain: 'reddit.com', cat: 'social', home: 'https://www.reddit.com', s: 'https://www.reddit.com/search/?q={q}&type=link' },
  { id: 'pinterest', name: 'Pinterest', domain: 'pinterest.com', cat: 'social', home: 'https://www.pinterest.com', s: 'https://www.pinterest.com/search/pins/?q={q}' },
  { id: 'snapchat', name: 'Snapchat', domain: 'snapchat.com', cat: 'social', home: 'https://www.snapchat.com', s: 'https://www.snapchat.com/search?q={q}' },
  { id: 'bluesky', name: 'Bluesky', domain: 'bsky.app', cat: 'social', home: 'https://bsky.app', s: 'https://bsky.app/search?q={q}' },
  { id: 'linkedin', name: 'LinkedIn', domain: 'linkedin.com', cat: 'social', home: 'https://www.linkedin.com', s: 'https://www.linkedin.com/search/results/content/?keywords={q}' },
  { id: 'tumblr', name: 'Tumblr', domain: 'tumblr.com', cat: 'social', home: 'https://www.tumblr.com', s: 'https://www.tumblr.com/search/{q}' },
  { id: 'ninegag', name: '9GAG', domain: '9gag.com', cat: 'social', home: 'https://9gag.com', s: 'https://9gag.com/search?query={q}' },
  { id: 'likee', name: 'Likee', domain: 'likee.video', cat: 'social', home: 'https://likee.video', s: 'https://likee.video/search?keyword={q}' },
  { id: 'gab', name: 'Gab', domain: 'gab.com', cat: 'social', home: 'https://gab.com', s: 'https://gab.com/search/all?q={q}' },
  { id: 'minds', name: 'Minds', domain: 'minds.com', cat: 'social', home: 'https://www.minds.com', s: 'https://www.minds.com/discovery/search?q={q}&f=videos' },
  { id: 'truthsocial', name: 'Truth Social', domain: 'truthsocial.com', cat: 'social', home: 'https://truthsocial.com', s: 'https://truthsocial.com/search?q={q}' },
  { id: 'gettr', name: 'Gettr', domain: 'gettr.com', cat: 'social', home: 'https://gettr.com', s: 'https://gettr.com/search?q={q}' },

  // ---------- 2. Video hosting & alternative platforms ----------
  { id: 'vimeo', name: 'Vimeo', domain: 'vimeo.com', cat: 'video', home: 'https://vimeo.com', s: 'https://vimeo.com/search?q={q}', adapter: 'vimeo' },
  { id: 'dailymotion', name: 'Dailymotion', domain: 'dailymotion.com', cat: 'video', home: 'https://www.dailymotion.com', s: 'https://www.dailymotion.com/search/{q}/videos', adapter: 'dailymotion' },
  { id: 'rumble', name: 'Rumble', domain: 'rumble.com', cat: 'video', home: 'https://rumble.com', s: 'https://rumble.com/search/video?q={q}' },
  { id: 'bitchute', name: 'BitChute', domain: 'bitchute.com', cat: 'video', home: 'https://www.bitchute.com', s: 'https://www.bitchute.com/search/?query={q}', adapter: 'bitchute' },
  { id: 'odysee', name: 'Odysee (LBRY)', domain: 'odysee.com', cat: 'video', home: 'https://odysee.com', s: 'https://odysee.com/$/search?q={q}', adapter: 'odysee' },
  { id: 'peertube', name: 'PeerTube', domain: 'joinpeertube.org', cat: 'video', home: 'https://joinpeertube.org', s: 'https://sepiasearch.org/search?search={q}', adapter: 'peertube' },
  { id: 'streamable', name: 'Streamable', domain: 'streamable.com', cat: 'video', home: 'https://streamable.com', s: 'https://streamable.com' },
  { id: 'vidlii', name: 'VidLii', domain: 'vidlii.com', cat: 'video', home: 'https://www.vidlii.com', s: 'https://www.vidlii.com/results?q={q}' },
  { id: 'coub', name: 'Coub', domain: 'coub.com', cat: 'video', home: 'https://coub.com', s: 'https://coub.com/search?q={q}' },
  { id: 'wistia', name: 'Wistia', domain: 'wistia.com', cat: 'video', home: 'https://wistia.com', s: 'https://wistia.com' },
  { id: 'vidyard', name: 'Vidyard', domain: 'vidyard.com', cat: 'video', home: 'https://www.vidyard.com', s: 'https://www.vidyard.com' },
  { id: 'loom', name: 'Loom', domain: 'loom.com', cat: 'video', home: 'https://www.loom.com', s: 'https://www.loom.com/looms/videos' },

  // ---------- 3. Live streaming & gaming ----------
  { id: 'twitch', name: 'Twitch', domain: 'twitch.tv', cat: 'live', home: 'https://www.twitch.tv', s: 'https://www.twitch.tv/search?term={q}' },
  { id: 'kick', name: 'Kick', domain: 'kick.com', cat: 'live', home: 'https://kick.com', s: 'https://kick.com/search?query={q}' },
  { id: 'steamcommunity', name: 'Steam Community', domain: 'steamcommunity.com', cat: 'live', home: 'https://steamcommunity.com', s: 'https://steamcommunity.com/search/?text={q}' },
  { id: 'gamejolt', name: 'GameJolt', domain: 'gamejolt.com', cat: 'live', home: 'https://gamejolt.com', s: 'https://gamejolt.com/search?q={q}' },
  { id: 'gamespot', name: 'GameSpot', domain: 'gamespot.com', cat: 'live', home: 'https://www.gamespot.com', s: 'https://www.gamespot.com/search/?q={q}' },
  { id: 'ign', name: 'IGN', domain: 'ign.com', cat: 'live', home: 'https://www.ign.com', s: 'https://www.ign.com/search?q={q}' },
  { id: 'medaltv', name: 'Medal.tv', domain: 'medal.tv', cat: 'live', home: 'https://medal.tv', s: 'https://medal.tv/search?contentQuery={q}' },
  { id: 'soop', name: 'SOOP (AfreecaTV)', domain: 'sooplive.com', cat: 'live', home: 'https://www.sooplive.com', s: 'https://www.sooplive.com/search?szKeyword={q}' },
  { id: 'chzzk', name: 'Chzzk (Naver)', domain: 'chzzk.naver.com', cat: 'live', home: 'https://chzzk.naver.com', s: 'https://chzzk.naver.com/search?query={q}' },
  { id: 'huya', name: 'Huya', domain: 'huya.com', cat: 'live', home: 'https://www.huya.com', s: 'https://www.huya.com/search?hsk={q}' },
  { id: 'douyu', name: 'Douyu', domain: 'douyu.com', cat: 'live', home: 'https://www.douyu.com', s: 'https://www.douyu.com/search/?kw={q}' },
  { id: 'twitcasting', name: 'TwitCasting', domain: 'twitcasting.tv', cat: 'live', home: 'https://twitcasting.tv', s: 'https://twitcasting.tv/searchdefault.php?word={q}' },
  { id: 'showroom', name: 'Showroom', domain: 'showroom-live.com', cat: 'live', home: 'https://www.showroom-live.com', s: 'https://www.showroom-live.com/search?keyword={q}' },
  { id: 'dlive', name: 'DLive', domain: 'dlive.tv', cat: 'live', home: 'https://dlive.tv', s: 'https://dlive.tv/s/search?q={q}' },
  { id: 'younow', name: 'YouNow', domain: 'younow.com', cat: 'live', home: 'https://www.younow.com', s: 'https://www.younow.com/search?q={q}' },

  // ---------- 4. Music, audio & podcasts ----------
  { id: 'soundcloud', name: 'SoundCloud', domain: 'soundcloud.com', cat: 'music', home: 'https://soundcloud.com', s: 'https://soundcloud.com/search?q={q}', adapter: 'soundcloud', prefix: 'scsearch' },
  { id: 'youtubemusic', name: 'YouTube Music', domain: 'music.youtube.com', cat: 'music', home: 'https://music.youtube.com', s: 'https://music.youtube.com/search?q={q}', adapter: 'youtubemusic' },
  { id: 'bandcamp', name: 'Bandcamp', domain: 'bandcamp.com', cat: 'music', home: 'https://bandcamp.com', s: 'https://bandcamp.com/search?q={q}', adapter: 'bandcamp' },
  { id: 'applepodcasts', name: 'Apple Podcasts', domain: 'podcasts.apple.com', cat: 'music', home: 'https://podcasts.apple.com', s: 'https://podcasts.apple.com/us/search?term={q}' },
  { id: 'audiomack', name: 'Audiomack', domain: 'audiomack.com', cat: 'music', home: 'https://audiomack.com', s: 'https://audiomack.com/search?q={q}' },
  { id: 'audius', name: 'Audius', domain: 'audius.co', cat: 'music', home: 'https://audius.co', s: 'https://audius.co/search/{q}' },
  { id: 'mixcloud', name: 'Mixcloud', domain: 'mixcloud.com', cat: 'music', home: 'https://www.mixcloud.com', s: 'https://www.mixcloud.com/search/?q={q}', adapter: 'mixcloud' },
  { id: 'iheart', name: 'iHeartRadio', domain: 'iheart.com', cat: 'music', home: 'https://www.iheart.com', s: 'https://www.iheart.com/search/?q={q}' },
  { id: 'tunein', name: 'TuneIn', domain: 'tunein.com', cat: 'music', home: 'https://tunein.com', s: 'https://tunein.com/search/?query={q}' },
  { id: 'podchaser', name: 'Podchaser', domain: 'podchaser.com', cat: 'music', home: 'https://www.podchaser.com', s: 'https://www.podchaser.com/search?q={q}' },
  { id: 'listennotes', name: 'Listen Notes', domain: 'listennotes.com', cat: 'music', home: 'https://www.listennotes.com', s: 'https://www.listennotes.com/search/?q={q}' },
  { id: 'spreaker', name: 'Spreaker', domain: 'spreaker.com', cat: 'music', home: 'https://www.spreaker.com', s: 'https://www.spreaker.com/search?q={q}' },
  { id: 'acast', name: 'Acast', domain: 'acast.com', cat: 'music', home: 'https://www.acast.com', s: 'https://www.acast.com/search?q={q}' },
  { id: 'freesound', name: 'FreeSound', domain: 'freesound.org', cat: 'music', home: 'https://freesound.org', s: 'https://freesound.org/search/?q={q}' },
  { id: 'vocaroo', name: 'Vocaroo', domain: 'vocaroo.com', cat: 'music', home: 'https://vocaroo.com', s: 'https://vocaroo.com' },
  { id: 'beatport', name: 'Beatport', domain: 'beatport.com', cat: 'music', home: 'https://www.beatport.com', s: 'https://www.beatport.com/search?q={q}' },
  { id: 'jiosaavn', name: 'JioSaavn', domain: 'jiosaavn.com', cat: 'music', home: 'https://www.jiosaavn.com', s: 'https://www.jiosaavn.com/search/{q}' },
  { id: 'qqmusic', name: 'QQ Music', domain: 'y.qq.com', cat: 'music', home: 'https://y.qq.com', s: 'https://y.qq.com/n/ryqq/search?w={q}' },
  { id: 'netease', name: 'NetEase Cloud Music', domain: 'music.163.com', cat: 'music', home: 'https://music.163.com', s: 'https://music.163.com/#/search/m/?s={q}' },
  { id: 'zingmp3', name: 'Zing MP3', domain: 'zingmp3.vn', cat: 'music', home: 'https://zingmp3.vn', s: 'https://zingmp3.vn/tim-kiem/tat-ca?q={q}' },
  { id: 'yandexmusic', name: 'Yandex Music', domain: 'music.yandex.ru', cat: 'music', home: 'https://music.yandex.ru', s: 'https://music.yandex.ru/search?text={q}' },

  // ---------- 5. News & journalism ----------
  { id: 'bbc', name: 'BBC', domain: 'bbc.com', cat: 'news', home: 'https://www.bbc.com', s: 'https://www.bbc.co.uk/search?q={q}' },
  { id: 'cnn', name: 'CNN', domain: 'cnn.com', cat: 'news', home: 'https://www.cnn.com', s: 'https://edition.cnn.com/search?q={q}' },
  { id: 'aljazeera', name: 'Al Jazeera', domain: 'aljazeera.com', cat: 'news', home: 'https://www.aljazeera.com', s: 'https://www.aljazeera.com/search/{q}' },
  { id: 'bloomberg', name: 'Bloomberg', domain: 'bloomberg.com', cat: 'news', home: 'https://www.bloomberg.com', s: 'https://www.bloomberg.com/search?query={q}' },
  { id: 'nytimes', name: 'The New York Times', domain: 'nytimes.com', cat: 'news', home: 'https://www.nytimes.com', s: 'https://www.nytimes.com/search?query={q}' },
  { id: 'wsj', name: 'The Wall Street Journal', domain: 'wsj.com', cat: 'news', home: 'https://www.wsj.com', s: 'https://www.wsj.com/search?query={q}' },
  { id: 'washingtonpost', name: 'The Washington Post', domain: 'washingtonpost.com', cat: 'news', home: 'https://www.washingtonpost.com', s: 'https://www.washingtonpost.com/search/?query={q}' },
  { id: 'abcnews', name: 'ABC News (US)', domain: 'abcnews.go.com', cat: 'news', home: 'https://abcnews.go.com', s: 'https://abcnews.go.com/search?searchtext={q}' },
  { id: 'cbsnews', name: 'CBS News', domain: 'cbsnews.com', cat: 'news', home: 'https://www.cbsnews.com', s: 'https://www.cbsnews.com/search/?q={q}' },
  { id: 'nbcnews', name: 'NBC News', domain: 'nbcnews.com', cat: 'news', home: 'https://www.nbcnews.com', s: 'https://www.nbcnews.com/search/?q={q}' },
  { id: 'foxnews', name: 'FOX News', domain: 'foxnews.com', cat: 'news', home: 'https://www.foxnews.com', s: 'https://www.foxnews.com/search-results/search?q={q}' },
  { id: 'msn', name: 'MSN', domain: 'msn.com', cat: 'news', home: 'https://www.msn.com', s: 'https://www.msn.com/en-us/search?q={q}' },
  { id: 'yahoonews', name: 'Yahoo News', domain: 'news.yahoo.com', cat: 'news', home: 'https://news.yahoo.com', s: 'https://news.yahoo.com/search?p={q}' },
  { id: 'skynews', name: 'Sky News', domain: 'news.sky.com', cat: 'news', home: 'https://news.sky.com', s: 'https://news.sky.com/search?q={q}' },
  { id: 'guardian', name: 'The Guardian', domain: 'theguardian.com', cat: 'news', home: 'https://www.theguardian.com/podcasts', s: 'https://www.theguardian.com/search?q={q}' },
  { id: 'francetvinfo', name: 'Franceinfo', domain: 'francetvinfo.fr', cat: 'news', home: 'https://www.francetvinfo.fr', s: 'https://www.francetvinfo.fr/recherche?query={q}' },
  { id: 'spiegel', name: 'Spiegel', domain: 'spiegel.de', cat: 'news', home: 'https://www.spiegel.de', s: 'https://www.spiegel.de/suche/?suchbegriff={q}' },
  { id: 'elpais', name: 'El Pais', domain: 'elpais.com', cat: 'news', home: 'https://elpais.com', s: 'https://elpais.com/buscador/?q={q}' },

  // ---------- 6. Public & national broadcasters ----------
  { id: 'abciview', name: 'ABC iview (AU)', domain: 'iview.abc.net.au', cat: 'broadcast', home: 'https://iview.abc.net.au', s: 'https://iview.abc.net.au/search?q={q}' },
  { id: 'sbs', name: 'SBS (AU)', domain: 'sbs.com.au', cat: 'broadcast', home: 'https://www.sbs.com.au', s: 'https://www.sbs.com.au/search?q={q}' },
  { id: 'cbcgem', name: 'CBC Gem (CA)', domain: 'gem.cbc.ca', cat: 'broadcast', home: 'https://gem.cbc.ca', s: 'https://gem.cbc.ca/search?q={q}' },
  { id: 'pbs', name: 'PBS (US)', domain: 'pbs.org', cat: 'broadcast', home: 'https://www.pbs.org', s: 'https://www.pbs.org/search/?q={q}' },
  { id: 'cspan', name: 'C-SPAN (US)', domain: 'c-span.org', cat: 'broadcast', home: 'https://www.c-span.org', s: 'https://www.c-span.org/search/?query={q}' },
  { id: 'ardmediathek', name: 'ARD Mediathek (DE)', domain: 'ardmediathek.de', cat: 'broadcast', home: 'https://www.ardmediathek.de', s: 'https://www.ardmediathek.de/suche/{q}' },
  { id: 'zdf', name: 'ZDF (DE)', domain: 'zdf.de', cat: 'broadcast', home: 'https://www.zdf.de', s: 'https://www.zdf.de/suche?q={q}' },
  { id: 'arte', name: 'Arte', domain: 'arte.tv', cat: 'broadcast', home: 'https://www.arte.tv', s: 'https://www.arte.tv/en/search/?q={q}' },
  { id: 'francetv', name: 'France TV', domain: 'france.tv', cat: 'broadcast', home: 'https://www.france.tv', s: 'https://www.france.tv/recherche/?request={q}' },
  { id: 'raiplay', name: 'RAI Play (IT)', domain: 'raiplay.it', cat: 'broadcast', home: 'https://www.raiplay.it', s: 'https://www.raiplay.it/ricerca.html?q={q}' },
  { id: 'rtve', name: 'RTVE Play (ES)', domain: 'rtve.es', cat: 'broadcast', home: 'https://www.rtve.es/play', s: 'https://www.rtve.es/buscador/?q={q}' },
  { id: 'nrktv', name: 'NRK TV (NO)', domain: 'tv.nrk.no', cat: 'broadcast', home: 'https://tv.nrk.no', s: 'https://tv.nrk.no/sok?q={q}' },
  { id: 'svtplay', name: 'SVT Play (SE)', domain: 'svtplay.se', cat: 'broadcast', home: 'https://www.svtplay.se', s: 'https://www.svtplay.se/sok?q={q}' },
  { id: 'nhk', name: 'NHK (JP)', domain: 'nhk.or.jp', cat: 'broadcast', home: 'https://www.nhk.or.jp', s: 'https://www.nhk.or.jp/search/?q={q}' },
  { id: 'ceskatelevize', name: 'Ceska televize (CZ)', domain: 'ceskatelevize.cz', cat: 'broadcast', home: 'https://www.ceskatelevize.cz', s: 'https://www.ceskatelevize.cz/hledani/?q={q}' },
  { id: 'tvpvod', name: 'TVP VOD (PL)', domain: 'vod.tvp.pl', cat: 'broadcast', home: 'https://vod.tvp.pl', s: 'https://vod.tvp.pl/szukaj?query={q}' },

  // ---------- 7. OTT, TV & movies ----------
  { id: 'netflix', name: 'Netflix', domain: 'netflix.com', cat: 'ott', home: 'https://www.netflix.com', s: 'https://www.netflix.com/search?q={q}' },
  { id: 'tubi', name: 'Tubi TV', domain: 'tubitv.com', cat: 'ott', home: 'https://tubitv.com', s: 'https://tubitv.com/search/{q}' },
  { id: 'hotstar', name: 'JioHotstar', domain: 'hotstar.com', cat: 'ott', home: 'https://www.hotstar.com', s: 'https://www.hotstar.com/in/explore?search_query={q}' },
  { id: 'sonyliv', name: 'SonyLIV', domain: 'sonyliv.com', cat: 'ott', home: 'https://www.sonyliv.com', s: 'https://www.sonyliv.com/search?searchTerm={q}' },
  { id: 'mxplayer', name: 'Amazon MX Player', domain: 'mxplayer.in', cat: 'ott', home: 'https://www.mxplayer.in', s: 'https://www.mxplayer.in/search?q={q}' },
  { id: 'viu', name: 'Viu', domain: 'viu.com', cat: 'ott', home: 'https://www.viu.com', s: 'https://www.viu.com/ott/sg/en/search?q={q}' },
  { id: 'curiositystream', name: 'CuriosityStream', domain: 'curiositystream.com', cat: 'ott', home: 'https://curiositystream.com', s: 'https://curiositystream.com/search?q={q}' },
  { id: 'dropout', name: 'Dropout', domain: 'dropout.tv', cat: 'ott', home: 'https://www.dropout.tv', s: 'https://www.dropout.tv/search?q={q}' },
  { id: 'discoveryplus', name: 'Discovery+', domain: 'discoveryplus.com', cat: 'ott', home: 'https://www.discoveryplus.com', s: 'https://www.discoveryplus.com/search?q={q}' },
  { id: 'canalplus', name: 'Canal+ (myCANAL)', domain: 'canalplus.com', cat: 'ott', home: 'https://www.canalplus.com', s: 'https://www.canalplus.com/recherche/?q={q}' },
  { id: 'shahid', name: 'Shahid', domain: 'shahid.mbc.net', cat: 'ott', home: 'https://shahid.mbc.net', s: 'https://shahid.mbc.net/en/search?q={q}' },
  { id: 'tf1', name: 'TF1+', domain: 'tf1.fr', cat: 'ott', home: 'https://www.tf1.fr', s: 'https://www.tf1.fr/recherche?q={q}' },
  { id: 'itvx', name: 'ITVX', domain: 'itv.com', cat: 'ott', home: 'https://www.itv.com', s: 'https://www.itv.com/search?query={q}' },
  { id: 'sevenplus', name: '7plus (AU)', domain: '7plus.com.au', cat: 'ott', home: 'https://7plus.com.au', s: 'https://7plus.com.au/search?q={q}' },
  { id: 'ninenow', name: '9Now (AU)', domain: '9now.com.au', cat: 'ott', home: 'https://www.9now.com.au', s: 'https://www.9now.com.au/search?q={q}' },
  { id: 'tenplay', name: '10play (AU)', domain: '10play.com.au', cat: 'ott', home: 'https://10play.com.au', s: 'https://10play.com.au/search?q={q}' },

  // ---------- 8. Education, courses & tech talks ----------
  { id: 'khanacademy', name: 'Khan Academy', domain: 'khanacademy.org', cat: 'edu', home: 'https://www.khanacademy.org', s: 'https://www.khanacademy.org/search?page_search_query={q}' },
  { id: 'mitocw', name: 'MIT OpenCourseWare', domain: 'ocw.mit.edu', cat: 'edu', home: 'https://ocw.mit.edu', s: 'https://ocw.mit.edu/search/?q={q}' },
  { id: 'ted', name: 'TED Talks', domain: 'ted.com', cat: 'edu', home: 'https://www.ted.com', s: 'https://www.ted.com/search?q={q}', adapter: 'ted' },
  { id: 'frontendmasters', name: 'Frontend Masters', domain: 'frontendmasters.com', cat: 'edu', home: 'https://frontendmasters.com', s: 'https://frontendmasters.com/search/?q={q}' },
  { id: 'laracasts', name: 'Laracasts', domain: 'laracasts.com', cat: 'edu', home: 'https://laracasts.com', s: 'https://laracasts.com/search?q={q}' },
  { id: 'linkedinlearning', name: 'LinkedIn Learning', domain: 'linkedin.com', cat: 'edu', home: 'https://www.linkedin.com/learning', s: 'https://www.linkedin.com/learning/search?keywords={q}' },
  { id: 'microsoftlearn', name: 'Microsoft Learn', domain: 'learn.microsoft.com', cat: 'edu', home: 'https://learn.microsoft.com', s: 'https://learn.microsoft.com/en-us/search/?terms={q}' },
  { id: 'infoq', name: 'InfoQ', domain: 'infoq.com', cat: 'edu', home: 'https://www.infoq.com', s: 'https://www.infoq.com/search.action?queryString={q}' },
  { id: 'mediaccc', name: 'media.ccc.de', domain: 'media.ccc.de', cat: 'edu', home: 'https://media.ccc.de', s: 'https://media.ccc.de/search?q={q}' },
  { id: 'platzi', name: 'Platzi', domain: 'platzi.com', cat: 'edu', home: 'https://platzi.com', s: 'https://platzi.com/buscar/?search={q}' },
  { id: 'alura', name: 'Alura', domain: 'alura.com.br', cat: 'edu', home: 'https://www.alura.com.br', s: 'https://www.alura.com.br/busca?query={q}' },
  { id: 'lecturio', name: 'Lecturio', domain: 'lecturio.com', cat: 'edu', home: 'https://www.lecturio.com', s: 'https://www.lecturio.com/search?q={q}' },
  { id: 'packt', name: 'Packt', domain: 'packtpub.com', cat: 'edu', home: 'https://www.packtpub.com', s: 'https://www.packtpub.com/en-us/search?q={q}' },

  // ---------- 9. Sports ----------
  { id: 'espn', name: 'ESPN', domain: 'espn.com', cat: 'sports', home: 'https://www.espn.com', s: 'https://www.espn.com/search/_/q/{q}' },
  { id: 'formula1', name: 'Formula 1', domain: 'formula1.com', cat: 'sports', home: 'https://www.formula1.com', s: 'https://www.formula1.com/en/search.html?q={q}' },
  { id: 'fifaplus', name: 'FIFA+', domain: 'plus.fifa.com', cat: 'sports', home: 'https://www.plus.fifa.com', s: 'https://www.plus.fifa.com/en/search?q={q}' },
  { id: 'nfl', name: 'NFL', domain: 'nfl.com', cat: 'sports', home: 'https://www.nfl.com', s: 'https://www.nfl.com/search?query={q}' },
  { id: 'mlb', name: 'MLB', domain: 'mlb.com', cat: 'sports', home: 'https://www.mlb.com', s: 'https://www.mlb.com/video/search?q={q}' },
  { id: 'redbulltv', name: 'Red Bull TV', domain: 'redbull.com', cat: 'sports', home: 'https://www.redbull.com/tv', s: 'https://www.redbull.com/int-en/search?q={q}' },
  { id: 'eurosport', name: 'Eurosport', domain: 'eurosport.com', cat: 'sports', home: 'https://www.eurosport.com', s: 'https://www.eurosport.com/search.shtml?q={q}' },
  { id: 'pgatour', name: 'PGA Tour', domain: 'pgatour.com', cat: 'sports', home: 'https://www.pgatour.com', s: 'https://www.pgatour.com/search?q={q}' },
  { id: 'onefootball', name: 'OneFootball', domain: 'onefootball.com', cat: 'sports', home: 'https://onefootball.com', s: 'https://onefootball.com/en/search?q={q}' },
  { id: 'tennistv', name: 'Tennis TV', domain: 'tennistv.com', cat: 'sports', home: 'https://www.tennistv.com', s: 'https://www.tennistv.com/search?q={q}' },

  // ---------- 10. East & Southeast Asian media ----------
  { id: 'bilibili', name: 'Bilibili', domain: 'bilibili.com', cat: 'asia', home: 'https://www.bilibili.com', s: 'https://search.bilibili.com/all?keyword={q}', adapter: 'bilibili' },
  { id: 'youku', name: 'Youku', domain: 'youku.com', cat: 'asia', home: 'https://www.youku.com', s: 'https://so.youku.com/search_video/q_{q}' },
  { id: 'iqiyi', name: 'iQIYI', domain: 'iq.com', cat: 'asia', home: 'https://www.iq.com', s: 'https://www.iq.com/search?query={q}' },
  { id: 'wetv', name: 'WeTV / Tencent Video', domain: 'wetv.vip', cat: 'asia', home: 'https://wetv.vip', s: 'https://wetv.vip/en/search?q={q}' },
  { id: 'weibo', name: 'Weibo', domain: 'weibo.com', cat: 'asia', home: 'https://weibo.com', s: 'https://s.weibo.com/video?q={q}' },
  { id: 'xiaohongshu', name: 'Xiaohongshu (RED)', domain: 'xiaohongshu.com', cat: 'asia', home: 'https://www.xiaohongshu.com', s: 'https://www.xiaohongshu.com/search_result?keyword={q}' },
  { id: 'niconico', name: 'Niconico', domain: 'nicovideo.jp', cat: 'asia', home: 'https://www.nicovideo.jp', s: 'https://www.nicovideo.jp/search/{q}', adapter: 'niconico' },
  { id: 'abema', name: 'AbemaTV', domain: 'abema.tv', cat: 'asia', home: 'https://abema.tv', s: 'https://abema.tv/search?q={q}' },
  { id: 'tver', name: 'TVer', domain: 'tver.jp', cat: 'asia', home: 'https://tver.jp', s: 'https://tver.jp/search/{q}' },
  { id: 'naver', name: 'Naver', domain: 'naver.com', cat: 'asia', home: 'https://www.naver.com', s: 'https://search.naver.com/search.naver?query={q}' },
  { id: 'weverse', name: 'Weverse', domain: 'weverse.io', cat: 'asia', home: 'https://weverse.io', s: 'https://weverse.io/search?keyword={q}' },
  { id: 'vidio', name: 'Vidio', domain: 'vidio.com', cat: 'asia', home: 'https://www.vidio.com', s: 'https://www.vidio.com/search?q={q}' },
  { id: 'fptplay', name: 'FPT Play', domain: 'fptplay.vn', cat: 'asia', home: 'https://fptplay.vn', s: 'https://fptplay.vn/tim-kiem?q={q}' },

  // ---------- 11. Cloud storage, file hosting & creators ----------
  { id: 'googledrive', name: 'Google Drive', domain: 'drive.google.com', cat: 'cloud', home: 'https://drive.google.com', s: 'https://drive.google.com/drive/search?q={q}' },
  { id: 'dropbox', name: 'Dropbox', domain: 'dropbox.com', cat: 'cloud', home: 'https://www.dropbox.com', s: 'https://www.dropbox.com/search?query={q}' },
  { id: 'box', name: 'Box', domain: 'box.com', cat: 'cloud', home: 'https://www.box.com', s: 'https://app.box.com/search?query={q}' },
  { id: 'archive', name: 'Internet Archive', domain: 'archive.org', cat: 'cloud', home: 'https://archive.org', s: 'https://archive.org/search?query={q}', adapter: 'archive' },
  { id: 'imgur', name: 'Imgur', domain: 'imgur.com', cat: 'cloud', home: 'https://imgur.com', s: 'https://imgur.com/search?q={q}' },
  { id: 'patreon', name: 'Patreon', domain: 'patreon.com', cat: 'cloud', home: 'https://www.patreon.com', s: 'https://www.patreon.com/search?q={q}' },
  { id: 'substack', name: 'Substack', domain: 'substack.com', cat: 'cloud', home: 'https://substack.com', s: 'https://substack.com/search/{q}' },
  { id: 'kickstarter', name: 'Kickstarter', domain: 'kickstarter.com', cat: 'cloud', home: 'https://www.kickstarter.com', s: 'https://www.kickstarter.com/discover/advanced?term={q}' },
  { id: 'flickr', name: 'Flickr', domain: 'flickr.com', cat: 'cloud', home: 'https://www.flickr.com', s: 'https://www.flickr.com/search/?text={q}' },
  { id: 'newgrounds', name: 'Newgrounds', domain: 'newgrounds.com', cat: 'cloud', home: 'https://www.newgrounds.com', s: 'https://www.newgrounds.com/search/conduct/movies?terms={q}' },
  { id: 'yandexdisk', name: 'Yandex Disk', domain: 'disk.yandex.com', cat: 'cloud', home: 'https://disk.yandex.com', s: 'https://disk.yandex.com' },

  // ---------- Adult ----------
  { id: 'pornhub', name: 'Pornhub', domain: 'pornhub.com', cat: 'adult', nsfw: true, home: 'https://www.pornhub.com', s: 'https://www.pornhub.com/video/search?search={q}', adapter: 'pornhub' },
  { id: 'xvideos', name: 'XVideos', domain: 'xvideos.com', cat: 'adult', nsfw: true, home: 'https://www.xvideos.com', s: 'https://www.xvideos.com/?k={q}', adapter: 'xvideos' },
  { id: 'xnxx', name: 'XNXX', domain: 'xnxx.com', cat: 'adult', nsfw: true, home: 'https://www.xnxx.com', s: 'https://www.xnxx.com/search/{q}', adapter: 'xnxx' },
  { id: 'xhamster', name: 'xHamster', domain: 'xhamster.com', cat: 'adult', nsfw: true, home: 'https://xhamster.com', s: 'https://xhamster.com/search/{q}', adapter: 'xhamster' },
  { id: 'eporner', name: 'Eporner', domain: 'eporner.com', cat: 'adult', nsfw: true, home: 'https://www.eporner.com', s: 'https://www.eporner.com/search/{q}/', adapter: 'eporner' },
  { id: 'youporn', name: 'YouPorn', domain: 'youporn.com', cat: 'adult', nsfw: true, home: 'https://www.youporn.com', s: 'https://www.youporn.com/search/?query={q}' },
  { id: 'redtube', name: 'RedTube', domain: 'redtube.com', cat: 'adult', nsfw: true, home: 'https://www.redtube.com', s: 'https://www.redtube.com/?search={q}' },
  { id: 'spankbang', name: 'SpankBang', domain: 'spankbang.com', cat: 'adult', nsfw: true, home: 'https://spankbang.com', s: 'https://spankbang.com/s/{q}/' },
  { id: 'tube8', name: 'Tube8', domain: 'tube8.com', cat: 'adult', nsfw: true, home: 'https://www.tube8.com', s: 'https://www.tube8.com/searches/{q}/' },
  { id: 'youjizz', name: 'YouJizz', domain: 'youjizz.com', cat: 'adult', nsfw: true, home: 'https://www.youjizz.com', s: 'https://www.youjizz.com/search/{q}-1.html' },
  { id: 'redgifs', name: 'RedGIFs', domain: 'redgifs.com', cat: 'adult', nsfw: true, home: 'https://www.redgifs.com', s: 'https://www.redgifs.com/search?query={q}' },
];

const BY_ID = new Map(SITES.map((s) => [s.id, s]));

function getSite(id) {
  return BY_ID.get(String(id || '').toLowerCase()) || null;
}

// Build the search URL for a site, or its home page when it has no search page.
function searchUrlFor(site, query) {
  if (!site) return '';
  const tpl = site.s || site.home || '';
  if (!tpl.includes('{q}')) return tpl;
  return tpl.replace('{q}', encodeURIComponent(String(query || '')));
}

module.exports = { CATEGORIES, SITES, getSite, searchUrlFor };
