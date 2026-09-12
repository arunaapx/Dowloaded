const TorrentSearchApi = require('torrent-search-api');

class SoftwareScraper {
  constructor() {
    TorrentSearchApi.enableProvider('1337x');
    TorrentSearchApi.enableProvider('ThePirateBay');
  }

  async searchSoftware(query) {
    try {
      // 1337x category for apps/software
      const torrents = await TorrentSearchApi.search(query, 'Apps', 25);
      return torrents.map(t => ({
        title: t.title,
        time: t.time,
        seeds: t.seeds,
        peers: t.peers,
        size: t.size,
        magnet: t.magnet,
        provider: t.provider,
        url: t.desc
      }));
    } catch (err) {
      console.error('Software search error:', err);
      return [];
    }
  }

  async fetchLatest() {
    return await this.searchSoftware('2025'); // Hacky way to get recent softwares
  }
}

module.exports = new SoftwareScraper();
