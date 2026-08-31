/* Витрина: пять обязательных интерактивов + флоу покупки.
   Ванильный JS, без фреймворков. */
(function () {
  'use strict';

  const D = window.STORE_DATA;
  const G = window.GLYPHS;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const svg = (glyph, box) => `<svg viewBox="0 0 ${box || 40} ${box || 40}" aria-hidden="true">${G[glyph] || ''}</svg>`;

  // ── Тост ────────────────────────────────────────────────────────────────
  const toastEl = $('#toast');
  let toastTimer;
  function toast(text, bad) {
    toastEl.textContent = text;
    toastEl.classList.toggle('is-bad', !!bad);
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3200);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // (1) Баннер-карусель: автопрокрутка + стрелки + активные точки-индикаторы
  // ─────────────────────────────────────────────────────────────────────────
  (function carousel() {
    const track = $('#bannerTrack');
    const dotsBox = $('#bannerDots');
    const root = $('#banner');
    const total = D.banners.length;
    let index = 0;
    let timer = null;

    D.banners.forEach((b, i) => {
      // В макете баннер — пустой чёрный блок, картинок в нём нет.
      const slide = el('div', 'banner-slide');
      slide.dataset.tone = b.tone;
      slide.setAttribute('role', 'group');
      slide.setAttribute('aria-label', `Слайд ${i + 1} из ${total}`);
      track.append(slide);

      const dot = el('button', 'banner__dot');
      dot.type = 'button';
      dot.setAttribute('role', 'tab');
      dot.setAttribute('aria-label', `Слайд ${i + 1}`);
      dot.addEventListener('click', () => { go(i); restart(); });
      dotsBox.append(dot);
    });

    const dots = [...dotsBox.children];

    function go(next) {
      index = (next + total) % total;
      track.style.transform = `translateX(-${index * 100}%)`;
      dots.forEach((d, i) => {
        const active = i === index;
        d.classList.toggle('is-active', active);
        d.setAttribute('aria-selected', String(active));
      });
    }

    const restart = () => { clearInterval(timer); timer = setInterval(() => go(index + 1), 5000); };

    $('#bannerPrev').addEventListener('click', () => { go(index - 1); restart(); });
    $('#bannerNext').addEventListener('click', () => { go(index + 1); restart(); });

    // Автопрокрутка приостанавливается при наведении и в фоновой вкладке.
    root.addEventListener('mouseenter', () => clearInterval(timer));
    root.addEventListener('mouseleave', restart);
    document.addEventListener('visibilitychange', () => (document.hidden ? clearInterval(timer) : restart()));

    go(0);
    restart();
  })();

  // ─────────────────────────────────────────────────────────────────────────
  // (2) Кнопка «Каталог»: открытие/закрытие, повторный клик, клик вне меню, Esc
  // ─────────────────────────────────────────────────────────────────────────
  (function catalogMenu() {
    const btn = $('#catalogBtn');
    const menu = $('#catalogMenu');
    const overlay = $('#catalogOverlay');
    const rail = $('#catalogRail');
    const cols = $('#catalogCols');

    D.catalog.forEach((sec, i) => {
      const item = el('button', 'rail-item' + (i === 0 ? ' is-active' : ''),
        `<span>${sec.section}</span><svg viewBox="0 0 16 16"><path d="M6 3.5 10.5 8 6 12.5"/></svg>`);
      item.type = 'button';
      item.addEventListener('mouseenter', () => select(i));
      item.addEventListener('click', () => select(i));
      rail.append(item);
    });

    function select(i) {
      [...rail.children].forEach((n, k) => n.classList.toggle('is-active', k === i));
      cols.replaceChildren(...D.catalog[i].columns.map((col) => {
        const box = el('div', 'menu-col');
        box.append(el('h4', 'menu-col__title',
          `${col.title}<svg viewBox="0 0 16 16"><path d="M6 3.5 10.5 8 6 12.5"/></svg>`));
        col.items.forEach((t) => {
          const a = el('a', 'menu-col__link', t);
          a.href = '#';
          a.addEventListener('click', (e) => e.preventDefault());
          box.append(a);
        });
        return box;
      }));
    }
    select(0);

    function setOpen(open) {
      menu.hidden = !open;
      overlay.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      document.body.style.overflow = open ? 'hidden' : '';
    }
    const isOpen = () => !menu.hidden;

    // Повторный клик по кнопке закрывает меню.
    btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(!isOpen()); });
    // Клик вне меню закрывает.
    overlay.addEventListener('click', () => setOpen(false));
    document.addEventListener('click', (e) => {
      if (isOpen() && !menu.contains(e.target) && !btn.contains(e.target)) setOpen(false);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) setOpen(false); });
  })();

  // ─────────────────────────────────────────────────────────────────────────
  // (4) Иконки сервисов — выделение при наведении задано в CSS (transition)
  // ─────────────────────────────────────────────────────────────────────────
  (function services() {
    const row = $('#servicesRow');
    D.services.forEach((s) => {
      const li = el('li');
      const b = el('button', 'service' + (s.muted ? ' service--muted' : ''),
        `<span class="service__tile"><img src="${s.img}" alt="" width="72" height="72" loading="lazy"></span>` +
        `<span class="service__name">${s.name}</span>`);
      b.type = 'button';
      b.addEventListener('click', () => toast(`Раздел «${s.name}» — в макете статичный блок`));
      li.append(b);
      row.append(li);
    });
  })();

  // ─────────────────────────────────────────────────────────────────────────
  // (3) Переключатель валют — только активное состояние, пересчёт не требуется
  // ─────────────────────────────────────────────────────────────────────────
  (function currencySwitch() {
    const box = $('#currency');
    const amount = $('#topupAmount');
    const payBtn = $('#topupPay');

    box.addEventListener('click', (e) => {
      const btn = e.target.closest('.currency__btn');
      if (!btn || btn.classList.contains('is-active')) return;
      [...box.children].forEach((b) => {
        const active = b === btn;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      // Сумма 500 остаётся прежней, меняется только символ валюты:
      // рассинхрон валют на макете — заглушка, пересчёт по условию не нужен.
      const sym = btn.dataset.symbol;
      amount.textContent = `500${sym}`;
      payBtn.textContent = `Оплатить 500${sym}`;
    });
  })();

  // ── Промокод (этап 4): предпросмотр скидки, считает сервер ──────────────
  let activePromo = null;
  (function promo() {
    const toggle = $('#promoToggle');
    const box = $('#promoBox');
    const input = $('#promoInput');
    const apply = $('#promoApply');
    const msg = $('#promoMsg');

    toggle.addEventListener('click', () => {
      const open = box.hidden;
      box.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      if (open) input.focus();
    });

    async function check() {
      const code = input.value.trim().toUpperCase();
      msg.className = 'promo-box__msg';
      if (!code) { activePromo = null; msg.textContent = 'Промокод сброшен'; return; }
      apply.disabled = true;
      try {
        const r = await fetch('/api/promo/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // На сервер уходит только строка кода — скидку считает сервер.
          body: JSON.stringify({ code, sku: 'KEY-CS2-PRIME' }),
        }).then((x) => x.json());

        if (r.ok) {
          activePromo = code;
          msg.className = 'promo-box__msg is-ok';
          msg.textContent = `−${r.discount} ₽ на CS2 Prime · осталось применений: ${r.uses_left}`;
        } else {
          activePromo = null;
          msg.className = 'promo-box__msg is-bad';
          msg.textContent = r.reason === 'limit_reached' ? 'Лимит применений исчерпан' : 'Промокод не найден';
        }
      } catch {
        msg.className = 'promo-box__msg is-bad';
        msg.textContent = 'Не удалось проверить промокод';
      } finally {
        apply.disabled = false;
      }
    }

    apply.addEventListener('click', check);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') check(); });
  })();

  // ── Чипсы-табы над карточками ───────────────────────────────────────────
  (function chips() {
    const box = $('#chips');
    D.chips.forEach((c) => {
      const b = el('button', 'chip' + (c.active ? ' is-active' : ''),
        `${svg(c.glyph, 20)}<span>${c.label}</span>`);
      b.type = 'button';
      b.addEventListener('click', () => {
        [...box.children].forEach((n) => n.classList.toggle('is-active', n === b));
      });
      box.append(b);
    });
  })();

  // ─────────────────────────────────────────────────────────────────────────
  // (5) Карточки товара + флоу покупки
  // ─────────────────────────────────────────────────────────────────────────
  // В макете у всех карточек одна и та же обложка — она и выгружена из него.
  const COVER = 'assets/card-cover.png';

  const TAGS = { key: 'Ключ', topup: 'Пополнение', subscription: 'Подписка', giftcard: 'Гифт-карта' };

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'k-' + Date.now() + '-' + Math.random().toString(36).slice(2));

  (async function products() {
    const wrap = $('#cards');
    let list = [];
    try {
      const data = await fetch('/api/catalog').then((r) => r.json());
      // В ряду макета — 5 карточек.
      list = data.products.filter((p) => p.type === 'key' || p.sku === 'SUB-DISCORD-1M' || p.sku === 'SUB-YT-3M').slice(0, 5);
    } catch {
      wrap.append(el('p', null, 'Не удалось загрузить каталог. Запущен ли сервер?'));
      return;
    }

    list.forEach((p) => {
      const card = el('article', 'card');
      card.innerHTML =
        `<div class="card__cover">
           <img class="card__cover-art" src="${COVER}" alt="" width="228" height="152" loading="lazy">
         </div>
         <div class="card__body">
           <h3 class="card__name">🎮 ${p.name} 🔑 РФ+СНГ</h3>
           <div class="card__price"><b>${p.price} ₽</b><s>${Math.round(p.price * 1.55)} ₽</s></div>
           <button class="btn card__buy" type="button">Купить</button>
         </div>`;

      const buy = $('.card__buy', card);

      buy.addEventListener('click', async () => {
        // Защита от двойного клика на клиенте — кнопка блокируется…
        if (buy.dataset.loading === '1') return;
        buy.dataset.loading = '1';
        buy.textContent = 'Создаём заказ…';

        // …но настоящая гарантия — Idempotency-Key: он один на всю попытку
        // покупки, поэтому даже проскочившие параллельные запросы дадут
        // ровно один заказ (решение принимает сервер, а не UI).
        if (!card.dataset.idemKey) card.dataset.idemKey = uuid();

        try {
          const res = await fetch('/api/orders', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'idempotency-key': card.dataset.idemKey },
            body: JSON.stringify({ sku: p.sku, promo_code: activePromo || undefined }),
          });
          const data = await res.json();
          if (!data.ok) {
            const why = data.error === 'promo_limit_reached' ? 'Лимит промокода исчерпан'
              : data.error === 'promo_not_found' ? 'Промокод не найден'
                : 'Не удалось создать заказ';
            toast(why, true);
            delete card.dataset.idemKey; // даём попробовать снова, уже новым ключом
            return;
          }
          location.href = `/order.html?id=${encodeURIComponent(data.order.id)}`;
        } catch {
          toast('Сервер недоступен', true);
          delete card.dataset.idemKey;
        } finally {
          buy.dataset.loading = '0';
          buy.textContent = 'Купить';
        }
      });

      wrap.append(card);
    });
  })();

  // Кнопка «Оплатить 500$» в блоке пополнения ведёт по тому же флоу.
  $('#topupPay').addEventListener('click', async () => {
    const btn = $('#topupPay');
    if (btn.disabled) return;
    btn.disabled = true;
    if (!btn.dataset.idemKey) btn.dataset.idemKey = uuid();
    try {
      const data = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': btn.dataset.idemKey },
        body: JSON.stringify({ sku: 'STEAM-TOPUP-500', promo_code: activePromo || undefined }),
      }).then((r) => r.json());
      if (!data.ok) { toast('Не удалось создать заказ', true); delete btn.dataset.idemKey; return; }
      location.href = `/order.html?id=${encodeURIComponent(data.order.id)}`;
    } catch {
      toast('Сервер недоступен', true);
      delete btn.dataset.idemKey;
    } finally {
      btn.disabled = false;
    }
  });
})();
