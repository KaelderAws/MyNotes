// Конфигурация Google OAuth
const CLIENT_ID = '646165812033-7dk1rg91ioqc0kst2kinsvv8k2m8cl89.apps.googleusercontent.com';
const SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email'
].join(' ');

const FOLDER_NAME = 'Заметки (Notes App)';

// Цвета выделения (HEX для execCommand и RGB для Google Docs API)
const STATUS_COLORS = {
  done: '#b7e1cd',        // Зелёный (Выполнено)
  pending: '#fce8b2',     // Жёлтый (Отложено)
  cancelled: '#f4c7c3',   // Красный (Отменено)
  clear: 'transparent'
};

const DOC_COLORS = {
  done: { red: 0.718, green: 0.882, blue: 0.804 },
  pending: { red: 0.988, green: 0.910, blue: 0.698 },
  cancelled: { red: 0.957, green: 0.780, blue: 0.765 }
};

// Состояние приложения
let tokenClient = null;
let accessToken = localStorage.getItem('gdocs_access_token') || null;
let tokenExpiresAt = localStorage.getItem('gdocs_token_expires') || 0;
let notesFolderId = null;
let notesList = [];
let activeNote = null;
let isDirty = false;
let isLoadingNote = false;
let noteLoadToken = 0;
let saveTimeout = null;
const saveQueueByNoteId = new Map();

// DOM Элементы
const authScreen = document.getElementById('auth-screen');
const mainScreen = document.getElementById('main-screen');
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');
const userAvatar = document.getElementById('user-avatar');
const userName = document.getElementById('user-name');
const userEmail = document.getElementById('user-email');
const newNoteBtn = document.getElementById('new-note-btn');
const searchInput = document.getElementById('search-input');
const notesListEl = document.getElementById('notes-list');
const notesLoadingEl = document.getElementById('notes-loading');
const editorEmpty = document.getElementById('editor-empty');
const editorActive = document.getElementById('editor-active');
const noteTitleInput = document.getElementById('note-title-input');
const noteBodyInput = document.getElementById('note-body-input');
const syncStatusEl = document.getElementById('sync-status');
const openInDocsBtn = document.getElementById('open-in-docs-btn');
const manualSaveBtn = document.getElementById('manual-save-btn');
const deleteNoteBtn = document.getElementById('delete-note-btn');

// Кнопки фильтрации строк
const toolBtnAll = document.getElementById('tool-btn-all');
const toolBtnDone = document.getElementById('tool-btn-done');
const toolBtnPending = document.getElementById('tool-btn-pending');
const toolBtnCancelled = document.getElementById('tool-btn-cancelled');
const toolBtnClear = document.getElementById('tool-btn-clear');

// Правая колонка статистики
const editorSidebarRight = document.getElementById('editor-sidebar-right');

// Контекстное меню
const customContextMenu = document.getElementById('custom-context-menu');
const cmStatusSection = document.getElementById('cm-status-section');
const cmClipboardSection = document.getElementById('cm-clipboard-section');
const cmNoteActionsSection = document.getElementById('cm-note-actions-section');
const cmOpenDocsBtn = document.getElementById('cm-open-docs');
const cmDeleteNoteBtn = document.getElementById('cm-delete-note');

// Баннер обновления сессии
const sessionBanner = document.getElementById('session-banner');
const sessionRenewBtn = document.getElementById('session-renew-btn');

let refreshTimer = null;
let tokenRefreshPromise = null;

// --- Локальное резервное копирование черновиков (защита от потери при F5 / сбоях сети) ---
function saveLocalDraft(noteId, title, html) {
  if (!noteId) return;
  try {
    localStorage.setItem(`gdocs_draft_${noteId}`, JSON.stringify({
      title,
      html,
      timestamp: Date.now()
    }));
  } catch (_) {}
}

function getLocalDraft(noteId) {
  if (!noteId) return null;
  try {
    const raw = localStorage.getItem(`gdocs_draft_${noteId}`);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function clearLocalDraft(noteId) {
  if (!noteId) return;
  try {
    localStorage.removeItem(`gdocs_draft_${noteId}`);
  } catch (_) {}
}

// --- Проверка необходимости обновления токена ---
function isTokenExpiringSoon() {
  if (!accessToken || !tokenExpiresAt) return true;
  // Если осталось менее 8 минут
  return Date.now() > (Number(tokenExpiresAt) - 8 * 60 * 1000);
}

// Запрос свежего access_token через Google Identity Services с жестким таймаутом
function requestFreshToken(interactive = false) {
  if (tokenRefreshPromise) return tokenRefreshPromise;

  tokenRefreshPromise = new Promise((resolve, reject) => {
    if (!tokenClient) {
      tokenRefreshPromise = null;
      return reject(new Error('Google Auth клиент не готов'));
    }

    const emailHint = localStorage.getItem('gdocs_user_email') || '';
    const prevCallback = tokenClient.callback;

    // Жесткий таймаут: фоновые тихие запросы без клика браузер блокирует за 0.1с,
    // поэтому не даём промису зависнуть дольше 3.5 секунд. Для интерактивных кликов ждём до 60 секунд.
    const timeoutMs = interactive ? 60000 : 3500;
    const timeoutId = setTimeout(() => {
      tokenClient.callback = prevCallback;
      tokenRefreshPromise = null;
      reject(new Error('Время ожидания ответа Google истекло (окно заблокировано браузером)'));
    }, timeoutMs);

    tokenClient.callback = (resp) => {
      clearTimeout(timeoutId);
      tokenClient.callback = prevCallback;
      tokenRefreshPromise = null;

      if (resp.error) {
        reject(new Error(resp.error));
        return;
      }

      handleTokenResponse(resp);
      resolve(resp.access_token);
    };

    try {
      tokenClient.requestAccessToken({
        prompt: '', // Пустая строка = без повторного окна согласия/разрешений!
        hint: emailHint
      });
    } catch (err) {
      clearTimeout(timeoutId);
      tokenClient.callback = prevCallback;
      tokenRefreshPromise = null;
      reject(err);
    }
  });

  return tokenRefreshPromise;
}

// Планирование обновления токена за 5 минут до истечения
function scheduleTokenRefresh(delayMs) {
  clearTimeout(refreshTimer);
  const timeLeft = Number(tokenExpiresAt) - Date.now();
  const delay = typeof delayMs === 'number' ? delayMs : Math.max(10000, timeLeft - 5 * 60 * 1000);

  refreshTimer = setTimeout(async () => {
    if (accessToken) {
      console.log('Плановое обновление токена Google за 5 минут до истечения...');
      try {
        await requestFreshToken(false);
      } catch (err) {
        console.warn('Фоновое обновление токена отложено до действия пользователя:', err);
      }
    }
  }, delay);
}

// Показ и скрытие баннера истекшей сессии
function showSessionExpiredBanner() {
  if (sessionBanner) {
    sessionBanner.classList.remove('hidden');
  }
}

function hideSessionExpiredBanner() {
  if (sessionBanner) {
    sessionBanner.classList.add('hidden');
  }
}

// Интерактивное обновление сессии по клику пользователя (гарантированный user gesture)
async function renewSessionInteractive() {
  try {
    if (sessionRenewBtn) {
      sessionRenewBtn.disabled = true;
      sessionRenewBtn.textContent = 'Обновление...';
    }
    setSyncStatus('saving', 'Обновление сессии...');
    await requestFreshToken(true);
    hideSessionExpiredBanner();
    showToast('Сессия успешно обновлена!', 'success');

    if (activeNote && isDirty) {
      await saveActiveNote();
    } else {
      setSyncStatus('saved', 'Сохранено');
    }
  } catch (err) {
    console.error('Ошибка ручного обновления сессии:', err);
    showToast('Не удалось обновить сессию: ' + err.message, 'error');
    setSyncStatus('error', 'Сессия истекла — нажмите для сохранения');
  } finally {
    if (sessionRenewBtn) {
      sessionRenewBtn.disabled = false;
      sessionRenewBtn.textContent = 'Обновить сессию';
    }
  }
}

if (sessionRenewBtn) {
  sessionRenewBtn.addEventListener('click', renewSessionInteractive);
}

syncStatusEl.addEventListener('click', () => {
  if (syncStatusEl.classList.contains('error')) {
    renewSessionInteractive();
  }
});

// --- Инициализация Google Identity Services ---
async function initGoogleAuth() {
  if (typeof google === 'undefined') {
    setTimeout(initGoogleAuth, 100);
    return;
  }

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: handleTokenResponse,
  });

  // 1. Проверяем, есть ли действующий токен в памяти
  if (accessToken && Date.now() < Number(tokenExpiresAt)) {
    scheduleTokenRefresh();
    onAuthenticated();
    return;
  }

  // 2. Если токен истёк, но пользователь ранее уже авторизовывался (есть email)
  const savedEmail = localStorage.getItem('gdocs_user_email');
  if (savedEmail) {
    try {
      console.log('Попытка тихого восстановления сессии для:', savedEmail);
      await requestFreshToken(false);
      return;
    } catch (err) {
      console.log('Тихое восстановление сессии отклонено браузером (требуется клик):', err.message);
    }
  }

  showAuthScreen();
}

function handleLogin() {
  if (!tokenClient) return;
  const emailHint = localStorage.getItem('gdocs_user_email') || '';
  tokenClient.requestAccessToken({
    prompt: '',
    hint: emailHint
  });
}

function handleTokenResponse(resp) {
  if (resp.error) {
    console.error('Ошибка авторизации:', resp);
    if (resp.error !== 'popup_closed_by_user' && resp.error !== 'popup_blocked_by_browser') {
      alert('Не удалось авторизоваться в Google: ' + resp.error);
    }
    return;
  }
  accessToken = resp.access_token;
  tokenExpiresAt = Date.now() + (resp.expires_in * 1000);
  localStorage.setItem('gdocs_access_token', accessToken);
  localStorage.setItem('gdocs_token_expires', tokenExpiresAt);
  hideSessionExpiredBanner();
  scheduleTokenRefresh((resp.expires_in - 300) * 1000);
  onAuthenticated();
}

function handleLogout() {
  accessToken = null;
  tokenExpiresAt = 0;
  clearTimeout(refreshTimer);
  localStorage.removeItem('gdocs_access_token');
  localStorage.removeItem('gdocs_token_expires');
  localStorage.removeItem('gdocs_user_email');
  localStorage.removeItem('gdocs_user_name');
  localStorage.removeItem('gdocs_user_picture');
  hideSessionExpiredBanner();
  showAuthScreen();
}

async function onAuthenticated() {
  authScreen.classList.add('hidden');
  mainScreen.classList.remove('hidden');
  await fetchUserProfile();
  await ensureAppFolder();
  await loadNotes();
}

function showAuthScreen() {
  authScreen.classList.remove('hidden');
  mainScreen.classList.add('hidden');
}

// --- Google API Helper ---
async function apiFetch(url, options = {}, isRetry = false) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    ...(options.headers || {})
  };

  const response = await fetch(url, { ...options, headers });

  // При истечении сессии (401) не разлогиниваемся, а пробуем тихо обновить токен и повторить запрос
  if (response.status === 401 && !isRetry) {
    console.warn('Токен Google истек (401). Попытка автоматического обновления токена...');
    try {
      await requestFreshToken(false);
      return await apiFetch(url, options, true);
    } catch (err) {
      console.warn('Тихое фоновое обновление токена отклонено браузером (требуется клик):', err.message);
      showSessionExpiredBanner();
      setSyncStatus('error', 'Сессия истекла — нажмите для сохранения');
      throw new Error('Сессия Google истекла. Нажмите «Обновить сессию», чтобы сохранить данные.');
    }
  }

  if (response.status === 401 && isRetry) {
    showSessionExpiredBanner();
    setSyncStatus('error', 'Сессия истекла — нажмите для сохранения');
    throw new Error('Сессия истекла. Пожалуйста, обновите вход.');
  }

  if (!response.ok) {
    const errorText = await response.text();
    let errorMsg = `Ошибка API (${response.status}): ${response.statusText}`;
    try {
      const errJson = JSON.parse(errorText);
      if (errJson.error?.message) {
        errorMsg = errJson.error.message;
      }
    } catch (_) {
      if (errorText) errorMsg += ` - ${errorText}`;
    }
    throw new Error(errorMsg);
  }
  return response;
}

// --- Загрузка профиля пользователя ---
async function fetchUserProfile() {
  try {
    const res = await apiFetch('https://www.googleapis.com/oauth2/v3/userinfo');
    const user = await res.json();
    userName.textContent = user.name || 'Пользователь';
    userEmail.textContent = user.email || '';
    if (user.email) {
      localStorage.setItem('gdocs_user_email', user.email);
    }
    if (user.name) {
      localStorage.setItem('gdocs_user_name', user.name);
    }
    if (user.picture) {
      userAvatar.src = user.picture;
      localStorage.setItem('gdocs_user_picture', user.picture);
    }
  } catch (err) {
    console.error('Ошибка загрузки профиля:', err);
  }
}

// --- Поиск или создание папки заметок на Google Диске ---
async function ensureAppFolder() {
  try {
    const q = `name = '${FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const res = await apiFetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`);
    const data = await res.json();

    if (data.files && data.files.length > 0) {
      notesFolderId = data.files[0].id;
    } else {
      const createRes = await apiFetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: FOLDER_NAME,
          mimeType: 'application/vnd.google-apps.folder'
        })
      });
      const created = await createRes.json();
      notesFolderId = created.id;
    }
  } catch (err) {
    console.error('Ошибка при поиске папки заметок:', err);
  }
}

// --- Загрузка списка заметок ---
async function loadNotes() {
  notesLoadingEl.classList.remove('hidden');
  notesListEl.innerHTML = '';
  try {
    const q = `'${notesFolderId}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.document'`;
    const res = await apiFetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime,webViewLink)`);
    const data = await res.json();

    notesList = data.files || [];
    renderNotesList();
  } catch (err) {
    console.error('Ошибка загрузки списка заметок:', err);
    notesListEl.innerHTML = '<li class="status-msg">Не удалось загрузить заметки.</li>';
  } finally {
    notesLoadingEl.classList.add('hidden');
  }
}

function renderNotesList(filterText = '') {
  notesListEl.innerHTML = '';
  const filtered = notesList.filter(n => (n.name || '').toLowerCase().includes(filterText.toLowerCase()));

  if (filtered.length === 0) {
    notesListEl.innerHTML = '<li class="status-msg">Заметок пока нет</li>';
    return;
  }

  filtered.forEach(note => {
    const li = document.createElement('li');
    li.className = `note-item ${activeNote && activeNote.id === note.id ? 'active' : ''}`;
    li.dataset.noteId = note.id;
    
    const date = note.modifiedTime ? new Date(note.modifiedTime).toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    }) : '';

    li.innerHTML = `
      <div class="note-item-title">${escapeHtml(note.name || 'Без названия')}</div>
      <div class="note-item-date">${date}</div>
    `;

    li.addEventListener('click', () => selectNote(note));
    notesListEl.appendChild(li);
  });
}

// --- Создание новой заметки ---
async function createNewNote() {
  if (activeNote && isDirty && !isLoadingNote) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
    flushCurrentNoteSave();
  } else {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }

  setSyncStatus('saving', 'Создание заметки...');
  try {
    const defaultTitle = 'Новая заметка';
    const res = await apiFetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: defaultTitle,
        mimeType: 'application/vnd.google-apps.document',
        parents: [notesFolderId]
      })
    });
    const newFile = await res.json();

    notesList.unshift(newFile);
    renderNotesList(searchInput.value);
    await selectNote(newFile);
    noteTitleInput.focus();
    noteTitleInput.select();
    showToast('Новая заметка создана', 'success');
  } catch (err) {
    console.error('Ошибка создания заметки:', err);
    setSyncStatus('error', 'Ошибка при создании');
    showToast('Ошибка при создании заметки', 'error');
  }
}

// --- Парсинг цвета из CSS строки (rgb, rgba, hex) ---
function parseRgbString(str) {
  if (!str) return null;
  const match = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (match) {
    return {
      red: parseInt(match[1], 10) / 255,
      green: parseInt(match[2], 10) / 255,
      blue: parseInt(match[3], 10) / 255
    };
  }
  const hexMatch = str.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (hexMatch) {
    return {
      red: parseInt(hexMatch[1], 16) / 255,
      green: parseInt(hexMatch[2], 16) / 255,
      blue: parseInt(hexMatch[3], 16) / 255
    };
  }
  return null;
}

// --- Определение типа цветового выделения ---
function detectHighlightType(rgb) {
  if (!rgb) return null;
  const r = rgb.red ?? 0;
  const g = rgb.green ?? 0;
  const b = rgb.blue ?? 0;

  // Белый, прозрачный или почти белый
  if (r >= 0.98 && g >= 0.98 && b >= 0.98) return null;

  // Зелёный (Выполнено): g ощутимо выше r и b
  if (g > 0.65 && g > r + 0.05 && g > b + 0.04) {
    return 'done';
  }

  // Жёлтый (Отложено): высокие r и g, заметно меньший b
  if (r > 0.7 && g > 0.65 && b < 0.75 && Math.abs(r - g) < 0.25) {
    return 'pending';
  }

  // Красный (Отменено): r ощутимо выше g и b
  if (r > 0.7 && r > g + 0.08 && r > b + 0.08) {
    return 'cancelled';
  }

  return 'custom';
}

// --- Отображение документа из Google Docs в редакторе ---
function renderDocToEditor(doc) {
  if (!doc.body || !doc.body.content) {
    return '<div><br></div>';
  }

  let html = '';
  for (const item of doc.body.content) {
    if (!item.paragraph || !item.paragraph.elements) continue;

    let lineHtml = '';
    for (const el of item.paragraph.elements) {
      if (!el.textRun || !el.textRun.content) continue;

      let content = el.textRun.content;
      content = content.replace(/\n$/, '');
      if (content.length === 0) continue;

      const escaped = escapeHtml(content).replace(/\n/g, '<br>');
      const bgRgb = el.textRun.textStyle?.backgroundColor?.color?.rgbColor;
      const hlType = detectHighlightType(bgRgb);

      if (hlType === 'done') {
        lineHtml += `<span style="background-color: rgb(183, 225, 205);">${escaped}</span>`;
      } else if (hlType === 'pending') {
        lineHtml += `<span style="background-color: rgb(252, 232, 178);">${escaped}</span>`;
      } else if (hlType === 'cancelled') {
        lineHtml += `<span style="background-color: rgb(244, 199, 195);">${escaped}</span>`;
      } else if (hlType === 'custom') {
        const r = Math.round((bgRgb.red || 0) * 255);
        const g = Math.round((bgRgb.green || 0) * 255);
        const b = Math.round((bgRgb.blue || 0) * 255);
        lineHtml += `<span style="background-color: rgb(${r},${g},${b});">${escaped}</span>`;
      } else {
        lineHtml += `<span class="hl-plain">${escaped}</span>`;
      }
    }

    if (!lineHtml) {
      lineHtml = '<br>';
    }

    html += `<div>${lineHtml}</div>`;
  }

  return html || '<div><br></div>';
}

// --- Извлечение текста и диапазонов цветового выделения для сохранения в Google Docs ---
function extractContentAndHighlights(container) {
  if (!container || container.classList.contains('editor-disabled')) {
    return { text: '', highlights: [] };
  }
  let fullText = '';
  const highlights = [];

  function getHighlightStyle(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    const bg = el.style?.backgroundColor;
    if (bg && bg !== 'transparent' && bg !== 'inherit' && bg !== 'rgba(0, 0, 0, 0)') {
      const rgb = parseRgbString(bg);
      if (rgb) {
        const type = detectHighlightType(rgb);
        if (type === 'done') return { type: 'done', rgb: DOC_COLORS.done };
        if (type === 'pending') return { type: 'pending', rgb: DOC_COLORS.pending };
        if (type === 'cancelled') return { type: 'cancelled', rgb: DOC_COLORS.cancelled };
        if (type === 'custom') return { type: 'custom', rgb };
      }
    }
    if (el.classList.contains('hl-done')) return { type: 'done', rgb: DOC_COLORS.done };
    if (el.classList.contains('hl-pending')) return { type: 'pending', rgb: DOC_COLORS.pending };
    if (el.classList.contains('hl-cancelled')) return { type: 'cancelled', rgb: DOC_COLORS.cancelled };
    return null;
  }

  function traverse(node, currentHl = null) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue;
      if (text.length > 0) {
        const start = fullText.length;
        fullText += text;
        const end = fullText.length;
        if (currentHl && currentHl.rgb) {
          highlights.push({
            start,
            end,
            type: currentHl.type,
            rgb: currentHl.rgb
          });
        }
      }
      return;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'br') {
        fullText += '\n';
        return;
      }

      const hl = getHighlightStyle(node) || currentHl;
      const isBlock = ['div', 'p', 'li', 'h1', 'h2', 'h3'].includes(tag);

      if (isBlock && fullText.length > 0 && !fullText.endsWith('\n')) {
        fullText += '\n';
      }

      for (let child = node.firstChild; child; child = child.nextSibling) {
        traverse(child, hl);
      }
    }
  }

  for (let child = container.firstChild; child; child = child.nextSibling) {
    traverse(child, null);
  }

  // Объединяем смежные диапазоны одного цвета
  const merged = [];
  for (const h of highlights) {
    if (merged.length > 0) {
      const last = merged[merged.length - 1];
      if (last.end === h.start && last.type === h.type) {
        last.end = h.end;
        continue;
      }
    }
    merged.push({ ...h });
  }

  return { text: fullText, highlights: merged };
}

// --- Выбор и загрузка заметки ---
async function selectNote(note) {
  if (!note) return;

  // Если кликнули на уже открытую заметку, которая не находится в процессе загрузки - ничего не делаем
  if (activeNote && activeNote.id === note.id && !isLoadingNote) {
    return;
  }

  // 1. Если у текущей открытой заметки есть несохранённые правки - немедленно отправляем их в очередь сохранения
  if (activeNote && isDirty && !isLoadingNote) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
    flushCurrentNoteSave();
  } else {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }

  // 2. Инкрементируем токен загрузки, чтобы отменить/проигнорировать любые запаздывающие ответы от других заметок
  const currentToken = ++noteLoadToken;

  activeNote = note;
  isLoadingNote = true;
  isDirty = false;
  renderNotesList(searchInput.value);

  editorEmpty.classList.add('hidden');
  editorActive.classList.remove('hidden');

  noteTitleInput.value = note.name || '';
  noteBodyInput.innerHTML = '<div style="color: var(--text-light);">Загрузка содержимого...</div>';
  setEditorEditable(false);
  openInDocsBtn.href = note.webViewLink || `https://docs.google.com/document/d/${note.id}/edit`;

  setSyncStatus('saving', 'Загрузка...');

  try {
    // Если для целевой заметки в данный момент ещё идёт фоновое сохранение, ждём его завершения
    const existingSave = saveQueueByNoteId.get(note.id);
    if (existingSave?.promise) {
      await existingSave.promise;
    }

    // Проверяем, не переключился ли пользователь на другую заметку, пока ждали
    if (currentToken !== noteLoadToken || activeNote?.id !== note.id) {
      return;
    }

    const res = await apiFetch(`https://docs.googleapis.com/v1/documents/${note.id}`);
    const doc = await res.json();

    // Повторная проверка актуальности ответа
    if (currentToken !== noteLoadToken || activeNote?.id !== note.id) {
      return;
    }

    const localDraft = getLocalDraft(note.id);
    const serverModified = new Date(note.modifiedTime || 0).getTime();

    if (localDraft && localDraft.html && localDraft.timestamp > serverModified) {
      console.log(`Обнаружен несохранённый локальный черновик для заметки ${note.id}`);
      noteTitleInput.value = localDraft.title || note.name || '';
      noteBodyInput.innerHTML = localDraft.html;
      setEditorEditable(true);
      setFilter('all');
      updateNoteStats();
      isLoadingNote = false;
      isDirty = true;
      setSyncStatus('error', 'Черновик восстановлен — сохраните');
      showToast('Восстановлены несохранённые изменения из локального черновика', 'info');
    } else {
      noteBodyInput.innerHTML = renderDocToEditor(doc);
      setEditorEditable(true);
      setFilter('all');
      updateNoteStats();
      isLoadingNote = false;
      isDirty = false;
      setSyncStatus('saved', 'Загружено');
      clearLocalDraft(note.id);
    }
  } catch (err) {
    if (currentToken !== noteLoadToken || activeNote?.id !== note.id) {
      return;
    }
    console.error('Ошибка чтения Google Docs:', err);
    noteBodyInput.innerHTML = '<div style="color: var(--danger);">Ошибка при чтении документа Google Docs.</div>';
    setEditorEditable(false);
    isLoadingNote = false;
    isDirty = false;
    setSyncStatus('error', 'Ошибка чтения');
  }
}

function setEditorEditable(editable) {
  noteBodyInput.contentEditable = editable ? 'true' : 'false';
  if (!editable) {
    noteBodyInput.classList.add('editor-disabled');
  } else {
    noteBodyInput.classList.remove('editor-disabled');
  }
}

// --- Управление очередью сохранения и сохранение в Google Docs ---

function hasPendingSave(noteId) {
  return saveQueueByNoteId.has(noteId);
}

// Мгновенный сброс текущего состояния открытой заметки в очередь сохранения
function flushCurrentNoteSave() {
  if (!activeNote || isLoadingNote || noteBodyInput.classList.contains('editor-disabled')) return null;

  const noteToSave = activeNote;
  const newTitle = noteTitleInput.value.trim() || 'Без названия';
  const { text: newContent, highlights } = extractContentAndHighlights(noteBodyInput);

  isDirty = false;
  return queueNoteSave(noteToSave, newTitle, newContent, highlights);
}

// Постановка сохранения заметки в очередь с изоляцией по ID
function queueNoteSave(noteToSave, newTitle, newContent, highlights) {
  const noteId = noteToSave.id;
  let queueItem = saveQueueByNoteId.get(noteId);

  if (queueItem) {
    // Сохранение этой заметки уже выполняется. Обновляем отложенные данные до самых свежих
    queueItem.pending = { newTitle, newContent, highlights };
    return queueItem.promise;
  }

  // Создаём новую задачу сохранения для этого noteId
  queueItem = {
    pending: null,
    promise: null
  };
  saveQueueByNoteId.set(noteId, queueItem);

  if (activeNote?.id === noteId) {
    setSyncStatus('saving', 'Сохранение...');
  }

  const runQueue = async (title, content, hls) => {
    try {
      await performSave(noteToSave, title, content, hls);
    } catch (err) {
      console.error(`Ошибка при сохранении заметки ${noteId}:`, err);
    }

    if (queueItem.pending) {
      const next = queueItem.pending;
      queueItem.pending = null;
      await runQueue(next.newTitle, next.newContent, next.highlights);
    } else {
      saveQueueByNoteId.delete(noteId);
    }
  };

  queueItem.promise = runQueue(newTitle, newContent, highlights);
  return queueItem.promise;
}

// Непосредственное выполнение сохранения конкретной заметки в Google Docs и Drive
async function performSave(noteToSave, newTitle, newContent, highlights) {
  const noteId = noteToSave.id;

  try {
    // 1. Получаем текущую длину документа в Google Docs
    const docRes = await apiFetch(`https://docs.googleapis.com/v1/documents/${noteId}`);
    const doc = await docRes.json();
    const docLength = doc.body?.content?.slice(-1)[0]?.endIndex || 1;

    const requests = [];

    // Очищаем предыдущий текст
    if (docLength > 2) {
      requests.push({
        deleteContentRange: {
          range: {
            startIndex: 1,
            endIndex: docLength - 1
          }
        }
      });
    }

    // Вставляем новый текст
    if (newContent.length > 0) {
      requests.push({
        insertText: {
          location: { index: 1 },
          text: newContent
        }
      });

      // Сбрасываем фоновое выделение для всего текста
      requests.push({
        updateTextStyle: {
          range: {
            startIndex: 1,
            endIndex: 1 + newContent.length
          },
          textStyle: {},
          fields: 'backgroundColor'
        }
      });

      // Применяем цветовые выделения
      for (const h of highlights) {
        if (h.end > h.start && h.rgb) {
          requests.push({
            updateTextStyle: {
              range: {
                startIndex: 1 + h.start,
                endIndex: Math.min(1 + h.end, 1 + newContent.length)
              },
              textStyle: {
                backgroundColor: {
                  color: {
                    rgbColor: {
                      red: h.rgb.red,
                      green: h.rgb.green,
                      blue: h.rgb.blue
                    }
                  }
                }
              },
              fields: 'backgroundColor'
            }
          });
        }
      }
    }

    // Отправляем пакетное обновление содержимого
    if (requests.length > 0) {
      await apiFetch(`https://docs.googleapis.com/v1/documents/${noteId}:batchUpdate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests })
      });
    }

    // 2. Обновляем имя файла на Диске, если заголовок изменился
    if (newTitle !== noteToSave.name) {
      await apiFetch(`https://www.googleapis.com/drive/v3/files/${noteId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newTitle })
      });
      noteToSave.name = newTitle;
    }

    noteToSave.modifiedTime = new Date().toISOString();

    const listItem = notesList.find(n => n.id === noteId);
    if (listItem) {
      listItem.name = newTitle;
      listItem.modifiedTime = noteToSave.modifiedTime;
    }

    renderNotesList(searchInput.value);

    // Очищаем локальный черновик после успешного сохранения в облаке
    clearLocalDraft(noteId);

    // Если эта заметка всё ещё открыта в редакторе, обновляем статус и статистику
    if (activeNote && activeNote.id === noteId) {
      setSyncStatus('saved', 'Сохранено');
      updateNoteStats();
    }
  } catch (err) {
    console.error(`Ошибка сохранения заметки (${noteId}):`, err);
    if (activeNote && activeNote.id === noteId) {
      if (err.message && err.message.includes('Сессия')) {
        setSyncStatus('error', 'Сессия истекла — нажмите для сохранения');
        showSessionExpiredBanner();
      } else {
        setSyncStatus('error', 'Ошибка сохранения');
        showToast('Ошибка сохранения в Google Docs: ' + err.message, 'error');
      }
    }
    throw err;
  }
}

// Автосохранение активной заметки
async function saveActiveNote() {
  if (!activeNote || isLoadingNote) return;

  if (!isDirty && !hasPendingSave(activeNote.id)) {
    setSyncStatus('saved', 'Сохранено');
    return;
  }

  clearTimeout(saveTimeout);
  saveTimeout = null;

  return flushCurrentNoteSave();
}

// Ручное сохранение по кнопке "Сохранить", Ctrl+S или из контекстного меню
async function manualSave() {
  if (!activeNote) {
    showToast('Нет открытой заметки для сохранения', 'info');
    return;
  }
  if (isLoadingNote) {
    showToast('Заметка ещё загружается...', 'info');
    return;
  }
  clearTimeout(saveTimeout);
  saveTimeout = null;

  // Если сессия истекла или токен недействителен, ручное сохранение запускает интерактивное продление
  if (!accessToken || Date.now() >= Number(tokenExpiresAt)) {
    console.log('Ручное сохранение при истёкшей сессии: интерактивное обновление токена...');
    await renewSessionInteractive();
    return;
  }

  saveActiveNote();
}

// Отложенное сохранение (debounce 1 сек)
function scheduleSave() {
  if (!activeNote || isLoadingNote) return;
  isDirty = true;
  saveLocalDraft(activeNote.id, noteTitleInput.value, noteBodyInput.innerHTML);
  setSyncStatus('saving', 'Сохранение...');
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveActiveNote, 1000);
}

// --- Удаление заметки ---
async function deleteActiveNote() {
  if (!activeNote) return;
  const noteToDelete = activeNote;
  const confirmDelete = confirm(`Удалить заметку "${noteToDelete.name}"? Она переместится в корзину Google Диска.`);
  if (!confirmDelete) return;

  clearTimeout(saveTimeout);
  saveTimeout = null;
  isDirty = false;

  const queueItem = saveQueueByNoteId.get(noteToDelete.id);
  if (queueItem) {
    queueItem.pending = null;
  }

  setSyncStatus('saving', 'Удаление...');
  try {
    await apiFetch(`https://www.googleapis.com/drive/v3/files/${noteToDelete.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true })
    });

    notesList = notesList.filter(n => n.id !== noteToDelete.id);
    if (activeNote?.id === noteToDelete.id) {
      activeNote = null;
      editorActive.classList.add('hidden');
      editorEmpty.classList.remove('hidden');
    }
    renderNotesList(searchInput.value);
    setSyncStatus('saved', 'Удалено');
    showToast('Заметка перемещена в корзину', 'info');
  } catch (err) {
    console.error('Ошибка удаления:', err);
    setSyncStatus('error', 'Не удалось удалить');
    showToast('Не удалось удалить заметку', 'error');
  }
}

// --- Применение цветового выделения (поддерживает многострочное выделение и нативный Ctrl+Z) ---
function applyStatus(targetStatus) {
  if (!activeNote || isLoadingNote) return;

  noteBodyInput.focus();
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  let range = sel.getRangeAt(0);

  // Если курсор/выделение вне редактора — переносим в конец текста
  if (!noteBodyInput.contains(range.commonAncestorContainer)) {
    const newRange = document.createRange();
    newRange.selectNodeContents(noteBodyInput);
    newRange.collapse(false);
    sel.removeAllRanges();
    sel.addRange(newRange);
    range = newRange;
  }

  // Если текст не выделен (курсор просто стоит в строке) — выделяем текущую строку
  if (range.collapsed) {
    let block = range.startContainer;
    while (block && block.parentElement && block.parentElement !== noteBodyInput) {
      block = block.parentElement;
    }
    if (block && block !== noteBodyInput) {
      const lineRange = document.createRange();
      lineRange.selectNodeContents(block);
      sel.removeAllRanges();
      sel.addRange(lineRange);
      range = lineRange;
    }
  }

  // Включаем форматирование через CSS-стили (сохраняет Undo/Redo стек браузера)
  document.execCommand('styleWithCSS', false, true);

  if (targetStatus === 'clear') {
    document.execCommand('hiliteColor', false, 'transparent');
  } else {
    // Проверяем: если уже активен этот же статус — снимаем его (toggle)
    let container = range.commonAncestorContainer;
    if (container.nodeType === 3) container = container.parentElement;
    const computedBg = window.getComputedStyle(container).backgroundColor;
    const currentType = detectHighlightType(parseRgbString(computedBg));

    if (currentType === targetStatus) {
      document.execCommand('hiliteColor', false, 'transparent');
    } else {
      document.execCommand('hiliteColor', false, STATUS_COLORS[targetStatus]);
    }
  }

  scheduleSave();
  applyFilterToEditor();
  updateNoteStats();
}

// --- Фильтрация строк по статусу ---
let currentFilter = 'all';

function setFilter(filterType) {
  currentFilter = filterType;

  const statTiles = document.querySelectorAll('.stat-tile');
  statTiles.forEach(tile => {
    if (tile.dataset.filter === filterType && filterType !== 'all') {
      tile.classList.add('active');
    } else {
      tile.classList.remove('active');
    }
  });

  applyFilterToEditor();
}

// --- Безопасный для Undo/Redo и DOM анализ сегментов подсветки ---
function getDirectHighlightType(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
  const bg = el.style?.backgroundColor;
  if (bg && bg !== 'transparent' && bg !== 'inherit' && bg !== 'rgba(0, 0, 0, 0)') {
    const rgb = parseRgbString(bg);
    const type = detectHighlightType(rgb);
    if (type) return type;
  }
  if (el.classList.contains('hl-done')) return 'done';
  if (el.classList.contains('hl-pending')) return 'pending';
  if (el.classList.contains('hl-cancelled')) return 'cancelled';
  return null;
}

function getHighlightTypeOfNode(node, container) {
  let curr = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  while (curr && curr !== container && curr !== noteBodyInput) {
    const bg = curr.style?.backgroundColor;
    if (bg && bg !== 'transparent' && bg !== 'inherit' && bg !== 'rgba(0, 0, 0, 0)') {
      const rgb = parseRgbString(bg);
      const type = detectHighlightType(rgb);
      if (type) return type;
    }
    if (curr.classList.contains('hl-done')) return 'done';
    if (curr.classList.contains('hl-pending')) return 'pending';
    if (curr.classList.contains('hl-cancelled')) return 'cancelled';
    curr = curr.parentElement;
  }
  return 'clear';
}

function getSegmentsOfNodes(nodes, container) {
  const segments = [];

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue || '';
      if (text.length > 0) {
        const type = getHighlightTypeOfNode(node, container);
        if (segments.length > 0 && segments[segments.length - 1].type === type) {
          segments[segments.length - 1].text += text;
        } else {
          segments.push({ type, text });
        }
      }
      return;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.tagName.toLowerCase() === 'br') return;
      for (let child = node.firstChild; child; child = child.nextSibling) {
        walk(child);
      }
    }
  }

  nodes.forEach(walk);
  return segments;
}

// 100% Read-Only: извлекает реальные строки редактора (включая текстовые узлы и блоки)
function getLinesFromEditor(container) {
  const lines = [];
  let currentInlineLine = [];

  function flushInline() {
    if (currentInlineLine.length > 0) {
      const line = {
        isBlock: false,
        nodes: currentInlineLine
      };
      line.segments = getSegmentsOfNodes(currentInlineLine, container);
      lines.push(line);
      currentInlineLine = [];
    }
  }

  Array.from(container.childNodes).forEach(node => {
    if (node.nodeType === Node.ELEMENT_NODE && (node.classList.contains('editor-bottom-spacer') || node.classList.contains('notes-list-bottom-spacer'))) {
      return;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'div' || tag === 'p' || tag === 'li' || tag.startsWith('h')) {
        flushInline();
        const line = {
          isBlock: true,
          element: node,
          nodes: [node]
        };
        line.segments = getSegmentsOfNodes([node], container);
        lines.push(line);
        return;
      }
      if (tag === 'br') {
        flushInline();
        return;
      }
    }
    currentInlineLine.push(node);
  });

  flushInline();
  return lines;
}

function applyFilterToEditor() {
  const lines = getLinesFromEditor(noteBodyInput);
  if (lines.length === 0) return;

  // 1. Всегда сбрасываем ранее скрытые фильтром отдельные сегменты текста
  noteBodyInput.querySelectorAll('[data-filter-hidden]').forEach(el => {
    el.style.display = '';
    delete el.dataset.filterHidden;
  });

  // 2. Если выбран фильтр "Все" — отображаем все строки целиком
  if (currentFilter === 'all') {
    lines.forEach(line => {
      if (line.isBlock) {
        line.element.style.display = '';
      }
    });
    return;
  }

  // 3. Фильтрация по конкретному статусу
  lines.forEach(line => {
    const text = line.segments.map(s => s.text).join('').trim();
    if (!text) {
      if (line.isBlock) line.element.style.display = 'none';
      return;
    }

    const hasMatchingText = line.segments.some(seg => {
      const match = (currentFilter === 'clear' && seg.type === 'clear') || (currentFilter === seg.type);
      return match && seg.text.trim().length > 0;
    });

    if (!hasMatchingText) {
      if (line.isBlock) {
        line.element.style.display = 'none';
      } else {
        line.nodes.forEach(n => {
          if (n.nodeType === Node.ELEMENT_NODE) {
            n.style.display = 'none';
            n.dataset.filterHidden = 'true';
          }
        });
      }
      return;
    }

    if (line.isBlock) {
      line.element.style.display = '';
    } else {
      line.nodes.forEach(n => {
        if (n.nodeType === Node.ELEMENT_NODE) {
          n.style.display = '';
          delete n.dataset.filterHidden;
        }
      });
    }

    const hasNonMatchingText = line.segments.some(seg => {
      const match = (currentFilter === 'clear' && seg.type === 'clear') || (currentFilter === seg.type);
      return !match && seg.text.trim().length > 0;
    });

    if (!hasNonMatchingText) {
      return;
    }

    // Многоцветная строка: скрываем только неподходящие span-элементы через CSS display (без изменения DOM-узлов)
    const container = line.isBlock ? line.element : noteBodyInput;
    const childSpans = Array.from(container.querySelectorAll ? container.querySelectorAll('span, font') : []);
    childSpans.forEach(el => {
      if (!line.isBlock && !line.nodes.includes(el) && !line.nodes.some(n => n.contains && n.contains(el))) return;
      const bg = el.style?.backgroundColor;
      const hasBg = bg && bg !== 'transparent' && bg !== 'inherit' && bg !== 'rgba(0, 0, 0, 0)';
      const isPlain = el.classList.contains('hl-plain');
      const isStatus = el.classList.contains('hl-done') || el.classList.contains('hl-pending') || el.classList.contains('hl-cancelled');

      if (hasBg || isPlain || isStatus) {
        const type = getDirectHighlightType(el) || 'clear';
        const matches = (currentFilter === 'clear' && type === 'clear') || (currentFilter === type);
        if (!matches) {
          el.style.display = 'none';
          el.dataset.filterHidden = 'true';
        } else {
          el.style.display = '';
          delete el.dataset.filterHidden;
        }
      }
    });
  });
}

// --- Кастомное контекстное меню ---
function showCustomContextMenu(e) {
  const isInsideEditor = noteBodyInput.contains(e.target) || e.target === noteBodyInput;
  const isInsideTitle = noteTitleInput.contains(e.target) || e.target === noteTitleInput;
  const noteItem = e.target.closest('.note-item');

  // 1. Клик по конкретной заметке в списке слева:
  if (noteItem) {
    const targetNote = notesList.find(n => n.id === noteItem.dataset.noteId);
    if (targetNote && (!activeNote || activeNote.id !== targetNote.id)) {
      selectNote(targetNote);
    }
    // Для заметки в списке: показываем только действия с ней (без буфера обмена и без выделения)
    cmStatusSection.classList.add('hidden');
    cmClipboardSection.classList.add('hidden');
    cmNoteActionsSection.classList.remove('hidden');
  } 
  // 2. Клик внутри контента заметки (редактор или заголовок):
  else if (isInsideEditor || isInsideTitle) {
    // В контенте: убираем Сохранить, Новая заметка, В Google Docs, Удалить заметку
    cmNoteActionsSection.classList.add('hidden');
    cmClipboardSection.classList.remove('hidden');

    if (isInsideEditor && activeNote) {
      cmStatusSection.classList.remove('hidden');
    } else {
      cmStatusSection.classList.add('hidden');
    }
  } 
  // 3. В любом другом месте (мимо заметки в сайдбаре, пустое место и т.д.): меню не открывается
  else {
    hideCustomContextMenu();
    return;
  }

  // Позиционирование меню
  customContextMenu.style.visibility = 'hidden';
  customContextMenu.classList.remove('hidden');

  const menuWidth = customContextMenu.offsetWidth || 220;
  const menuHeight = customContextMenu.offsetHeight || 280;

  let x = e.clientX;
  let y = e.clientY;

  if (x + menuWidth > window.innerWidth) {
    x = window.innerWidth - menuWidth - 8;
  }
  if (y + menuHeight > window.innerHeight) {
    y = window.innerHeight - menuHeight - 8;
  }

  customContextMenu.style.left = `${Math.max(8, x)}px`;
  customContextMenu.style.top = `${Math.max(8, y)}px`;
  customContextMenu.style.visibility = 'visible';
}

function hideCustomContextMenu() {
  if (customContextMenu && !customContextMenu.classList.contains('hidden')) {
    customContextMenu.classList.add('hidden');
  }
}

// Клик по пунктам контекстного меню
customContextMenu.addEventListener('click', async (e) => {
  const item = e.target.closest('.context-menu-item');
  if (!item) return;

  const action = item.dataset.action;
  hideCustomContextMenu();

  switch (action) {
    case 'status-done':
      applyStatus('done');
      break;
    case 'status-pending':
      applyStatus('pending');
      break;
    case 'status-cancelled':
      applyStatus('cancelled');
      break;
    case 'status-clear':
      applyStatus('clear');
      break;
    case 'cut':
      document.execCommand('cut');
      scheduleSave();
      break;
    case 'copy':
      document.execCommand('copy');
      break;
    case 'paste':
      try {
        const text = await navigator.clipboard.readText();
        noteBodyInput.focus();
        document.execCommand('insertText', false, text);
        scheduleSave();
      } catch (err) {
        document.execCommand('paste');
        scheduleSave();
      }
      break;
    case 'save':
      manualSave();
      break;
    case 'new-note':
      createNewNote();
      break;
    case 'open-docs':
      if (activeNote) {
        window.open(activeNote.webViewLink || `https://docs.google.com/document/d/${activeNote.id}/edit`, '_blank');
      }
      break;
    case 'delete':
      if (activeNote) {
        deleteActiveNote();
      }
      break;
  }
});

// Закрытие контекстного меню
window.addEventListener('click', (e) => {
  if (!customContextMenu.contains(e.target)) {
    hideCustomContextMenu();
  }
});
window.addEventListener('scroll', hideCustomContextMenu, true);
window.addEventListener('resize', hideCustomContextMenu);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideCustomContextMenu();
  }
});

// Перехват клика правой кнопкой мыши по всему сайту
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  showCustomContextMenu(e);
});

// --- Плавающее уведомление (Toast) ---
function showToast(message, type = 'info') {
  const toast = document.getElementById('app-toast');
  if (!toast) return;

  toast.className = `app-toast toast-${type} visible`;
  toast.textContent = message;

  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => {
    toast.classList.remove('visible');
  }, 2400);
}

// --- Статус синхронизации в тулбаре ---
function setSyncStatus(state, text) {
  syncStatusEl.className = `sync-status ${state}`;
  syncStatusEl.querySelector('.status-text').textContent = text;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Обработка вставки чистого текста ---
noteBodyInput.addEventListener('paste', (e) => {
  if (isLoadingNote) {
    e.preventDefault();
    return;
  }
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain');
  if (document.queryCommandSupported('insertText')) {
    document.execCommand('insertText', false, text);
  } else {
    const sel = window.getSelection();
    if (sel.rangeCount) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
    }
  }
  scheduleSave();
});

// --- Слушатели событий интерфейса ---
loginBtn.addEventListener('click', handleLogin);
logoutBtn.addEventListener('click', handleLogout);
newNoteBtn.addEventListener('click', createNewNote);
manualSaveBtn.addEventListener('click', manualSave);
deleteNoteBtn.addEventListener('click', deleteActiveNote);

// Кнопки панели форматирования: на mousedown предотвращаем снятие фокуса/выделения, на click применяем статус к выделенному тексту или строке
[toolBtnDone, toolBtnPending, toolBtnCancelled, toolBtnClear].forEach(btn => {
  if (!btn) return;
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    applyStatus(btn.dataset.status);
  });
});

noteTitleInput.addEventListener('input', () => {
  if (isLoadingNote) return;
  scheduleSave();
});
noteBodyInput.addEventListener('input', () => {
  if (isLoadingNote) return;
  scheduleSave();
  updateNoteStats();
});

// --- Подсчёт статистики и метрик заметки (100% Read-Only, без изменения DOM) ---
function updateNoteStats() {
  if (!activeNote) return;

  const lines = getLinesFromEditor(noteBodyInput);
  let doneCount = 0;
  let pendingCount = 0;
  let cancelledCount = 0;
  let clearCount = 0;
  let totalLines = 0;
  let totalWords = 0;
  let totalChars = 0;

  lines.forEach(line => {
    const fullLineText = line.segments.map(s => s.text).join('');
    const trimmed = fullLineText.trim();
    if (!trimmed) return;

    totalLines++;
    const words = trimmed.split(/\s+/).filter(w => w.length > 0);
    totalWords += words.length;
    totalChars += fullLineText.length;

    // Считаем каждый непрерывный участок текста со своим статусом
    line.segments.forEach(seg => {
      if (seg.text.trim().length === 0) return; // игнорируем чисто пробельные фрагменты
      if (seg.type === 'done') doneCount++;
      else if (seg.type === 'pending') pendingCount++;
      else if (seg.type === 'cancelled') cancelledCount++;
      else if (seg.type === 'clear') clearCount++;
    });
  });

  const totalTasks = doneCount + pendingCount + cancelledCount + clearCount;
  const percent = totalTasks > 0 ? Math.round((doneCount / totalTasks) * 100) : 0;

  const elAll = document.getElementById('stat-count-all');
  const elDone = document.getElementById('stat-count-done');
  const elPending = document.getElementById('stat-count-pending');
  const elCancelled = document.getElementById('stat-count-cancelled');
  const elClear = document.getElementById('stat-count-clear');

  if (elAll) elAll.textContent = totalTasks;
  const elPercent = document.getElementById('progress-percent-label');
  const barDone = document.getElementById('progress-bar-done');
  const barPending = document.getElementById('progress-bar-pending');
  const barCancelled = document.getElementById('progress-bar-cancelled');

  if (elDone) elDone.textContent = doneCount;
  if (elPending) elPending.textContent = pendingCount;
  if (elCancelled) elCancelled.textContent = cancelledCount;
  if (elClear) elClear.textContent = clearCount;

  if (elPercent) {
    elPercent.textContent = totalTasks > 0 ? `${percent}% выполнено (${doneCount}/${totalTasks})` : 'Нет задач';
  }

  if (barDone && barPending && barCancelled) {
    if (totalTasks > 0) {
      const pDone = (doneCount / totalTasks) * 100;
      const pPending = (pendingCount / totalTasks) * 100;
      const pCancelled = (cancelledCount / totalTasks) * 100;
      barDone.style.width = `${pDone}%`;
      barPending.style.width = `${pPending}%`;
      barCancelled.style.width = `${pCancelled}%`;
    } else {
      barDone.style.width = '0%';
      barPending.style.width = '0%';
      barCancelled.style.width = '0%';
    }
  }

  const elLines = document.getElementById('metric-lines-count');
  const elWords = document.getElementById('metric-words-count');
  const elChars = document.getElementById('metric-chars-count');
  if (elLines) elLines.textContent = totalLines;
  if (elWords) elWords.textContent = totalWords;
  if (elChars) elChars.textContent = totalChars;

}

// Интерактивные карточки статусов в боковой панели
document.querySelectorAll('.stat-tile').forEach(tile => {
  tile.addEventListener('click', () => {
    const filter = tile.dataset.filter;
    if (currentFilter === filter) {
      setFilter('all');
    } else {
      setFilter(filter);
    }
  });
});

// Очищаем старый ключ скрытия панели, если остался в localStorage
localStorage.removeItem('gdocs_stats_hidden');
if (editorSidebarRight) {
  editorSidebarRight.classList.remove('hidden');
}


searchInput.addEventListener('input', (e) => {
  renderNotesList(e.target.value);
});

// --- Глобальный перехват горячих клавиш ---
window.addEventListener('keydown', (e) => {
  const isCtrlOrMeta = e.ctrlKey || e.metaKey;

  // 1. Перехват Ctrl+S / Cmd+S (включая русскую раскладку 'ы')
  const isSKey = e.code === 'KeyS' || e.key.toLowerCase() === 's' || e.key.toLowerCase() === 'ы';
  if (isCtrlOrMeta && isSKey) {
    e.preventDefault();
    e.stopPropagation();
    manualSave();
    return;
  }

  // 2. Гарантированный Ctrl+Z / Ctrl+Я (Undo)
  const isZKey = e.code === 'KeyZ' || e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'я';
  if (isCtrlOrMeta && !e.shiftKey && isZKey) {
    if (e.key.toLowerCase() === 'я') {
      e.preventDefault();
      document.execCommand('undo');
      scheduleSave();
    }
    setTimeout(updateNoteStats, 30);
    return;
  }

  // 3. Гарантированный Ctrl+Y / Ctrl+Shift+Z (Redo) для русской раскладки
  const isYKey = e.code === 'KeyY' || e.key.toLowerCase() === 'y' || e.key.toLowerCase() === 'н';
  if (isCtrlOrMeta && (isYKey || (e.shiftKey && isZKey))) {
    if (e.key.toLowerCase() === 'н' || (e.shiftKey && e.key.toLowerCase() === 'я')) {
      e.preventDefault();
      document.execCommand('redo');
      scheduleSave();
      return;
    }
  }
}, { capture: true });

// Автоматическое продление токена во время активной работы пользователя
let lastActivityCheck = 0;
function checkAndRenewTokenOnActivity() {
  const now = Date.now();
  if (now - lastActivityCheck < 60000) return; // не чаще раза в минуту
  lastActivityCheck = now;

  if (accessToken && isTokenExpiringSoon()) {
    console.log('Токен истекает менее чем через 8 минут. Продление сессии по действию пользователя...');
    requestFreshToken(false).catch(err => {
      console.warn('Автопродление токена отложено:', err);
    });
  }
}

window.addEventListener('click', checkAndRenewTokenOnActivity, { passive: true });
window.addEventListener('keydown', checkAndRenewTokenOnActivity, { passive: true });

// Предупреждение перед закрытием вкладки, если есть несохранённые изменения
window.addEventListener('beforeunload', (e) => {
  if (isDirty || saveQueueByNoteId.size > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// --- Интерактивный маскот (Popcat эффект + rzhunemogu.ru API) ---
const mascotContainer = document.getElementById('mascot-container');
const mascotBubble = document.getElementById('mascot-bubble');
const mascotBubbleText = document.getElementById('mascot-bubble-text');
const mascotBubbleClose = document.getElementById('mascot-bubble-close');

if (mascotContainer) {
  const popSounds = ['pop1.mp3', 'pop2.mp3', 'pop3.mp3', 'pop4.mp3'].map(src => {
    const audio = new Audio(src);
    audio.preload = 'auto';
    return audio;
  });

  let lastSoundIdx = -1;
  function playPopSound() {
    let idx;
    do {
      idx = Math.floor(Math.random() * popSounds.length);
    } while (idx === lastSoundIdx && popSounds.length > 1);
    lastSoundIdx = idx;

    try {
      const sound = popSounds[idx].cloneNode();
      sound.volume = 0.65;
      sound.play().catch(() => {});
    } catch (_) {}
  }

  // Очередь предзагруженных шуток (CType 15: пошлые приколы, CType 18: пошлые статусы)
  const jokeQueue = [];
  let isPrefetching = false;
  let bubbleTimer = null;
  let isHoveringBubble = false;

  function scheduleBubbleHide(delayMs = 14000) {
    if (bubbleTimer) clearTimeout(bubbleTimer);
    if (isHoveringBubble) return; // не закрываем, пока курсор над облачком
    bubbleTimer = setTimeout(hideBubble, delayMs);
  }

  function cleanJokeText(text) {
    if (!text) return '';
    return text
      .replace(/^\d+\s*\(сохранена\s+[^)]+\)\s*/i, '') // убираем дату и id цитатника
      .trim();
  }

  async function fetchJokeItem() {
    const ctype = Math.random() < 0.5 ? 15 : 18;
    const res = await fetch(`https://rzhunemogu.ru/api/randjson?CType=${ctype}`, {
      cache: 'no-store'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !data.content) throw new Error('Пустой ответ API');
    return {
      text: cleanJokeText(data.content)
    };
  }

  async function prefetchJokes() {
    if (isPrefetching || jokeQueue.length >= 3) return;
    isPrefetching = true;
    try {
      const item = await fetchJokeItem();
      jokeQueue.push(item);
    } catch (err) {
      console.warn('Не удалось предзагрузить шутку с rzhunemogu:', err);
    } finally {
      isPrefetching = false;
      if (jokeQueue.length < 2) {
        setTimeout(prefetchJokes, 600);
      }
    }
  }

  // Запуск фоновой предзагрузки
  prefetchJokes();

  function hideBubble() {
    if (!mascotBubble) return;
    mascotBubble.classList.add('hidden');
    if (mascotContainer) {
      mascotContainer.setAttribute('title', 'Нажми на меня :3');
    }
    if (bubbleTimer) {
      clearTimeout(bubbleTimer);
      bubbleTimer = null;
    }
  }

  async function triggerMascotJoke() {
    if (!mascotBubble || !mascotBubbleText) return;

    if (bubbleTimer) clearTimeout(bubbleTimer);
    if (mascotContainer) {
      mascotContainer.removeAttribute('title');
    }

    let item = jokeQueue.shift();
    if (!item) {
      mascotBubbleText.textContent = 'Котик вспоминает пошлый прикол...';
      mascotBubble.classList.remove('hidden');
      mascotBubble.classList.remove('bubble-bounce');
      void mascotBubble.offsetWidth;
      mascotBubble.classList.add('bubble-bounce');

      try {
        item = await fetchJokeItem();
      } catch (err) {
        item = {
          text: 'Хотел рассказать пошлый прикол, но интернет временно отвалился... Придётся просто поцеловать тебя :3'
        };
      }
    }

    mascotBubbleText.textContent = item.text;
    mascotBubble.classList.remove('hidden');
    mascotBubble.classList.remove('bubble-bounce');
    void mascotBubble.offsetWidth;
    mascotBubble.classList.add('bubble-bounce');

    // Предзагружаем следующую шутку
    prefetchJokes();

    // Автоскрытие через 14 секунд (если курсор не над облачком)
    scheduleBubbleHide(14000);
  }

  if (mascotBubbleClose) {
    mascotBubbleClose.addEventListener('click', (e) => {
      e.stopPropagation();
      hideBubble();
    });
  }

  if (mascotBubble) {
    mascotBubble.addEventListener('pointerenter', () => {
      isHoveringBubble = true;
      if (bubbleTimer) {
        clearTimeout(bubbleTimer);
        bubbleTimer = null;
      }
    });

    mascotBubble.addEventListener('pointerleave', () => {
      isHoveringBubble = false;
      if (!mascotBubble.classList.contains('hidden')) {
        scheduleBubbleHide(8000); // 8 секунд после ухода курсора
      }
    });

    mascotBubble.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });
  }

  let isMascotPressed = false;

  function openMascot(e) {
    if (e && e.button !== undefined && e.button !== 0) return; // только ЛКМ
    if (isMascotPressed) return;
    isMascotPressed = true;
    mascotContainer.classList.add('is-open');
    playPopSound();
    triggerMascotJoke();
  }

  function closeMascot() {
    if (!isMascotPressed) return;
    isMascotPressed = false;
    mascotContainer.classList.remove('is-open');
  }

  mascotContainer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    openMascot(e);
  });

  mascotContainer.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });

  window.addEventListener('pointerup', closeMascot);
  window.addEventListener('pointercancel', closeMascot);
  window.addEventListener('blur', closeMascot);
}

// Старт приложения
window.addEventListener('DOMContentLoaded', initGoogleAuth);
