const axios = require('axios');
const cheerio = require('cheerio');

const TRACKERS = [
  'udp://tracker.coppersurfer.tk:6969/announce',
  'udp://tracker.opentrackr.org:1337',
  'udp://tracker.leechers-paradise.org:6969/announce',
  'udp://tracker.internetwarriors.net:1337/announce',
  'udp://9.rarbg.to:2920/announce',
  'udp://tracker.pirateparty.gr:6969/announce'
];

function buildMagnet(infoHash, name) {
  const dn = encodeURIComponent(name);
  const tr = TRACKERS.map(t => '&tr=' + encodeURIComponent(t)).join('');
  return `magnet:?xt=urn:btih:${infoHash}&dn=${dn}${tr}`;
}

function formatSize(bytes) {
  const num = parseInt(bytes);
  if (!num || isNaN(num)) return '0 B';
  if (num > 1073741824) return (num / 1073741824).toFixed(1) + ' GB';
  if (num > 1048576) return (num / 1048576).toFixed(1) + ' MB';
  return (num / 1024).toFixed(1) + ' KB';
}

class One337xScraper {
  // Scrape the 1337x.pro HTML listing
  async searchGames(query = '', page = 1) {
    try {
      let url = '';
      if (query) {
        url = `https://1337x.pro/search/${encodeURIComponent(query)}/${page}/`;
      } else {
        url = page === 1 ? 'https://1337x.pro/cat/Games/' : `https://1337x.pro/cat/Games/${page}/`;
      }

      const response = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 15000
      });

      const $ = cheerio.load(response.data);
      const games = [];

      $('table.table-list tbody tr').each((i, el) => {
        const title = $(el).find('.name a:nth-child(2)').text().trim();
        let href = $(el).find('.name a:nth-child(2)').attr('href');
        if (href && !href.startsWith('http')) href = 'https://1337x.pro' + href;

        // Size cell contains the size text + a hidden span with uploader
        // HTML: <td class="size">9.0 GB<span class="seeds">FitGirl</span></td>
        const sizeCell = $(el).find('.size').clone();
        sizeCell.find('span').remove();
        const size = sizeCell.text().trim();

        const seeds = $(el).find('.seeds').text().trim();
        const leeches = $(el).find('.leeches').text().trim();

        if (title) {
          games.push({
            title: `[1337x] ${title}`,
            url: href,
            thumbnail: null,
            magnet: null,
            source: '1337x',
            size: size || null,
            seeds: parseInt(seeds) || 0,
            peers: parseInt(leeches) || 0
          });
        }
      });
      return games;
    } catch (err) {
      console.error('1337x Search error:', err.message);
      return [];
    }
  }

  // Get magnet from the torrent detail page
  // 1337x.pro detail pages redirect to 1337x.tube which has the actual magnet
  async getMagnetLink(pageUrl) {
    if (!pageUrl) return null;
    try {
      // Try the page directly first
      const response = await axios.get(pageUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 15000,
        maxRedirects: 5
      });
      const $ = cheerio.load(response.data);
      let magnet = null;

      $('a[href^="magnet:"]').each((i, el) => {
        if (!magnet) magnet = $(el).attr('href');
      });

      if (magnet) return magnet;

      // 1337x.pro pages link to 1337x.tube for the actual download
      // Try to find a 1337x.tube link and fetch magnet from there
      let tubeUrl = null;
      $('a').each((i, el) => {
        const href = $(el).attr('href');
        if (!tubeUrl && href && href.includes('1337x.tube/torrent/')) {
          tubeUrl = href;
        }
      });

      if (tubeUrl) {
        const tubeRes = await axios.get(tubeUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
          timeout: 15000,
          maxRedirects: 5
        });
        const $tube = cheerio.load(tubeRes.data);
        $tube('a[href^="magnet:"]').each((i, el) => {
          if (!magnet) magnet = $tube(el).attr('href');
        });
      }

      return magnet;
    } catch (err) {
      console.error('1337x Magnet error:', err.message);
      return null;
    }
  }

  async getGameInfo(pageUrl) {
    return 'Game from 1337x torrent index.';
  }
}

module.exports = new One337xScraper();
