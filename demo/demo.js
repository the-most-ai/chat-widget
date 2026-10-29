// Код «сайта». Выполняется ДО виджета: вызовы копятся в очереди-массиве и выполнятся после загрузки.
(function () {
  var q = (window.AvaiChat = window.AvaiChat || []);
  var hookMode = 'mask';

  function log(line) {
    var el = document.getElementById('log');
    if (!el) return;
    el.textContent = new Date().toLocaleTimeString() + ' ' + line + '\n' + el.textContent;
  }

  q.push(['configure', {
    beforeSend: function (text) {
      if (hookMode === 'none') return text;
      if (hookMode === 'throw') throw new Error('сервис маскирования недоступен');
      if (hookMode === 'hang') return new Promise(function () {});
      return new Promise(function (resolve) {
        setTimeout(function () { resolve(text.replace(/\d{4,}/g, '[номер]')); }, 300);
      });
    },
    afterReceive: function (text) { return text; }
  }]);
  ['open', 'close', 'message', 'error', 'ready', 'rating', 'proactive'].forEach(function (name) {
    q.push(['on', name, function (d) { log(name + (d ? ' ' + JSON.stringify(d) : '')); }]);
  });
  q.push(['setContext', { site: 'demo', page: location.pathname }]);
  // Проактивные приглашения: показываются один раз на посетителя (кнопка «Сбросить приглашения» — заново).
  q.push(['configure', {
    proactive: [
      { id: 'demo-10s', text: 'Подсказать, какой тариф выбрать для офиса?', delay: 10 },
      { id: 'demo-exit', text: 'Уже уходите? Оставьте вопрос — ответим прямо здесь.', exitIntent: true }
    ]
  }]);

  document.addEventListener('avai-chat:ready', function (e) { log('avai-chat:ready v' + e.detail.version); });

  document.addEventListener('click', function (e) {
    var t = e.target.closest('button');
    if (!t) return;
    var call = t.getAttribute('data-call');
    var hook = t.getAttribute('data-hook');
    if (hook) {
      hookMode = hook;
      var m = document.getElementById('hook-mode');
      if (m) m.textContent = hook;
    } else if (call === 'context') {
      window.AvaiChat.setContext({ region: 'Москва', page: location.pathname });
      log('setContext');
    } else if (call === 'proactive-reset') {
      Object.keys(localStorage).filter(function (k) { return k.indexOf('avai-chat:') === 0; }).forEach(function (k) {
        var st = JSON.parse(localStorage.getItem(k));
        delete st.proactiveShown;
        localStorage.setItem(k, JSON.stringify(st));
      });
      location.reload();
    } else if (call === 'left') {
      var el = document.querySelector('avai-chat');
      window.AvaiChat.configure({ position: el.getAttribute('position') === 'left' ? 'right' : 'left' });
    } else if (call) {
      window.AvaiChat[call]();
    }
  });
})();
