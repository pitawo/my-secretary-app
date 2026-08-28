// ブラウザだけで動かすための保存先（サーバーが無いときに使う）
//
// server.js と同じ振る舞いを localStorage の上で再現する。
// 置き場所が違うだけで、API の入出力・バリデーション・並び順は揃えてある。
// サーバーがある環境では読み込まれても使われない（app.js が実サーバーを優先する）。

const LocalStore = (() => {
  const KEY = 'secretary-app/data';
  const EMPTY_DATA = { memos: [], tasks: [], reviews: [] };

  // ---- 保存先 ---------------------------------------------------

  function load() {
    try {
      const text = localStorage.getItem(KEY);
      if (!text) return structuredClone(EMPTY_DATA);
      const data = JSON.parse(text);
      // 壊れた値・古い形式でも落ちないように形を整える（server.js と同じ方針）
      return {
        memos: Array.isArray(data.memos) ? data.memos : [],
        tasks: Array.isArray(data.tasks) ? data.tasks : [],
        reviews: Array.isArray(data.reviews) ? data.reviews : [],
      };
    } catch {
      return structuredClone(EMPTY_DATA);
    }
  }

  function save(data) {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (err) {
      // 容量超過やプライベートモードでの書き込み拒否
      throw new Error('保存できませんでした。ブラウザの保存容量がいっぱいか、保存が許可されていません');
    }
  }

  // ---- server.js と同じ補助関数 ---------------------------------

  function cleanText(value, maxLength) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, maxLength);
  }

  function isWeekFormat(value) {
    const m = /^(\d{4})-W(\d{2})$/.exec(value);
    if (!m) return false;
    const week = Number(m[2]);
    return week >= 1 && week <= 53;
  }

  function sortReviews(reviews) {
    reviews.sort((a, b) => (a.week < b.week ? 1 : a.week > b.week ? -1 : 0));
  }

  function now() {
    return new Date().toISOString();
  }

  function newId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function fail(message) {
    throw new Error(message);
  }

  // ---- ルーティング（server.js の handleApi と同じ分岐）----------

  function handle(method, url, body) {
    const data = load();

    if (method === 'GET' && url === '/api/data') return data;

    // ---- メモ ----
    if (method === 'POST' && url === '/api/memos') {
      const title = cleanText(body.title, 100);
      const content = cleanText(body.content, 5000);
      if (!title && !content) fail('タイトルか本文のどちらかは入力してください');
      const memo = { id: newId(), title: title || '(無題)', content, createdAt: now(), updatedAt: null };
      data.memos.unshift(memo);
      save(data);
      return memo;
    }

    const memoMatch = url.match(/^\/api\/memos\/([\w-]+)$/);

    if (method === 'PATCH' && memoMatch) {
      const title = cleanText(body.title, 100);
      const content = cleanText(body.content, 5000);
      if (!title && !content) fail('タイトルか本文のどちらかは入力してください');
      const memo = data.memos.find((m) => m.id === memoMatch[1]);
      if (!memo) fail('メモが見つかりません');
      memo.title = title || '(無題)';
      memo.content = content;
      memo.updatedAt = now();
      save(data);
      return memo;
    }

    if (method === 'DELETE' && memoMatch) {
      const before = data.memos.length;
      data.memos = data.memos.filter((m) => m.id !== memoMatch[1]);
      if (data.memos.length === before) fail('メモが見つかりません');
      save(data);
      return { ok: true };
    }

    // ---- タスク ----
    if (method === 'POST' && url === '/api/tasks') {
      const title = cleanText(body.title, 200);
      if (!title) fail('タスク内容を入力してください');
      const task = { id: newId(), title, done: false, createdAt: now(), updatedAt: null, completedAt: null };
      data.tasks.unshift(task);
      save(data);
      return task;
    }

    const toggleMatch = url.match(/^\/api\/tasks\/([\w-]+)\/toggle$/);
    if (method === 'PATCH' && toggleMatch) {
      const task = data.tasks.find((t) => t.id === toggleMatch[1]);
      if (!task) fail('タスクが見つかりません');
      task.done = !task.done;
      task.completedAt = task.done ? now() : null;
      save(data);
      return task;
    }

    const taskMatch = url.match(/^\/api\/tasks\/([\w-]+)$/);

    if (method === 'PATCH' && taskMatch) {
      const title = cleanText(body.title, 200);
      if (!title) fail('タスク内容を入力してください');
      const task = data.tasks.find((t) => t.id === taskMatch[1]);
      if (!task) fail('タスクが見つかりません');
      task.title = title;
      task.updatedAt = now();
      save(data);
      return task;
    }

    if (method === 'DELETE' && taskMatch) {
      const before = data.tasks.length;
      data.tasks = data.tasks.filter((t) => t.id !== taskMatch[1]);
      if (data.tasks.length === before) fail('タスクが見つかりません');
      save(data);
      return { ok: true };
    }

    // ---- 週次の振り返り（同じ週は上書き＝1週1件）----
    if (method === 'POST' && url === '/api/reviews') {
      const week = cleanText(body.week, 8);
      const comment = cleanText(body.comment, 5000);
      if (!isWeekFormat(week)) fail('週の指定が正しくありません（例: 2026-W32）');
      if (!comment) fail('振り返りコメントを入力してください');
      const existing = data.reviews.find((r) => r.week === week);
      if (existing) {
        existing.comment = comment;
        existing.updatedAt = now();
        sortReviews(data.reviews);
        save(data);
        return existing;
      }
      const review = { id: newId(), week, comment, createdAt: now(), updatedAt: null };
      data.reviews.push(review);
      sortReviews(data.reviews);
      save(data);
      return review;
    }

    const reviewMatch = url.match(/^\/api\/reviews\/([\w-]+)$/);

    if (method === 'PATCH' && reviewMatch) {
      const comment = cleanText(body.comment, 5000);
      if (!comment) fail('振り返りコメントを入力してください');
      const review = data.reviews.find((r) => r.id === reviewMatch[1]);
      if (!review) fail('振り返りが見つかりません');
      review.comment = comment;
      review.updatedAt = now();
      save(data);
      return review;
    }

    if (method === 'DELETE' && reviewMatch) {
      const before = data.reviews.length;
      data.reviews = data.reviews.filter((r) => r.id !== reviewMatch[1]);
      if (data.reviews.length === before) fail('振り返りが見つかりません');
      save(data);
      return { ok: true };
    }

    fail('その操作には対応していません');
  }

  // ---- 初回に入れておく中身（空の画面を見せないため）-------------

  function seedIfEmpty() {
    if (localStorage.getItem(KEY)) return;
    const t = Date.now();
    const iso = (minutesAgo) => new Date(t - minutesAgo * 60000).toISOString();
    const d = new Date();
    const thu = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    thu.setUTCDate(thu.getUTCDate() + 4 - (thu.getUTCDay() || 7));
    const week1 = new Date(Date.UTC(thu.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((thu - week1) / 86400000 + 1) / 7);
    const thisWeek = `${thu.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;

    save({
      memos: [
        {
          id: newId(),
          title: 'このデモについて',
          content:
            'これは動作を試すためのデモです。入力した内容はこのブラウザの中だけに保存され、どこにも送信されません。ページを閉じても残りますが、別の端末やブラウザには引き継がれません。',
          createdAt: iso(6),
          updatedAt: null,
        },
        {
          id: newId(),
          title: '使い方',
          content:
            'メモ・タスク・週次の振り返りを1画面で扱います。上のタブで切り替えてください。追加・編集・削除がひととおり動きます。',
          createdAt: iso(30),
          updatedAt: null,
        },
      ],
      tasks: [
        { id: newId(), title: 'メモを1件追加してみる', done: false, createdAt: iso(12), updatedAt: null, completedAt: null },
        { id: newId(), title: 'タスクを完了にして、戻してみる', done: false, createdAt: iso(20), updatedAt: null, completedAt: null },
        { id: newId(), title: '週次の振り返りを書いてみる', done: true, createdAt: iso(50), updatedAt: null, completedAt: iso(8) },
      ],
      reviews: [
        {
          id: newId(),
          week: thisWeek,
          comment:
            '既製のタスク管理アプリは機能が多く、自分が使う3つ以外が視界に入る。使うものだけが1画面に載っている状態が欲しくて、自分で作ることにした。',
          createdAt: iso(120),
          updatedAt: null,
        },
      ],
    });
  }

  return { handle, seedIfEmpty, KEY };
})();
