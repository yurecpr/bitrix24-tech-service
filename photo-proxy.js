/**
 * Проксі для завантаження фото заявок на ремонт → Bitrix24 Disk
 * Порт: 5003
 * Nginx: location /tech-proxy/ { proxy_pass http://127.0.0.1:5003/; }
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const WEBHOOK_URL = 'https://atp.bitrix24.eu/rest/141/k8sfskkzu9y2zg1g/';
const PORT        = 5003;
const MAX_BODY_MB = 150;
const FOLDER_ROOT = 'ATP-Tech-Photos';
const CACHE_PATH  = path.join(__dirname, 'tech-disk-cache.json');
const PHOTO_FIELD = 'UF_CRM_1961';

// ── Bitrix24 REST ─────────────────────────────────────────────────────────────
async function bx(method, params) {
  const res = await fetch(`${WEBHOOK_URL}${method}.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error_description || data.error);
  return data.result;
}

// ── Кеш папок ────────────────────────────────────────────────────────────────
function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); }
  catch { return {}; }
}
function saveCache(cache) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

const WEBHOOK_USER_ID = WEBHOOK_URL.split('/rest/')[1].split('/')[0];

// ── Знайти або створити папку ─────────────────────────────────────────────────
async function ensureFolder(dealId) {
  const key   = `deal_${dealId}`;
  const cache = loadCache();
  if (cache[key]) return cache[key];

  let rootId = cache['__root'];
  if (!rootId) {
    const storages = await bx('disk.storage.getlist', {
      filter: { ENTITY_TYPE: 'user', ENTITY_ID: WEBHOOK_USER_ID }
    });
    const personal   = storages[0];
    const rootObjId  = personal.ROOT_OBJECT_ID;
    const items      = await bx('disk.folder.getchildren', { id: rootObjId });
    const found      = items.find(i => i.NAME === FOLDER_ROOT && i.TYPE === 'folder');
    rootId = found
      ? found.ID
      : (await bx('disk.folder.addsubfolder', { id: rootObjId, data: { NAME: FOLDER_ROOT } })).ID;
    cache['__root'] = rootId;
    saveCache(cache);
  }

  const subName  = `deal${dealId}`;
  const subItems = await bx('disk.folder.getchildren', { id: rootId });
  const foundSub = subItems.find(i => i.NAME === subName && i.TYPE === 'folder');
  const folderId = foundSub
    ? foundSub.ID
    : (await bx('disk.folder.addsubfolder', { id: rootId, data: { NAME: subName } })).ID;

  cache[key] = folderId;
  saveCache(cache);
  console.log(`[disk] folder "${subName}" → ID ${folderId}`);
  return folderId;
}

// ── Список файлів папки ───────────────────────────────────────────────────────
async function listDiskFiles(folderId) {
  const files = [];
  let start = 0;
  while (true) {
    const items = await bx('disk.folder.getchildren', { id: folderId, start });
    files.push(...items.filter(i => i.TYPE === 'file'));
    if (items.length < 50) break;
    start += 50;
  }
  return files;
}

// ── Завантажити файл за DOWNLOAD_URL ─────────────────────────────────────────
async function fetchBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const mime = res.headers.get('content-type') || 'image/jpeg';
  if (mime.includes('text/html')) throw new Error('Got HTML (signed URL invalid)');
  const buf = await res.arrayBuffer();
  const ext = mime.split('/')[1]?.split(';')[0] || 'bin';
  return { base64: Buffer.from(buf).toString('base64'), ext };
}

// ── Стиснення зображення через sharp (якщо встановлено) ──────────────────────
async function compressImage(base64, ext) {
  try {
    const sharp = require('sharp');
    const buf = Buffer.from(base64, 'base64');
    const out = await sharp(buf)
      .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();
    return out.toString('base64');
  } catch {
    return base64;
  }
}

// ── HTTP-сервер ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method !== 'POST' || req.url !== '/upload-photos') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Not found' }));
  }

  const chunks = [];
  let size = 0;
  req.on('data', chunk => {
    size += chunk.length;
    if (size > MAX_BODY_MB * 1024 * 1024) {
      req.destroy();
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload too large' }));
    } else {
      chunks.push(chunk);
    }
  });

  req.on('end', async () => {
    try {
      const { dealId, files } = JSON.parse(Buffer.concat(chunks).toString());
      if (!dealId) throw new Error('Missing dealId');
      if (!files || files.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, total: 0 }));
      }

      // 1. Папка
      const folderId = await ensureFolder(dealId);

      // 2. Завантажуємо нові файли (дедуплікація по MD5)
      const hashKey     = `hashes_${dealId}`;
      const cache       = loadCache();
      const knownHashes = new Set(cache[hashKey] || []);
      const newHashes   = [];

      for (const f of files) {
        const hash = crypto.createHash('md5').update(f.base64).digest('hex');
        if (knownHashes.has(hash)) {
          console.log(`[dedup] skip "${f.name}" (${hash.slice(0, 8)})`);
          continue;
        }
        const ext        = f.name.includes('.') ? f.name.split('.').pop() : '';
        const baseName   = f.name.includes('.') ? f.name.slice(0, f.name.lastIndexOf('.')) : f.name;
        const uniqueName = `${baseName}_${Date.now()}${ext ? '.' + ext : ''}`;
        await bx('disk.folder.uploadfile', {
          id: folderId, data: { NAME: uniqueName }, fileContent: [uniqueName, f.base64],
        });
        newHashes.push(hash);
        console.log(`[disk] uploaded "${uniqueName}"`);
      }

      if (newHashes.length === 0) {
        console.log(`[proxy] deal ${dealId}: no new files, skipping CRM update`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, total: 0, skipped: true }));
      }

      cache[hashKey] = [...Array.from(knownHashes), ...newHashes];
      saveCache(cache);

      // 3. Всі файли папки → base64 зі стисненням
      const diskFiles  = await listDiskFiles(folderId);
      console.log(`[disk] folder has ${diskFiles.length} files total`);

      const allFileData = [];
      const seenHashes  = new Set();
      for (const df of diskFiles) {
        const info = await bx('disk.file.get', { id: df.ID });
        const { base64, ext } = await fetchBase64(info.DOWNLOAD_URL);
        const hash = crypto.createHash('md5').update(base64).digest('hex');
        if (seenHashes.has(hash)) continue;
        seenHashes.add(hash);

        const sizeKB = Math.round(base64.length * 0.75 / 1024);
        let finalBase64 = base64;
        if (sizeKB > 500 && (ext === 'jpg' || ext === 'jpeg' || ext === 'png')) {
          finalBase64 = await compressImage(base64, ext);
          const newSizeKB = Math.round(finalBase64.length * 0.75 / 1024);
          console.log(`[disk] compressed "${df.NAME}": ${sizeKB}KB → ${newSizeKB}KB`);
        }
        allFileData.push({ fileData: [df.NAME || `file_${df.ID}.${ext}`, finalBase64] });
        console.log(`[disk] fetched "${df.NAME}" (${df.ID}) ${sizeKB}KB`);
      }

      // 4. Оновлюємо поле фото в угоді
      await bx('crm.deal.update', { id: dealId, fields: { [PHOTO_FIELD]: allFileData } });

      console.log(`[proxy] deal ${dealId}: ${allFileData.length} files saved`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, total: allFileData.length }));

    } catch (err) {
      console.error('[proxy] error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Tech photo proxy on :${PORT}`));
