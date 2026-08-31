/* Статическое наполнение витрины — структура и содержимое взяты из макета.
   Конкретное наполнение по условию отдельно не оценивается. */
window.STORE_DATA = {

  // (1) Слайды баннера
  // В макете баннер — сплошной чёрный плейсхолдер без картинки.
  // Слайды держим ради обязательного интерактива: стрелки и точки-индикаторы.
  banners: [
    { tone: 'a' }, { tone: 'b' }, { tone: 'c' },
    { tone: 'd' }, { tone: 'e' }, { tone: 'f' },
  ],

  // (4) Иконки сервисов — ассеты выгружены прямо из макета (Figma, 2x)
  services: [
    { name: 'Steam',        img: 'assets/services/steam.png' },
    { name: 'Telegram',     img: 'assets/services/telegram.png' },
    { name: 'Roblox',       img: 'assets/services/roblox.png' },
    { name: 'Brawl Stars',  img: 'assets/services/brawlstars.png' },
    { name: 'PUBG Mob…',    img: 'assets/services/pubg.png' },
    { name: 'App Store',    img: 'assets/services/appstore.png' },
    { name: 'ChatGPT',      img: 'assets/services/chatgpt.png' },
    { name: 'PlayStation',  img: 'assets/services/playstation.png' },
    { name: 'TikTok',       img: 'assets/services/tiktok.png' },
    { name: 'Mobile Leg…',  img: 'assets/services/mobilelegends.png' },
    { name: 'ещё 841',      img: 'assets/services/more.png', muted: true },
  ],

  // (2) Меню «Каталог»
  catalog: [
    {
      section: 'Игры и игровые сервисы',
      columns: [
        { title: 'Steam',       items: ['Игры и DLC', 'Пополнение баланса', 'Подарочные карты', 'Коллекционные карточки', 'Смена региона'] },
        { title: 'PlayStation', items: ['Игры и DLC', 'Пополнение баланса', 'Новые аккаунты', 'PS Plus', 'EA Play'] },
        { title: 'Xbox',        items: ['Игры и DLC', 'Пополнение баланса', 'Новые аккаунты', 'Xbox Game Pass', 'Услуги'] },
        { title: 'Nintendo',    items: ['Игры и DLC', 'Подарочные карты', 'Новые аккаунты', 'NS Online'] },
        { title: 'Battle.net',  items: ['World of Warcraft', 'Подарочные карты', 'Прямое пополнение', 'Новые аккаунты', 'Смена региона'] },
        { title: 'Подборки',    items: ['Скидки 90%', 'Популярные издатели', 'Лучшие серии игр', 'Steam Deck', 'Bundle-наборы'] },
      ],
    },
    {
      section: 'Игровые ценности',
      columns: [
        { title: 'Валюта',  items: ['Robux', 'V-Bucks', 'UC PUBG', 'Genesis Crystals'] },
        { title: 'Предметы', items: ['Скины CS2', 'Кейсы', 'Наборы', 'Бустеры'] },
        { title: 'Аккаунты', items: ['Steam', 'Epic Games', 'Riot', 'Ubisoft'] },
      ],
    },
    {
      section: 'Мобильные игры',
      columns: [
        { title: 'Донат',   items: ['Mobile Legends', 'Brawl Stars', 'Clash of Clans', 'Free Fire'] },
        { title: 'Магазины', items: ['App Store', 'Google Play', 'RuStore'] },
      ],
    },
    {
      section: 'Сервисы и соцсети',
      columns: [
        { title: 'Подписки', items: ['Discord Nitro', 'YouTube Premium', 'Spotify Premium', 'Telegram Premium'] },
        { title: 'ИИ-сервисы', items: ['ChatGPT Plus', 'Midjourney', 'Claude Pro'] },
      ],
    },
    {
      section: 'Программы',
      columns: [
        { title: 'Лицензии', items: ['Windows', 'Office', 'Антивирусы'] },
        { title: 'VPN',      items: ['Годовые', 'Помесячные'] },
      ],
    },
  ],

  // Табы над карточками
  chips: [
    { label: 'Донат',          glyph: 'coins',  active: true },
    { label: 'Подписки',       glyph: 'card' },
    { label: 'Предметы',       glyph: 'sword' },
    { label: 'Аккаунты',       glyph: 'user' },
    { label: 'Ключи',          glyph: 'key' },
    { label: 'Игровая валюта', glyph: 'coins' },
    { label: 'Другое',         glyph: 'dots' },
  ],
};
