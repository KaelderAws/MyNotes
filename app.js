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
let saveTimeout = null;
let isSaving = false;

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

// Контекстное меню
const customContextMenu = document.getElementById('custom-context-menu');
const cmStatusSection = document.getElementById('cm-status-section');
const cmClipboardSection = document.getElementById('cm-clipboard-section');
const cmNoteActionsSection = document.getElementById('cm-note-actions-section');
const cmOpenDocsBtn = document.getElementById('cm-open-docs');
const cmDeleteNoteBtn = document.getElementById('cm-delete-note');

// --- Инициализация Google Identity Services ---
function initGoogleAuth() {
  if (typeof google === 'undefined') {
    setTimeout(initGoogleAuth, 100);
    return;
  }

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: handleTokenResponse,
  });

  // Проверяем, есть ли действующий токен
  if (accessToken && Date.now() < tokenExpiresAt) {
    onAuthenticated();
  } else {
    showAuthScreen();
  }
}

function handleLogin() {
  if (!tokenClient) return;
  tokenClient.requestAccessToken({ prompt: 'consent' });
}

function handleTokenResponse(resp) {
  if (resp.error) {
    console.error('Ошибка авторизации:', resp);
    alert('Не удалось авторизоваться в Google: ' + resp.error);
    return;
  }
  accessToken = resp.access_token;
  tokenExpiresAt = Date.now() + (resp.expires_in * 1000);
  localStorage.setItem('gdocs_access_token', accessToken);
  localStorage.setItem('gdocs_token_expires', tokenExpiresAt);
  onAuthenticated();
}

function handleLogout() {
  accessToken = null;
  localStorage.removeItem('gdocs_access_token');
  localStorage.removeItem('gdocs_token_expires');
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
async function apiFetch(url, options = {}) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    ...(options.headers || {})
  };

  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    handleLogout();
    throw new Error('Сессия истекла. Пожалуйста, войдите снова.');
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
    if (user.picture) {
      userAvatar.src = user.picture;
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
  const filtered = notesList.filter(n => n.name.toLowerCase().includes(filterText.toLowerCase()));

  if (filtered.length === 0) {
    notesListEl.innerHTML = '<li class="status-msg">Заметок пока нет</li>';
    return;
  }

  filtered.forEach(note => {
    const li = document.createElement('li');
    li.className = `note-item ${activeNote && activeNote.id === note.id ? 'active' : ''}`;
    li.dataset.noteId = note.id;
    
    const date = new Date(note.modifiedTime).toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });

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
    renderNotesList();
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
        lineHtml += escaped;
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
  activeNote = note;
  renderNotesList(searchInput.value);

  editorEmpty.classList.add('hidden');
  editorActive.classList.remove('hidden');

  noteTitleInput.value = note.name;
  noteBodyInput.innerHTML = '<div style="color: var(--text-light);">Загрузка содержимого...</div>';
  setEditorEditable(false);
  openInDocsBtn.href = note.webViewLink || `https://docs.google.com/document/d/${note.id}/edit`;

  setSyncStatus('saved', 'Загружено');

  try {
    const res = await apiFetch(`https://docs.googleapis.com/v1/documents/${note.id}`);
    const doc = await res.json();

    noteBodyInput.innerHTML = renderDocToEditor(doc);
    setEditorEditable(true);
    setFilter('all');
  } catch (err) {
    console.error('Ошибка чтения Google Docs:', err);
    noteBodyInput.innerHTML = '<div style="color: var(--danger);">Ошибка при чтении документа Google Docs.</div>';
    setEditorEditable(true);
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

// --- Сохранение изменений в Google Docs ---
async function saveActiveNote() {
  if (!activeNote || isSaving) return;

  const newTitle = noteTitleInput.value.trim() || 'Без названия';
  const { text: newContent, highlights } = extractContentAndHighlights(noteBodyInput);

  isSaving = true;
  setSyncStatus('saving', 'Сохранение...');

  try {
    // 1. Получаем текущую длину документа в Google Docs
    const docRes = await apiFetch(`https://docs.googleapis.com/v1/documents/${activeNote.id}`);
    const doc = await docRes.json();
    const docLength = doc.body.content.slice(-1)[0]?.endIndex || 1;

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
      await apiFetch(`https://docs.googleapis.com/v1/documents/${activeNote.id}:batchUpdate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests })
      });
    }

    // 2. Обновляем имя файла на Диске, если заголовок изменился
    if (newTitle !== activeNote.name) {
      await apiFetch(`https://www.googleapis.com/drive/v3/files/${activeNote.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newTitle })
      });
      activeNote.name = newTitle;
    }

    activeNote.modifiedTime = new Date().toISOString();
    renderNotesList(searchInput.value);
    setSyncStatus('saved', 'Сохранено');
  } catch (err) {
    console.error('Ошибка сохранения заметки:', err);
    setSyncStatus('error', 'Ошибка сохранения');
    showToast('Ошибка сохранения в Google Docs', 'error');
  } finally {
    isSaving = false;
  }
}

// Отложенное сохранение (debounce 1 сек)
function scheduleSave() {
  setSyncStatus('saving', 'Сохранение...');
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveActiveNote, 1000);
}

// --- Удаление заметки ---
async function deleteActiveNote() {
  if (!activeNote) return;
  const confirmDelete = confirm(`Удалить заметку "${activeNote.name}"? Она переместится в корзину Google Диска.`);
  if (!confirmDelete) return;

  setSyncStatus('saving', 'Удаление...');
  try {
    await apiFetch(`https://www.googleapis.com/drive/v3/files/${activeNote.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true })
    });

    notesList = notesList.filter(n => n.id !== activeNote.id);
    activeNote = null;
    editorActive.classList.add('hidden');
    editorEmpty.classList.remove('hidden');
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
  if (!activeNote) return;

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
}

// --- Фильтрация строк по статусу ---
let currentFilter = 'all';

function setFilter(filterType) {
  currentFilter = filterType;

  const filterBtns = document.querySelectorAll('.checklist-toolbar .tool-btn');
  filterBtns.forEach(btn => {
    if (btn.dataset.filter === filterType) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  applyFilterToEditor();
}

function applyFilterToEditor() {
  const children = Array.from(noteBodyInput.children);
  if (children.length === 0) return;

  children.forEach(child => {
    if (currentFilter === 'all') {
      child.style.display = '';
      return;
    }

    const hlType = getElementHighlightType(child);

    if (currentFilter === 'done' && hlType === 'done') {
      child.style.display = '';
    } else if (currentFilter === 'pending' && hlType === 'pending') {
      child.style.display = '';
    } else if (currentFilter === 'cancelled' && hlType === 'cancelled') {
      child.style.display = '';
    } else if (currentFilter === 'clear' && hlType === null) {
      child.style.display = '';
    } else {
      child.style.display = 'none';
    }
  });
}

function getElementHighlightType(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;

  const spans = el.querySelectorAll ? el.querySelectorAll('[style*="background-color"], .hl-done, .hl-pending, .hl-cancelled') : [];
  for (const span of spans) {
    const bg = span.style?.backgroundColor;
    if (bg && bg !== 'transparent' && bg !== 'inherit' && bg !== 'rgba(0, 0, 0, 0)') {
      const rgb = parseRgbString(bg);
      const type = detectHighlightType(rgb);
      if (type) return type;
    }
    if (span.classList.contains('hl-done')) return 'done';
    if (span.classList.contains('hl-pending')) return 'pending';
    if (span.classList.contains('hl-cancelled')) return 'cancelled';
  }

  const selfBg = el.style?.backgroundColor;
  if (selfBg && selfBg !== 'transparent' && selfBg !== 'inherit' && selfBg !== 'rgba(0, 0, 0, 0)') {
    const rgb = parseRgbString(selfBg);
    const type = detectHighlightType(rgb);
    if (type) return type;
  }
  if (el.classList.contains('hl-done')) return 'done';
  if (el.classList.contains('hl-pending')) return 'pending';
  if (el.classList.contains('hl-cancelled')) return 'cancelled';

  return null;
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
      if (activeNote) {
        clearTimeout(saveTimeout);
        saveActiveNote();
      } else {
        showToast('Нет открытой заметки для сохранения', 'info');
      }
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
manualSaveBtn.addEventListener('click', () => {
  clearTimeout(saveTimeout);
  saveActiveNote();
});
deleteNoteBtn.addEventListener('click', deleteActiveNote);

// Кнопки фильтрации строк: на mousedown предотвращаем снятие фокуса, на click переключаем фильтр
[toolBtnAll, toolBtnDone, toolBtnPending, toolBtnCancelled, toolBtnClear].forEach(btn => {
  if (!btn) return;
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    setFilter(btn.dataset.filter);
  });
});

noteTitleInput.addEventListener('input', scheduleSave);
noteBodyInput.addEventListener('input', scheduleSave);

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

    if (activeNote) {
      clearTimeout(saveTimeout);
      saveActiveNote();
    } else {
      showToast('Нет открытой заметки для сохранения', 'info');
    }
    return;
  }

  // 2. Гарантированный Ctrl+Z / Ctrl+Я (Undo) для русской раскладки
  const isZKey = e.code === 'KeyZ' || e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'я';
  if (isCtrlOrMeta && !e.shiftKey && isZKey && e.key.toLowerCase() === 'я') {
    e.preventDefault();
    document.execCommand('undo');
    scheduleSave();
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

// Старт приложения
window.addEventListener('DOMContentLoaded', initGoogleAuth);
