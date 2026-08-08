// 画面側の処理（ブラウザで動く）

const $ = (id) => document.getElementById(id);

// いま編集中の項目（1度に1件だけ開く）
let editingId = null;

// ---------------------------------------------------------------
// サーバーとのやり取り
// ---------------------------------------------------------------

async function api(method, url, body) {
  const options = { method, headers: {} };
  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '処理に失敗しました');
  return data;
}

let toastTimer = null;
function toast(text, type = 'success') {
  const el = $('toast');
  el.textContent = text;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
}

// 通信まわりの共通処理（失敗したらトーストを出す）
async function run(fn, successMessage) {
  try {
    await fn();
    if (successMessage) toast(successMessage, 'success');
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------
// 部品づくり
// ---------------------------------------------------------------

function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
}

function button(label, iconName, className, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.append(icon(iconName), document.createTextNode(label));
  btn.onclick = onClick;
  return btn;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------
// 日付・週まわり
// ---------------------------------------------------------------

// 2026/08/09 14:30 の形式
function formatDate(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// その日が属する ISO 週（月曜はじまり）を "2026-W32" の形で返す
function isoWeekOf(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7; // 月=1 ... 日=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // その週の木曜日に寄せる
  const year = d.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((d - jan1) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// "2026-W32" → その週の月曜〜日曜
function weekRange(weekStr) {
  const [year, week] = weekStr.split('-W').map(Number);
  const jan4 = new Date(Date.UTC(year, 0, 4)); // 1/4 は必ず第1週に入る
  const dayNum = jan4.getUTCDay() || 7;
  const start = new Date(jan4);
  start.setUTCDate(jan4.getUTCDate() - dayNum + 1 + (week - 1) * 7);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return { start, end };
}

// "2026年 第32週（8/3〜8/9）"
function weekLabel(weekStr) {
  const [year, week] = weekStr.split('-W').map(Number);
  const { start, end } = weekRange(weekStr);
  const md = (d) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return `${year}年 第${week}週（${md(start)}〜${md(end)}）`;
}

// ---------------------------------------------------------------
// ダッシュボード
// ---------------------------------------------------------------

function renderDashboard(data) {
  $('stat-memos').textContent = data.memos.length;
  $('stat-tasks').textContent = data.tasks.length;
  $('stat-done-tasks').textContent = data.tasks.filter((t) => t.done).length;
  $('stat-reviews').textContent = data.reviews.length;

  $('memo-count').textContent = data.memos.length;
  $('task-count').textContent = data.tasks.length;
  $('review-count').textContent = data.reviews.length;

  // 最新の振り返り（週が一番新しいもの）
  const latest = data.reviews[0];
  const box = $('latest-review');
  if (!latest) {
    box.classList.add('is-empty');
    $('latest-week').textContent = '—';
    $('latest-comment').textContent = 'まだ振り返りが記録されていません。下の「週次の振り返り」から記録できます。';
    $('latest-meta').textContent = '';
    return;
  }
  box.classList.remove('is-empty');
  $('latest-week').textContent = weekLabel(latest.week);
  $('latest-comment').textContent = latest.comment;
  $('latest-meta').textContent = latest.updatedAt
    ? `記録: ${formatDate(latest.createdAt)} / 更新: ${formatDate(latest.updatedAt)}`
    : `記録: ${formatDate(latest.createdAt)}`;
}

// ---------------------------------------------------------------
// メモ
// ---------------------------------------------------------------

function renderMemos(memos) {
  const list = $('memo-list');
  list.textContent = '';
  $('memo-empty').style.display = memos.length ? 'none' : 'flex';

  for (const memo of memos) {
    const li = el('li', 'item');
    li.append(editingId === memo.id ? memoEditForm(memo) : memoView(memo));
    list.append(li);
  }
}

function memoView(memo) {
  const frag = document.createDocumentFragment();

  const head = el('div', 'item-head');
  head.append(el('span', 'item-title', memo.title));

  const actions = el('div', 'actions');
  actions.append(
    button('編集', 'i-edit', 'btn btn-ghost', () => { editingId = memo.id; refresh(); }),
    button('削除', 'i-trash', 'btn btn-ghost is-danger', () => {
      run(() => api('DELETE', `/api/memos/${memo.id}`), 'メモを削除しました');
    }),
  );
  head.append(actions);
  frag.append(head);

  if (memo.content) frag.append(el('p', 'item-body', memo.content));

  const meta = el('div', 'item-meta');
  meta.append(el('span', null, `作成: ${formatDate(memo.createdAt)}`));
  if (memo.updatedAt) meta.append(el('span', 'badge edited', `編集済み ${formatDate(memo.updatedAt)}`));
  frag.append(meta);

  return frag;
}

function memoEditForm(memo) {
  const form = el('form', 'edit-form');

  const title = el('input');
  title.type = 'text';
  title.value = memo.title;
  title.maxLength = 100;
  title.placeholder = 'タイトル';

  const content = el('textarea');
  content.value = memo.content;
  content.rows = 3;
  content.maxLength = 5000;
  content.placeholder = '本文';

  const actions = el('div', 'edit-actions');
  const cancel = button('キャンセル', 'i-close', 'btn btn-ghost', () => { editingId = null; refresh(); });
  const save = el('button', 'btn btn-primary');
  save.type = 'submit';
  save.append(icon('i-save'), document.createTextNode('保存'));
  actions.append(cancel, save);

  form.append(title, content, actions);
  form.onsubmit = (e) => {
    e.preventDefault();
    run(async () => {
      await api('PATCH', `/api/memos/${memo.id}`, { title: title.value, content: content.value });
      editingId = null;
    }, 'メモを更新しました');
  };

  setTimeout(() => title.focus(), 0);
  return form;
}

// ---------------------------------------------------------------
// タスク
// ---------------------------------------------------------------

function renderTasks(tasks) {
  const list = $('task-list');
  list.textContent = '';
  $('task-empty').style.display = tasks.length ? 'none' : 'flex';

  for (const task of tasks) {
    const li = el('li', task.done ? 'item done' : 'item');
    li.append(editingId === task.id ? taskEditForm(task) : taskView(task));
    list.append(li);
  }
}

function taskView(task) {
  const frag = document.createDocumentFragment();

  const head = el('div', 'item-head');
  head.append(el('span', 'item-title', task.title));

  const actions = el('div', 'actions');
  actions.append(
    button(
      task.done ? '戻す' : '完了',
      task.done ? 'i-undo' : 'i-check',
      task.done ? 'btn btn-ghost' : 'btn btn-ghost is-done',
      () => run(
        () => api('PATCH', `/api/tasks/${task.id}/toggle`),
        task.done ? 'タスクを未完了に戻しました' : 'タスクを完了しました',
      ),
    ),
    button('編集', 'i-edit', 'btn btn-ghost', () => { editingId = task.id; refresh(); }),
    button('削除', 'i-trash', 'btn btn-ghost is-danger', () => {
      run(() => api('DELETE', `/api/tasks/${task.id}`), 'タスクを削除しました');
    }),
  );
  head.append(actions);
  frag.append(head);

  const meta = el('div', 'item-meta');
  meta.append(el('span', task.done ? 'badge done' : 'badge', task.done ? '完了' : '未完了'));
  meta.append(el('span', null, `作成: ${formatDate(task.createdAt)}`));
  if (task.completedAt) meta.append(el('span', null, `/ 完了: ${formatDate(task.completedAt)}`));
  if (task.updatedAt) meta.append(el('span', 'badge edited', `編集済み ${formatDate(task.updatedAt)}`));
  frag.append(meta);

  return frag;
}

function taskEditForm(task) {
  const form = el('form', 'edit-form');

  const title = el('input');
  title.type = 'text';
  title.value = task.title;
  title.maxLength = 200;
  title.placeholder = 'やること';

  const actions = el('div', 'edit-actions');
  const cancel = button('キャンセル', 'i-close', 'btn btn-ghost', () => { editingId = null; refresh(); });
  const save = el('button', 'btn btn-primary');
  save.type = 'submit';
  save.append(icon('i-save'), document.createTextNode('保存'));
  actions.append(cancel, save);

  form.append(title, actions);
  form.onsubmit = (e) => {
    e.preventDefault();
    run(async () => {
      await api('PATCH', `/api/tasks/${task.id}`, { title: title.value });
      editingId = null;
    }, 'タスクを更新しました');
  };

  setTimeout(() => title.focus(), 0);
  return form;
}

// ---------------------------------------------------------------
// 週次の振り返り
// ---------------------------------------------------------------

function renderReviews(reviews) {
  const list = $('review-list');
  list.textContent = '';
  $('review-empty').style.display = reviews.length ? 'none' : 'flex';

  for (const review of reviews) {
    const li = el('li', 'item');
    li.append(editingId === review.id ? reviewEditForm(review) : reviewView(review));
    list.append(li);
  }
}

function reviewView(review) {
  const frag = document.createDocumentFragment();

  const head = el('div', 'item-head');
  head.append(el('span', 'chip', weekLabel(review.week)));

  const actions = el('div', 'actions');
  actions.append(
    button('編集', 'i-edit', 'btn btn-ghost', () => { editingId = review.id; refresh(); }),
    button('削除', 'i-trash', 'btn btn-ghost is-danger', () => {
      run(() => api('DELETE', `/api/reviews/${review.id}`), '振り返りを削除しました');
    }),
  );
  head.append(actions);
  frag.append(head);

  frag.append(el('p', 'item-body', review.comment));

  const meta = el('div', 'item-meta');
  meta.append(el('span', null, `記録: ${formatDate(review.createdAt)}`));
  if (review.updatedAt) meta.append(el('span', 'badge edited', `更新 ${formatDate(review.updatedAt)}`));
  frag.append(meta);

  return frag;
}

function reviewEditForm(review) {
  const form = el('form', 'edit-form');
  form.append(el('span', 'chip', weekLabel(review.week)));

  const comment = el('textarea');
  comment.value = review.comment;
  comment.rows = 4;
  comment.maxLength = 5000;

  const actions = el('div', 'edit-actions');
  const cancel = button('キャンセル', 'i-close', 'btn btn-ghost', () => { editingId = null; refresh(); });
  const save = el('button', 'btn btn-primary');
  save.type = 'submit';
  save.append(icon('i-save'), document.createTextNode('保存'));
  actions.append(cancel, save);

  form.append(comment, actions);
  form.onsubmit = (e) => {
    e.preventDefault();
    run(async () => {
      await api('PATCH', `/api/reviews/${review.id}`, { comment: comment.value });
      editingId = null;
    }, '振り返りを更新しました');
  };

  setTimeout(() => comment.focus(), 0);
  return form;
}

// ---------------------------------------------------------------
// 全体の再描画
// ---------------------------------------------------------------

async function refresh() {
  try {
    const data = await api('GET', '/api/data');
    renderDashboard(data);
    renderMemos(data.memos);
    renderTasks(data.tasks);
    renderReviews(data.reviews);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------
// 追加フォーム
// ---------------------------------------------------------------

$('memo-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const title = $('memo-title').value;
  const content = $('memo-content').value;
  if (!title.trim() && !content.trim()) {
    return toast('タイトルか本文のどちらかは入力してください', 'error');
  }
  run(async () => {
    await api('POST', '/api/memos', { title, content });
    $('memo-title').value = '';
    $('memo-content').value = '';
  }, 'メモを追加しました');
});

$('task-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const title = $('task-title').value;
  if (!title.trim()) return toast('タスク内容を入力してください', 'error');
  run(async () => {
    await api('POST', '/api/tasks', { title });
    $('task-title').value = '';
  }, 'タスクを追加しました');
});

$('review-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const week = $('review-week').value;
  const comment = $('review-comment').value;
  if (!week) return toast('対象の週を選んでください', 'error');
  if (!comment.trim()) return toast('振り返りコメントを入力してください', 'error');
  run(async () => {
    await api('POST', '/api/reviews', { week, comment });
    $('review-comment').value = '';
  }, '振り返りを記録しました');
});

// ---------------------------------------------------------------
// 起動時の初期化
// ---------------------------------------------------------------

const now = new Date();
$('today').textContent = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}（${'日月火水木金土'[now.getDay()]}）`;

const weekInput = $('review-week');
weekInput.value = isoWeekOf(now);          // 初期値は今週
weekInput.placeholder = isoWeekOf(now);    // type="week" 非対応ブラウザ向け

refresh();
