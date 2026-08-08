// 自分専用の秘書アプリ - サーバー本体
// Node.js の標準モジュールだけで動く（npm install 不要）

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// ---------------------------------------------------------------
// データの読み書き（JSON ファイルに保存するので閉じても消えない）
// ---------------------------------------------------------------

const EMPTY_DATA = { memos: [], tasks: [], reviews: [] };

async function loadData() {
  try {
    const text = await fsp.readFile(DATA_FILE, 'utf8');
    const data = JSON.parse(text);
    // 壊れたファイル・古い形式のファイルでも落ちないように形を整える
    return {
      memos: Array.isArray(data.memos) ? data.memos : [],
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      reviews: Array.isArray(data.reviews) ? data.reviews : [],
    };
  } catch (err) {
    if (err.code === 'ENOENT') return { ...EMPTY_DATA }; // 初回起動
    console.error('データ読み込みに失敗したので空データで続行します:', err.message);
    return { ...EMPTY_DATA };
  }
}

async function saveData(data) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  // 一時ファイルに書いてから置き換える（書き込み中に落ちても壊れにくい）
  const tmpFile = `${DATA_FILE}.tmp`;
  await fsp.writeFile(tmpFile, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmpFile, DATA_FILE);
}

// APIの処理を1件ずつ順番に実行する。
// 「ファイルを読む→書き換える→保存する」の途中に別のリクエストが割り込むと、
// あとから保存したほうで上書きされて追加したデータが消えてしまうため。
let queue = Promise.resolve();
function serialize(task) {
  const result = queue.then(task, task); // 前が失敗しても次は実行する
  queue = result.then(() => {}, () => {});
  return result;
}

// ---------------------------------------------------------------
// 小さなヘルパー
// ---------------------------------------------------------------

function sendJson(res, statusCode, body) {
  const text = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) { // 1MB を超える入力は受け付けない
        reject(new Error('リクエストが大きすぎます'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON の形式が正しくありません'));
      }
    });
    req.on('error', reject);
  });
}

// 入力された文字列を整える（前後の空白除去＋長すぎる入力の切り詰め）
function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

// ---------------------------------------------------------------
// API の処理
// ---------------------------------------------------------------

async function handleApi(req, res, pathname) {
  const method = req.method;

  // 全データ取得（ダッシュボード・一覧の表示に使う）
  if (method === 'GET' && pathname === '/api/data') {
    const data = await loadData();
    return sendJson(res, 200, data);
  }

  // メモを追加
  if (method === 'POST' && pathname === '/api/memos') {
    const body = await readRequestBody(req);
    const title = cleanText(body.title, 100);
    const content = cleanText(body.content, 5000);
    if (!title && !content) {
      return sendJson(res, 400, { error: 'タイトルか本文のどちらかは入力してください' });
    }
    const data = await loadData();
    const memo = {
      id: crypto.randomUUID(),
      title: title || '(無題)',
      content,
      createdAt: new Date().toISOString(),
      updatedAt: null,
    };
    data.memos.unshift(memo); // 新しいものが上に来るように
    await saveData(data);
    return sendJson(res, 201, memo);
  }

  const memoMatch = pathname.match(/^\/api\/memos\/([\w-]+)$/);

  // メモを編集
  if (method === 'PATCH' && memoMatch) {
    const body = await readRequestBody(req);
    const title = cleanText(body.title, 100);
    const content = cleanText(body.content, 5000);
    if (!title && !content) {
      return sendJson(res, 400, { error: 'タイトルか本文のどちらかは入力してください' });
    }
    const data = await loadData();
    const memo = data.memos.find((m) => m.id === memoMatch[1]);
    if (!memo) return sendJson(res, 404, { error: 'メモが見つかりません' });
    memo.title = title || '(無題)';
    memo.content = content;
    memo.updatedAt = new Date().toISOString();
    await saveData(data);
    return sendJson(res, 200, memo);
  }

  // メモを削除
  if (method === 'DELETE' && memoMatch) {
    const id = memoMatch[1];
    const data = await loadData();
    const before = data.memos.length;
    data.memos = data.memos.filter((m) => m.id !== id);
    if (data.memos.length === before) {
      return sendJson(res, 404, { error: 'メモが見つかりません' });
    }
    await saveData(data);
    return sendJson(res, 200, { ok: true });
  }

  // タスクを追加
  if (method === 'POST' && pathname === '/api/tasks') {
    const body = await readRequestBody(req);
    const title = cleanText(body.title, 200);
    if (!title) {
      return sendJson(res, 400, { error: 'タスク内容を入力してください' });
    }
    const data = await loadData();
    const task = {
      id: crypto.randomUUID(),
      title,
      done: false,
      createdAt: new Date().toISOString(),
      updatedAt: null,
      completedAt: null,
    };
    data.tasks.unshift(task);
    await saveData(data);
    return sendJson(res, 201, task);
  }

  // タスクの完了 / 未完了を切り替え
  const toggleMatch = pathname.match(/^\/api\/tasks\/([\w-]+)\/toggle$/);
  if (method === 'PATCH' && toggleMatch) {
    const id = toggleMatch[1];
    const data = await loadData();
    const task = data.tasks.find((t) => t.id === id);
    if (!task) return sendJson(res, 404, { error: 'タスクが見つかりません' });
    task.done = !task.done;
    task.completedAt = task.done ? new Date().toISOString() : null;
    await saveData(data);
    return sendJson(res, 200, task);
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([\w-]+)$/);

  // タスクを編集
  if (method === 'PATCH' && taskMatch) {
    const body = await readRequestBody(req);
    const title = cleanText(body.title, 200);
    if (!title) return sendJson(res, 400, { error: 'タスク内容を入力してください' });
    const data = await loadData();
    const task = data.tasks.find((t) => t.id === taskMatch[1]);
    if (!task) return sendJson(res, 404, { error: 'タスクが見つかりません' });
    task.title = title;
    task.updatedAt = new Date().toISOString();
    await saveData(data);
    return sendJson(res, 200, task);
  }

  // タスクを削除
  if (method === 'DELETE' && taskMatch) {
    const id = taskMatch[1];
    const data = await loadData();
    const before = data.tasks.length;
    data.tasks = data.tasks.filter((t) => t.id !== id);
    if (data.tasks.length === before) {
      return sendJson(res, 404, { error: 'タスクが見つかりません' });
    }
    await saveData(data);
    return sendJson(res, 200, { ok: true });
  }

  // ---- 週次の振り返り -------------------------------------------

  // 振り返りを記録（同じ週がすでにあれば上書きする＝1週1件）
  if (method === 'POST' && pathname === '/api/reviews') {
    const body = await readRequestBody(req);
    const week = cleanText(body.week, 8);
    const comment = cleanText(body.comment, 5000);
    if (!isWeekFormat(week)) {
      return sendJson(res, 400, { error: '週の指定が正しくありません（例: 2026-W32）' });
    }
    if (!comment) {
      return sendJson(res, 400, { error: '振り返りコメントを入力してください' });
    }
    const data = await loadData();
    const existing = data.reviews.find((r) => r.week === week);
    if (existing) {
      existing.comment = comment;
      existing.updatedAt = new Date().toISOString();
      sortReviews(data.reviews);
      await saveData(data);
      return sendJson(res, 200, existing);
    }
    const review = {
      id: crypto.randomUUID(),
      week,
      comment,
      createdAt: new Date().toISOString(),
      updatedAt: null,
    };
    data.reviews.push(review);
    sortReviews(data.reviews); // 新しい週が先頭
    await saveData(data);
    return sendJson(res, 201, review);
  }

  const reviewMatch = pathname.match(/^\/api\/reviews\/([\w-]+)$/);

  // 振り返りを編集
  if (method === 'PATCH' && reviewMatch) {
    const body = await readRequestBody(req);
    const comment = cleanText(body.comment, 5000);
    if (!comment) return sendJson(res, 400, { error: '振り返りコメントを入力してください' });
    const data = await loadData();
    const review = data.reviews.find((r) => r.id === reviewMatch[1]);
    if (!review) return sendJson(res, 404, { error: '振り返りが見つかりません' });
    review.comment = comment;
    review.updatedAt = new Date().toISOString();
    await saveData(data);
    return sendJson(res, 200, review);
  }

  // 振り返りを削除
  if (method === 'DELETE' && reviewMatch) {
    const data = await loadData();
    const before = data.reviews.length;
    data.reviews = data.reviews.filter((r) => r.id !== reviewMatch[1]);
    if (data.reviews.length === before) {
      return sendJson(res, 404, { error: '振り返りが見つかりません' });
    }
    await saveData(data);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'そのAPIはありません' });
}

// 週は "2026-W32" 形式（ISO週番号）で受け取る
function isWeekFormat(value) {
  const m = /^(\d{4})-W(\d{2})$/.exec(value);
  if (!m) return false;
  const week = Number(m[2]);
  return week >= 1 && week <= 53;
}

// 新しい週が先頭に来るように並べ替える（文字列比較で正しく並ぶ形式）
function sortReviews(reviews) {
  reviews.sort((a, b) => (a.week < b.week ? 1 : a.week > b.week ? -1 : 0));
}

// ---------------------------------------------------------------
// 静的ファイル（HTML / CSS / JS）を返す
// ---------------------------------------------------------------

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.join(PUBLIC_DIR, relative);

  // public/ の外を読まれないようにする
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('アクセスできません');
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('ページが見つかりません');
    }
    const type = MIME_TYPES[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(content);
  });
}

// ---------------------------------------------------------------
// サーバー起動
// ---------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  if (pathname.startsWith('/api/')) {
    try {
      await serialize(() => handleApi(req, res, pathname));
    } catch (err) {
      console.error('APIエラー:', err.message);
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  serveStatic(res, pathname);
});

server.listen(PORT, () => {
  console.log('==============================================');
  console.log('  秘書アプリを起動しました');
  console.log(`  ブラウザで http://localhost:${PORT} を開いてください`);
  console.log(`  データ保存先: ${DATA_FILE}`);
  console.log('  終了するには Ctrl + C');
  console.log('==============================================');
});
