const axios = require('axios');
const cheerio = require('cheerio');

class FitGirlScraper {
  constructor() {
    this.baseUrl = 'https://fitgirl-repacks.site/';
    this.cache = [];
    this.lastFetch = 0;
  }

  async fetchLatest(force = false) {
    // Cache for 12 hours
    if (!force && this.cache.length > 0 && (Date.now() - this.lastFetch < 12 * 60 * 60 * 1000)) {
      return this.cache;
    }

    try {
      const response = await axios.get(this.baseUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      const $ = cheerio.load(response.data);
      const results = [];

      $('article.category-lossless-repack').each((i, el) => {
        const titleElement = $(el).find('h1.entry-title a');
        const title = titleElement.text().trim();
        const url = titleElement.attr('href');
        
        // Find thumbnail
        const img = $(el).find('.entry-content img').first();
        let thumbnail = img.attr('data-lazy-src') || img.attr('data-src') || img.attr('src');
        if (thumbnail && !thumbnail.startsWith('http')) {
          thumbnail = 'https://fitgirl-repacks.site' + (thumbnail.startsWith('/') ? '' : '/') + thumbnail;
        }

        // Find magnet links (1337x or RuTor usually, or raw magnet)
        // Note: Full scraping might require visiting the individual page, 
        // but often there are magnet links or links to torrent trackers in the entry-content.
        const magnetLink = $(el).find('a[href^="magnet:"]').first().attr('href') || '';

        if (title) {
          results.push({
            title,
            url,
            thumbnail,
            magnet: magnetLink
          });
        }
      });

      this.cache = results;
      this.lastFetch = Date.now();
      return results;

    } catch (err) {
      console.error('FitGirl Scraper error:', err);
      return [];
    }
  }

  async searchGames(query) {
    if (!query) return [];
    try {
      // FitGirl uses standard WordPress search
      const response = await axios.get(`${this.baseUrl}?s=${encodeURIComponent(query)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      const $ = cheerio.load(response.data);
      const results = [];

      $('article.category-lossless-repack').each((i, el) => {
        const titleElement = $(el).find('h1.entry-title a');
        const title = titleElement.text().trim();
        const url = titleElement.attr('href');
        
        const img = $(el).find('.entry-content img').first();
        let thumbnail = img.attr('data-lazy-src') || img.attr('data-src') || img.attr('src');
        
        if (thumbnail && !thumbnail.startsWith('http')) {
          thumbnail = 'https://fitgirl-repacks.site' + (thumbnail.startsWith('/') ? '' : '/') + thumbnail;
        }

        const magnetLink = $(el).find('a[href^="magnet:"]').first().attr('href') || '';

        if (title) {
          results.push({ title, url, thumbnail, magnet: magnetLink });
        }
      });

      return results;
    } catch (err) {
      console.error('FitGirl Search error:', err);
      return [];
    }
  }

  async getMagnetLink(pageUrl) {
    if (!pageUrl) return null;
    try {
      const response = await axios.get(pageUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      const $ = cheerio.load(response.data);
      let link = $('a[href^="magnet:"]').first().attr('href');
      
      if (!link) {
        link = $('a[href$=".torrent"]').first().attr('href');
      }
      
      if (!link) {
         $('a').each((i, el) => {
           const href = $(el).attr('href');
           if (!link && href && href.toLowerCase().includes('torrent') && href.includes('download')) {
             link = href;
           }
         });
      }
      
      // If still no link, try searching 1337x using searchEngine
      if (!link) {
        try {
          const searchEngine = require('./search-engine');
          let title = $('h1.entry-title').text().replace(/\[.*?\]/g, '').replace(/FitGirl Repack/ig, '').trim();
          title = title.replace(/^#[0-9]+\s*/, '').trim(); // FitGirl sometimes uses "#1234 "
          if (title) {
            const torrents = await searchEngine.searchTorrents(title + ' FitGirl', 10);
            if (torrents && torrents.length > 0) {
              for (const t of torrents) {
                const mag = t.magnet || await searchEngine.getMagnet(t);
                if (mag && mag.includes('magnet:?') && !mag.includes('0000000000000000000000000000000000000000')) {
                  link = mag;
                  break;
                }
              }
            }
          }
        } catch(e) { console.error('FitGirl Fallback search error', e); }
      }
      
      return link || null;
    } catch (err) {
      return null;
    }
  }

  async getGameInfo(pageUrl) {
    if (!pageUrl) return null;
    try {
      const response = await axios.get(pageUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      const $ = cheerio.load(response.data);
      
      let infoText = '';
      $('.entry-content p').each((i, el) => {
        const text = $(el).text();
        // Typically the first few paragraphs contain the juicy info: Genres, Companies, Sizes
        if (text.includes('Genres/Tags:') || text.includes('Repack Size:') || text.includes('Original Size:')) {
          infoText += text + '\n\n';
        }
      });
      
      return infoText.trim() || 'Detailed information could not be automatically extracted. Please visit the site for more details.';
    } catch (err) {
      console.error('FitGirl Info fetch error:', err);
      return 'Failed to fetch game information.';
    }
  }
}

module.exports = new FitGirlScraper();
