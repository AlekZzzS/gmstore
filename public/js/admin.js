/* Админка: список «оплачен, но не выдан», безопасная повторная выдача,
   управление складом и сбоями поставщиков. Дизайн по условию не требуется. */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const tokenInput = $('#token');
  const toastEl = $('#toast');
  let timer;

  // Токен запоминаем локально, чтобы не вводить каждый раз.
  tokenInput.value = localStorage.getItem('adminToken') || tokenInput.value;
  tokenInput.addEventListener('change', () => localStorage.setItem('adminToken', tokenInput.value));

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const time = (iso) => (iso ? new Date(iso).toLocaleTimeString('ru-RU') : '—');

  function toast(text, bad) {
    toastEl.textContent = text;
    toastEl.classList.toggle('is-bad', !!bad);
    toastEl.hidden = false;
    setTimeout(() => { toastEl.hidden = true; }, 2800);
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-admin-token': tokenInput.value },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) toast('Неверный admin-токен', true);
    return data;
  }

  const LABEL = {
    created: 'создан', paid: 'оплачен', delivering: 'идёт выдача', delivered: 'выдан',
    payment_failed: 'оплата не прошла', out_of_stock: 'нет остатка', delivery_failed: 'сбой выдачи',
  };

  async function refresh() {
    const showAll = $('#showAll').checked;

    const [stock, list, promos] = await Promise.all([
      api('GET', '/admin/api/stock'),
      api('GET', `/admin/api/orders?filter=${showAll ? 'all' : 'stuck'}`),
      api('GET', '/admin/api/promocodes'),
    ]);

    // Склад
    if (stock.stock) {
      $('#stock').innerHTML = stock.stock.map((s) =>
        `Поставщик <b>${s.provider}</b>: свободно <b>${s.free}</b> из ${s.total} (израсходовано ${s.claimed})`
      ).join(' &nbsp;·&nbsp; ');
      renderChaos(stock.chaos);
    }

    // Заказы
    const orders = list.orders || [];
    $('#orders').innerHTML = orders.length === 0
      ? '<p class="util-muted" style="margin-top:12px">Заказов в этом фильтре нет.</p>'
      : `<table class="util-table">
          <thead><tr>
            <th>Заказ</th><th>Товар</th><th>Статус</th><th>Сумма</th>
            <th>Попыток</th><th>Код</th><th>Обновлён</th><th></th>
          </tr></thead>
          <tbody>${orders.map((o) => `
            <tr>
              <td><a href="/order.html?id=${encodeURIComponent(o.id)}"><code>${esc(o.id)}</code></a></td>
              <td>${esc(o.product_name || o.sku)}</td>
              <td><span class="tag" data-s="${o.status}">${LABEL[o.status] || o.status}</span>
                  ${o.last_error ? `<div class="util-muted util-muted--sm">${esc(o.last_error)}</div>` : ''}</td>
              <td>${o.amount} ${esc(o.currency)}</td>
              <td>${o.attempt}</td>
              <td>${o.code ? `<code>${esc(o.code)}</code>` : '—'}</td>
              <td class="util-muted">${time(o.updated_at)}</td>
              <td>${o.status === 'delivered' || o.status === 'payment_failed'
                ? ''
                : `<button class="btn btn--ghost" data-retry="${esc(o.id)}">Выдать повторно</button>`}</td>
            </tr>`).join('')}
          </tbody></table>`;

    $('#orders').querySelectorAll('[data-retry]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Выдаём…';
        const r = await api('POST', `/admin/api/orders/${btn.dataset.retry}/retry`);
        const st = r.order && r.order.status;
        toast(st === 'delivered'
          ? `Заказ ${btn.dataset.retry} выдан: ${r.order.code}`
          : `Повтор не дал кода: ${st}`, st !== 'delivered');
        refresh();
      });
    });

    // Промокоды
    $('#promos').innerHTML = `<table class="util-table">
      <thead><tr><th>Код</th><th>Скидка</th><th>Использовано</th><th></th></tr></thead>
      <tbody>${(promos.promocodes || []).map((p) => `
        <tr>
          <td><code>${esc(p.code)}</code></td>
          <td>${p.type === 'percent' ? p.value + '%' : p.value + ' ' + (p.currency || '')}</td>
          <td>${p.used_count} / ${p.max_uses}</td>
          <td><div class="bar"><i style="width:${Math.round(100 * p.used_count / p.max_uses)}%"></i></div></td>
        </tr>`).join('')}
      </tbody></table>`;
  }

  function renderChaos(chaos) {
    if (!chaos || document.activeElement?.closest('#chaos')) return; // не мешаем вводу
    $('#chaos').innerHTML = ['A', 'B'].map((p) => `
      <div>
        <h3 class="util-h3">Поставщик ${p}${p === 'B' ? ' (резервный)' : ''}</h3>
        <label class="util-muted util-muted--sm">Доля ошибок 5xx
          <input class="util-input util-input--sm util-input--w" data-chaos="${p}.errorRate"
                 type="number" step="0.05" min="0" max="1" value="${chaos[p].errorRate}"></label>
        <label class="util-muted util-muted--sm">Доля таймаутов (код уже выдан!)
          <input class="util-input util-input--sm util-input--w" data-chaos="${p}.timeoutRate"
                 type="number" step="0.05" min="0" max="1" value="${chaos[p].timeoutRate}"></label>
        <label class="util-muted util-muted--sm">Задержка, мс
          <input class="util-input util-input--sm util-input--w" data-chaos="${p}.latencyMs"
                 type="number" step="10" min="0" value="${chaos[p].latencyMs}"></label>
      </div>`).join('');
  }

  function collectChaos() {
    const out = { A: {}, B: {} };
    document.querySelectorAll('[data-chaos]').forEach((i) => {
      const [p, k] = i.dataset.chaos.split('.');
      out[p][k] = Number(i.value);
    });
    return out;
  }

  $('#chaosSave').addEventListener('click', async () => {
    await api('POST', '/admin/api/chaos', collectChaos());
    toast('Настройки сбоев применены');
    refresh();
  });
  $('#chaosOff').addEventListener('click', async () => {
    await api('POST', '/admin/api/chaos', {
      A: { errorRate: 0, timeoutRate: 0, latencyMs: 5 },
      B: { errorRate: 0, timeoutRate: 0, latencyMs: 5 },
    });
    toast('Сбои выключены');
    refresh();
  });
  $('#chaosTrap').addEventListener('click', async () => {
    await api('POST', '/admin/api/chaos', {
      A: { errorRate: 0, timeoutRate: 1, latencyMs: 5 },
      B: { errorRate: 0, timeoutRate: 0, latencyMs: 5 },
    });
    toast('Поставщик A теперь всегда «зависает» уже после выдачи кода');
    refresh();
  });

  $('#topup').addEventListener('click', async () => {
    const r = await api('POST', '/admin/api/stock/topup', {
      provider: $('#stockProvider').value,
      count: Number($('#stockCount').value) || 1,
    });
    toast(`Добавлено ключей: ${r.added ?? 0}`);
    refresh();
  });
  $('#drain').addEventListener('click', async () => {
    await api('POST', '/admin/api/stock/drain', { provider: $('#stockProvider').value });
    toast('Пул опустошён — следующая оплата уйдёт в out_of_stock');
    refresh();
  });

  $('#refresh').addEventListener('click', refresh);
  $('#showAll').addEventListener('change', refresh);

  refresh();
  timer = setInterval(refresh, 3000);
  document.addEventListener('visibilitychange', () => {
    clearInterval(timer);
    if (!document.hidden) { refresh(); timer = setInterval(refresh, 3000); }
  });
})();
