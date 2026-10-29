import { describe, expect, it } from 'vitest';
import { normalizeRules, urlMatches } from '../src/ui/proactive';

describe('проактивные правила', () => {
  it('кривые правила отбрасываются, остальные нормализуются', () => {
    const rules = normalizeRules([
      { id: 'tariffs', text: '  Помочь выбрать тариф?  ', url: '/tariffs', delay: 30 },
      { id: 'exit', text: 'Уже уходите?', exitIntent: true, open: true },
      { id: '', text: 'без id' },
      { id: 'no-text' },
      'мусор',
      { id: 'bad-delay', text: 'x', delay: -5 },
    ]);
    expect(rules).toEqual([
      { id: 'tariffs', text: 'Помочь выбрать тариф?', url: '/tariffs', delay: 30, exitIntent: false, open: false },
      { id: 'exit', text: 'Уже уходите?', url: undefined, delay: undefined, exitIntent: true, open: true },
      { id: 'bad-delay', text: 'x', url: undefined, delay: undefined, exitIntent: false, open: false },
    ]);
    expect(normalizeRules('не массив')).toEqual([]);
  });

  it('адрес: без условия, подстрока, строка-регулярка и RegExp', () => {
    const href = 'https://shop.example.ru/moskva/tariffs/pro?utm=1';
    expect(urlMatches({ id: 'a', text: 'x' }, href)).toBe(true);
    expect(urlMatches({ id: 'a', text: 'x', url: '/tariffs' }, href)).toBe(true);
    expect(urlMatches({ id: 'a', text: 'x', url: '/internet' }, href)).toBe(false);
    expect(urlMatches({ id: 'a', text: 'x', url: '/\\/tariffs\\/(pro|start)/' }, href)).toBe(true);
    expect(urlMatches({ id: 'a', text: 'x', url: /utm=2/ }, href)).toBe(false);
    // Кривая регулярка не ломает виджет — правило просто не срабатывает.
    expect(urlMatches({ id: 'a', text: 'x', url: '/(/' }, href)).toBe(false);
  });
});
