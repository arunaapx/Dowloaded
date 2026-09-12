let WebTorrent;
const fs = require('fs');
const path = require('path');

const ANNOUNCE = [
  // Top public trackers
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://tracker.bitsearch.to:1337/announce',
  'udp://p4p.arenabg.com:1337/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://opentracker.i2p.rocks:6969/announce',
  'udp://tracker.theoks.net:6969/announce',
  'udp://movies.zsw.ca:6969/announce',
  // Extra high-speed trackers
  'udp://tracker.coppersurfer.tk:6969/announce',
  'udp://9.rarbg.to:2920/announce',
  'udp://tracker.leechers-paradise.org:6969/announce',
  'udp://tracker.internetwarriors.net:1337/announce',
  'udp://tracker.cyberia.is:6969/announce',
  'udp://tracker.pirateparty.gr:6969/announce',
  'udp://tracker.zer0day.to:1337/announce',
  'udp://tracker.pomf.se:80/announce',
  'udp://fe.dealclub.de:6969/announce',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.fastcast.nz'
];

// While a torrent runs, its bitfield (which pieces are already on disk) is
// saved this often, so even after a crash it resumes from at most this far
// back. A normal quit saves it once more on the way out.
const RESUME_SAVE_MS = 15000;

// Each torrent is tracked under the id of its row in the Torrents tab (the
// magnet link or .torrent path it was added from), which exists before the
// info hash does.
class TorrentManager {
  constructor() {
    this.client = null;
    this.entries = new Map();
    this.dataDir = null;
  }

  // userData/torrents keeps, per info hash, the .torrent metadata and the last
  // saved bitfield. With both, a restart neither waits for peers to hand the
  // metadata over again nor re-hashes every gigabyte already downloaded.
  setDataDir(dir) {
    this.dataDir = path.join(dir, 'torrents');
    try { fs.mkdirSync(this.dataDir, { recursive: true }); } catch {}
  }

  async init() {
    if (!WebTorrent) {
      const module = await import('webtorrent');
      WebTorrent = module.default;
    }
    if (!this.client) {
      this.client = new WebTorrent({
        maxConns: 200,        // max peers per torrent (default 55)
        downloadLimit: -1,    // unlimited download
        uploadLimit: -1,      // unlimited upload
        dht: true,            // enable DHT peer discovery
        lsd: true,            // enable Local Service Discovery
        webSeeds: true        // enable web seeds
      });
      // Torrent errors are reported per torrent below. This only keeps one
      // that slips through from becoming an uncaught 'error' event.
      this.client.on('error', (err) => console.error('[torrent]', err && err.message));
    }
  }

  has(id) {
    return this.entries.has(id);
  }

  isConfirmed(id) {
    const e = this.entries.get(id);
    return !!(e && e.confirmed);
  }

  // Starts a torrent with nothing selected. What downloads is decided once the
  // file list is known: a confirmed torrent (a restore) gets its saved choice
  // back; a new one sends its file list to the picker and waits for
  // setFiles(). `selected` is a list of file indexes, or null for every file.
  async add({ id, source, hash, savePath, selected = null, confirmed = false, paused = false }, handlers) {
    await this.init();
    if (this.entries.has(id)) throw new Error('That torrent is already in the list.');

    const metadata = this._read(hash, 'torrent');
    const bitfield = metadata && this._read(hash, 'bitfield');
    const opts = { path: savePath, announce: ANNOUNCE, deselect: true };
    // WebTorrent spot-checks a startup bitfield against the files on disk and
    // re-hashes any file that fails, so a stale one costs time, never data.
    if (bitfield) opts.bitfield = bitfield;

    const entry = {
      id, selected, confirmed, paused, handlers,
      completed: false,
      filesSent: false,
      torrent: null,
      timer: null,
      lastSave: Date.now(),
    };
    entry.torrent = this.client.add(metadata || source, opts);
    this.entries.set(id, entry);
    this._wire(entry);
  }

  _wire(entry) {
    const t = entry.torrent;
    t.on('metadata', () => {
      this._saveMetadata(t);
      if (!entry.confirmed) this._sendFiles(entry);
    });
    t.on('ready', () => {
      this._applySelection(entry);
      this._tick(entry);
    });
    t.on('error', (err) => {
      this._forget(entry);
      entry.handlers.onError?.(entry.id, err);
    });
    entry.timer = setInterval(() => this._tick(entry), 1000);
  }

  _forget(entry) {
    clearInterval(entry.timer);
    if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
  }

  _tick(entry) {
    const t = entry.torrent;
    if (t.destroyed) return;
    // WebTorrent's own 'done' only fires once every file is complete, which
    // never happens when some were left out, so completion is judged on the
    // chosen files alone.
    if (entry.confirmed && t.ready && !entry.completed && this._chosen(entry).every((f) => f.done)) {
      entry.completed = true;
      this._saveResume(entry);
      entry.handlers.onDone?.(entry.id, t.infoHash, t.name);
    }
    if (Date.now() - entry.lastSave >= RESUME_SAVE_MS) this._saveResume(entry);
    entry.handlers.onProgress?.(this._snapshot(entry));
  }

  _chosen(entry) {
    const files = entry.torrent.files;
    if (!entry.selected) return files;
    const want = new Set(entry.selected);
    return files.filter((_, i) => want.has(i));
  }

  _state(entry) {
    const t = entry.torrent;
    if (entry.paused) return 'paused';
    if (!t.metadata) return 'metadata';
    if (!entry.confirmed) return 'select';
    if (!t.ready) return 'checking';
    return entry.completed ? 'seeding' : 'downloading';
  }

  // Sizes, progress and ETA cover the chosen files only.
  _snapshot(entry) {
    const t = entry.torrent;
    let length = 0;
    let downloaded = 0;
    if (t.metadata) {
      for (const f of this._chosen(entry)) {
        if (!f.length) continue;
        length += f.length;
        // WebTorrent subtracts a whole piece from a file that ends on a piece
        // boundary, which left a finished selection reporting 99.x%. A file
        // that is done has all of its bytes, by definition.
        downloaded += f.done ? f.length : Math.min(f.downloaded, f.length);
      }
    }
    const speed = t.downloadSpeed;
    const remaining = length - downloaded;
    return {
      id: entry.id,
      infoHash: t.infoHash,
      name: t.name || null,
      state: this._state(entry),
      progress: length ? downloaded / length : 0,
      length,
      downloaded,
      downloadSpeed: speed,
      uploadSpeed: t.uploadSpeed,
      numPeers: t.numPeers,
      timeRemaining: speed > 0 && remaining > 0 ? (remaining / speed) * 1000 : 0,
    };
  }

  _sendFiles(entry) {
    if (entry.filesSent) return;
    entry.filesSent = true;
    entry.handlers.onFiles?.({ id: entry.id, infoHash: entry.torrent.infoHash, ...this.getFiles(entry.id) });
  }

  // Replaces whatever is selected with the chosen files. Nothing is selected
  // while paused or before the user has chosen, and with nothing selected
  // nothing downloads.
  _applySelection(entry) {
    const t = entry.torrent;
    if (!t.ready || t.destroyed) return;
    if (t.pieces.length) t.deselect(0, t.pieces.length - 1);
    if (entry.paused || !entry.confirmed) return;
    const chosen = this._chosen(entry);
    for (const f of chosen) f.select();
    if (!chosen.every((f) => f.done)) entry.completed = false;
  }

  getFiles(id) {
    const e = this.entries.get(id);
    if (!e || !e.torrent.metadata) return null;
    const want = e.selected ? new Set(e.selected) : null;
    return {
      name: e.torrent.name,
      confirmed: e.confirmed,
      files: e.torrent.files.map((f, index) => ({
        index,
        // parse-torrent joins with the platform separator; the UI wants '/'.
        path: f.path.split(path.sep).join('/'),
        length: f.length,
        progress: f.progress,
        selected: want ? want.has(index) : true,
      })),
    };
  }

  // The picker's answer. The first one starts the download (main.js charges
  // for it first); later ones only change which files are fetched.
  setFiles(id, selected) {
    const e = this.entries.get(id);
    if (!e || !e.torrent.metadata) throw new Error('The file list is not available yet.');
    const count = e.torrent.files.length;
    let list = Array.isArray(selected)
      ? [...new Set(selected)].filter((i) => Number.isInteger(i) && i >= 0 && i < count).sort((a, b) => a - b)
      : null;
    if (list && !list.length) throw new Error('Choose at least one file.');
    if (list && list.length === count) list = null;
    if (!e.confirmed) {
      e.confirmed = true;
      e.paused = false;
    }
    e.selected = list;
    this._applySelection(e);
    this._tick(e);
  }

  // Pausing drops the selection rather than calling WebTorrent's pause(),
  // which only stops *new* connections: peers already connected keep sending,
  // and peers found while paused are thrown away, so a resume could then sit
  // at zero peers until the next tracker announce. With nothing selected the
  // torrent is not interested in any piece, so nothing more comes in, and
  // resuming is immediate because the connections are still there.
  pause(id) {
    const e = this.entries.get(id);
    if (!e || e.torrent.destroyed) return;
    e.paused = true;
    this._applySelection(e);
    this._saveResume(e);
    this._tick(e);
  }

  resume(id) {
    const e = this.entries.get(id);
    if (!e || e.torrent.destroyed) return false;
    e.paused = false;
    this._applySelection(e);
    this._tick(e);
    return true;
  }

  // Stop every running torrent at once. Used when the licence stops being
  // valid: without this a revoked or trial-exhausted machine keeps
  // downloading in the background, because torrents run in WebTorrent and
  // never touch the yt-dlp job list that stopActiveDownloads() cancels.
  pauseAll() {
    for (const id of this.entries.keys()) {
      try { this.pause(id); } catch {}
    }
  }

  remove(id, destroyStore = false) {
    const e = this.entries.get(id);
    if (!e) return;
    this._forget(e);
    const hash = e.torrent.infoHash;
    e.torrent.destroy({ destroyStore: !!destroyStore }, () => {});
    // Its saved metadata and bitfield go too: adding it again starts clean.
    for (const ext of ['torrent', 'bitfield']) {
      const p = this._path(hash, ext);
      if (p) fs.rm(p, { force: true }, () => {});
    }
  }

  // Called on quit. Synchronous because quit does not wait for anything.
  saveAllResumeData() {
    for (const e of this.entries.values()) this._saveResume(e);
  }

  _path(hash, ext) {
    if (!this.dataDir || typeof hash !== 'string' || !/^[0-9a-f]{40}$/i.test(hash)) return null;
    return path.join(this.dataDir, `${hash.toLowerCase()}.${ext}`);
  }

  _read(hash, ext) {
    const p = this._path(hash, ext);
    try { return p ? fs.readFileSync(p) : null; } catch { return null; }
  }

  _saveMetadata(t) {
    const p = this._path(t.infoHash, 'torrent');
    if (!p || !t.torrentFile || fs.existsSync(p)) return;
    fs.writeFile(p, t.torrentFile, () => {});
  }

  // A piece is only marked in the bitfield once it has been written to disk,
  // so a saved bitfield never claims data that is not there.
  _saveResume(entry) {
    entry.lastSave = Date.now();
    const t = entry.torrent;
    // Before 'ready' the bitfield is still being rebuilt by verification; the
    // one saved last time is the better record, so leave it alone.
    if (!t.ready || t.destroyed || !t.bitfield) return;
    const p = this._path(t.infoHash, 'bitfield');
    if (!p) return;
    try { fs.writeFileSync(p, t.bitfield.buffer); } catch {}
  }
}

module.exports = new TorrentManager();
