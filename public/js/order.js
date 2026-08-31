/* Страница статуса заказа. Здесь же — эмуляция оплаты:
   реального эквайринга нет, кнопки шлют вебхук по контракту. */
(function () {
  'use strict';

  const root = document.getElementById('root');
  const orderId = new URLSearchParams(location.search).get('id');
  let poll = null;

  const LABEL = {
    created:        'Ожидает оплаты',
    paid:           'Оплачен, готовим выдачу',
    delivering:     'Идёт выдача кода',
    delivered:      'Код выдан',
    payment_failed: 'Оплата не прошла',
    out_of_stock:   'Оплачено, но кода нет в наличии',
    delivery_failed:'Поставщики не смогли выдать код',
  };
  const HINT = {
    out_of_stock:    'Заказ не потерян. Пополните пул в админке и нажмите «Повторить выдачу» — повторная выдача идемпотентна.',
    delivery_failed: 'Заказ не потерян. Повторную выдачу можно запустить вручную из админки; повтор не приводит к задвоению.',
    payment_failed:  'Деньги не списаны. Промокод, если был, возвращён в лимит.',
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const time = (iso) => new Date(iso).toLocaleTimeString('ru-RU');

  async function load() {
    if (!orderId) { root.innerHTML = '<p class="util-muted">Не указан id заказа.</p>'; return; }
    let data;
    try {
      data = await fetch(`/api/orders/${encodeURIComponent(orderId)}`).then((r) => r.json());
    } catch {
      root.innerHTML = '<p class="util-muted">Сервер недоступен.</p>';
      return;
    }
    if (!data.ok) { root.innerHTML = '<p class="util-muted">Заказ не найден.</p>'; return; }
    render(data.order);
  }

  function render(o) {
    const busy = o.status === 'paid' || o.status === 'delivering';

    root.innerHTML = `
      <section class="util-card">
        <div class="status-hero">
          <span class="status-pill ${busy ? 'is-spin' : ''}" data-s="${o.status}">${LABEL[o.status] || o.status}</span>
          <span class="util-muted">заказ <code>${esc(o.id)}</code></span>
        </div>

        ${o.code ? `
          <div class="code-box">
            <div>
              <div class="util-muted util-muted--sm">Ваш ключ</div>
              <div class="code-box__value">${esc(o.code)}</div>
            </div>
            <button class="btn btn--ghost" id="copy">Скопировать</button>
          </div>` : ''}

        ${HINT[o.status] ? `<p class="util-muted" style="margin-top:14px">${HINT[o.status]}</p>` : ''}

        <dl class="kv">
          <dt>Товар</dt><dd>${esc(o.product_name)} <span class="util-muted">(${esc(o.sku)})</span></dd>
          <dt>Цена по каталогу</dt><dd>${o.base} ${esc(o.currency)}</dd>
          ${o.promo_code ? `<dt>Промокод</dt><dd>${esc(o.promo_code)} → −${o.discount} ${esc(o.currency)}</dd>` : ''}
          <dt>К оплате</dt><dd><b>${o.amount} ${esc(o.currency)}</b></dd>
          <dt>Попыток выдачи</dt><dd>${o.attempt}</dd>
          ${o.provider ? `<dt>Поставщик</dt><dd>${esc(o.provider)}</dd>` : ''}
          ${o.last_error ? `<dt>Последняя ошибка</dt><dd>${esc(o.last_error)}</dd>` : ''}
        </dl>
      </section>

      ${o.status === 'created' ? `
      <section class="util-card">
        <h2 class="util-h2">Эмуляция оплаты</h2>
        <p class="util-muted util-muted--sm">
          Реального эквайринга нет. Кнопки отправляют вебхук по контракту
          на <code>POST /webhook/payment</code>.
        </p>
        <div class="util-row">
          <button class="btn" data-pay="paid">Оплатить (успех)</button>
          <button class="btn btn--ghost" data-pay="failed">Оплатить (неуспех)</button>
        </div>
        <h3 class="util-h3">Проверка гонок прямо отсюда</h3>
        <div class="util-row">
          <button class="btn btn--ghost" data-pay="paid" data-times="50">50 параллельных вебхуков «оплачено»</button>
          <button class="btn btn--ghost" data-pay="paid" data-times="10" data-dup="1">10 повторов одного event_id</button>
        </div>
      </section>` : ''}

      <section class="util-card">
        <h2 class="util-h2">История заказа</h2>
        <ul class="timeline">
          ${o.events.map((e) => `<li><b>${esc(e.type)}</b> ${esc(e.detail || '')} <span>· ${time(e.created_at)}</span></li>`).join('')}
        </ul>
      </section>

      <p class="util-muted util-muted--sm">
        Статус обновляется автоматически. Ручной повтор выдачи — в <a href="/admin.html">админке</a>.
      </p>
    `;

    const copy = document.getElementById('copy');
    if (copy) copy.addEventListener('click', () => {
      navigator.clipboard?.writeText(o.code);
      copy.textContent = 'Скопировано';
      setTimeout(() => { copy.textContent = 'Скопировать'; }, 1500);
    });

    root.querySelectorAll('[data-pay]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        root.querySelectorAll('[data-pay]').forEach((b) => { b.disabled = true; });
        btn.textContent = 'Отправляем…';
        await fetch('/api/pay/simulate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            order_id: o.id,
            outcome: btn.dataset.pay,
            times: Number(btn.dataset.times || 1),
            duplicate: btn.dataset.dup === '1',
          }),
        }).catch(() => {});
        load();
      });
    });

    // Пока заказ не в финальном состоянии — опрашиваем статус.
    clearTimeout(poll);
    if (!o.terminal) poll = setTimeout(load, o.status === 'created' ? 2000 : 700);
  }

  load();
})();
