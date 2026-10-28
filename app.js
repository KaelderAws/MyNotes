// Конфигурация Google OAuth
const CLIENT_ID = '646165812033-7dk1rg91ioqc0kst2kinsvv8k2m8cl89.apps.googleusercontent.com';
const SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email'
].join(' ');

const FOLDER_NAME = 'Заметки (Notes App)';

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
    // Токен протух
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
      // Создаём новую папку
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
  } catch (err) {
    console.error('Ошибка создания заметки:', err);
    setSyncStatus('error', 'Ошибка при создании');
  }
}

// --- Выбор и загрузка содержимого заметки ---
async function selectNote(note) {
  activeNote = note;
  renderNotesList(searchInput.value);

  editorEmpty.classList.add('hidden');
  editorActive.classList.remove('hidden');

  noteTitleInput.value = note.name;
  noteBodyInput.value = 'Загрузка содержимого...';
  noteBodyInput.disabled = true;
  openInDocsBtn.href = note.webViewLink || `https://docs.google.com/document/d/${note.id}/edit`;

  setSyncStatus('saved', 'Загружено');

  try {
    const res = await apiFetch(`https://docs.googleapis.com/v1/documents/${note.id}`);
    const doc = await res.json();
    
    let text = '';
    if (doc.body && doc.body.content) {
      for (const item of doc.body.content) {
        if (item.paragraph && item.paragraph.elements) {
          for (const el of item.paragraph.elements) {
            if (el.textRun && el.textRun.content) {
              text += el.textRun.content;
            }
          }
        }
      }
    }

    noteBodyInput.value = text.replace(/\n$/, ''); // убираем системный завершающий перенос
    noteBodyInput.disabled = false;
  } catch (err) {
    console.error('Ошибка чтения Google Docs:', err);
    noteBodyInput.value = 'Ошибка при чтении документа Google Docs.';
    noteBodyInput.disabled = false;
    setSyncStatus('error', 'Ошибка чтения');
  }
}

// --- Сохранение изменений в Google Docs ---
async function saveActiveNote() {
  if (!activeNote || isSaving) return;

  const newTitle = noteTitleInput.value.trim() || 'Без названия';
  const newContent = noteBodyInput.value;

  isSaving = true;
  setSyncStatus('saving', 'Сохранение в Google Docs...');

  try {
    // 1. Получаем текущую длину документа в Google Docs
    const docRes = await apiFetch(`https://docs.googleapis.com/v1/documents/${activeNote.id}`);
    const doc = await docRes.json();
    const docLength = doc.body.content.slice(-1)[0]?.endIndex || 1;

    const requests = [];

    // Очищаем предыдущий текст (если он был длиннее пустого документа)
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

    // Вставляем новый текст (если не пустой)
    if (newContent.length > 0) {
      requests.push({
        insertText: {
          location: { index: 1 },
          text: newContent
        }
      });
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
  } finally {
    isSaving = false;
  }
}

// Отложенное сохранение (debounce)
function scheduleSave() {
  setSyncStatus('saving', 'Есть несохраненные правки...');
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
  } catch (err) {
    console.error('Ошибка удаления:', err);
    setSyncStatus('error', 'Не удалось удалить');
  }
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

// --- Слушатели событий ---
loginBtn.addEventListener('click', handleLogin);
logoutBtn.addEventListener('click', handleLogout);
newNoteBtn.addEventListener('click', createNewNote);
manualSaveBtn.addEventListener('click', () => {
  clearTimeout(saveTimeout);
  saveActiveNote();
});
deleteNoteBtn.addEventListener('click', deleteActiveNote);

noteTitleInput.addEventListener('input', scheduleSave);
noteBodyInput.addEventListener('input', scheduleSave);

searchInput.addEventListener('input', (e) => {
  renderNotesList(e.target.value);
});

// Горячая клавиша Ctrl+S / Cmd+S для мгновенного сохранения
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (activeNote) {
      clearTimeout(saveTimeout);
      saveActiveNote();
    }
  }
});

// Старт
window.addEventListener('DOMContentLoaded', initGoogleAuth);
