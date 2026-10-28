# Google Docs Notes App

Легковесное веб-приложение для ведения заметок с прямой интеграцией в Google Docs.
Работает **на 100% на стороне клиента** (без собственного бэкенда).

## Возможности
- 🔐 Авторизация через официальный Google Identity Services (OAuth 2.0).
- 📁 Автоматически создаёт и работает в отдельной папке `Заметки (Notes App)` на вашем Google Диске.
- 📝 Каждая заметка — это полноценный Google Документ.
- ⚡ Мгновенное чтение, автосохранение правок (debounce 1 сек или `Ctrl + S`).
- ↗ Кнопка быстрого перехода «Открыть в Google Docs» прямо из заметки.
- 🗑 Удаление заметок в корзину Google Диска.

---

## Как запустить локально

Так как в Google Cloud Console вы указали источники:
- `http://localhost:5173`
- `http://localhost:3000`
- `http://127.0.0.1:5500`

Вы можете запустить приложение любым удобным способом:

### Способ 1: VS Code (расширение Live Server)
1. Откройте эту папку в VS Code.
2. Кликните правой кнопкой мыши по `index.html` → **Open with Live Server** (по умолчанию запустится на порту `5500`).

### Способ 2: Через Node.js (npx serve)
```bash
npx serve -l 3000
```
И откройте `http://localhost:3000`.

### Способ 3: Через Python
```bash
python -m http.server 3000
```
И откройте `http://localhost:3000`.

---

## Как выложить в онлайн бесплатно (GitHub Pages / Vercel)

1. Загрузите файлы репозитория на GitHub.
2. Включите **GitHub Pages** (Settings -> Pages -> Branch: main).
3. Скопируйте полученный адрес сайта (например, `https://username.github.io/google-docs-notes`).
4. Вернитесь в [Google Cloud Console](https://console.cloud.google.com/) -> Google Auth Platform -> **Clients** -> откройте ваш клиент и в **Authorized JavaScript origins** добавьте ваш новый HTTPS-адрес.
