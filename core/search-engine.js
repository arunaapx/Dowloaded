const TorrentSearchApi = require('torrent-search-api');
// yt-dlp search is handled by the existing download manager / yt-dlp wrapper, 
// so we will export a unified search interface.

class SearchEngine {
  constructor() {
    TorrentSearchApi.enablePublicProviders();
  }

  async searchTorrents(query, limit = 20) {
    try {
      const torrents = await TorrentSearchApi.search(query, 'Games', limit);
      return torrents.map(t => ({
        title: t.title,
        time: t.time,
        seeds: t.seeds,
        peers: t.peers,
        size: t.size,
        magnet: t.magnet, // requires getMagnet in some providers
        provider: t.provider,
        url: t.desc
      }));
    } catch (err) {
      console.error('Torrent search error:', err);
      return [];
    }
  }

  async getMagnet(torrent) {
    if (torrent.magnet) return torrent.magnet;
    try {
      return await TorrentSearchApi.getMagnet(torrent);
    } catch (err) {
      console.error('Failed to get magnet:', err);
      return '';
    }
  }
}

module.exports = new SearchEngine();
