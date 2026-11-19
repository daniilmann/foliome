import type { LogProtocolRow } from '../store/action-protocol.ts';

type ProtocolRow = Readonly<{
  atMs: number;
  sourceId: string;
  accessId: string;
  actor: string;
  method: string;
  snapshotNumber: number;
  nodeNumber: number | null;
  label?: string;
  decision: 'allowed' | 'blocked';
  reason: string;
  outcome: string | null;
}>;

export declare const renderProtocol: typeof render;
declare const exports: { renderProtocol: typeof render };

const reasons: Readonly<Record<string, string>> = {
  allowed: 'Действие разрешено',
  unsupported: 'Метод не поддерживается',
  'not-declared': 'Действие не объявлено',
  'value-not-allowed': 'Значение не разрешено',
  'not-found': 'Узел не найден',
  ambiguous: 'Узел неоднозначен',
  hidden: 'Узел скрыт',
  disabled: 'Узел недоступен',
  covered: 'Узел перекрыт',
  stale: 'Снимок устарел',
  'foreign-frame': 'Чужой фрейм',
  'foreign-host': 'Чужой хост',
  'bad-url': 'Недопустимый адрес',
  'form-repeat': 'Повторная отправка формы',
  'popup-blocked': 'Всплывающее окно заблокировано',
  'download-refused': 'Загрузка отклонена',
  'secret-field': 'Поле секрета',
  unclassified: 'Действие не классифицировано',
  'blocked-payment': 'Платёж заблокирован',
  'blocked-change': 'Изменение заблокировано',
  limit: 'Достигнут предел',
  internal: 'Внутренняя ошибка',
};

function escapeText(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function render(rows: readonly ProtocolRow[], logEvents: readonly LogProtocolRow[] = []): string {
  const headings = [
    'Время UTC',
    'Источник',
    'Доступ',
    'Участник',
    'Метод',
    'Снимок',
    'Узел',
    'Подпись',
    'Вердикт',
    'Причина',
    'Код',
    'Итог',
  ];
  const header = headings.map((heading) => `<th scope="col">${heading}</th>`).join('');
  const cells = (values: (string | number)[]) =>
    `<tr>${values.map((value) => `<td>${escapeText(value)}</td>`).join('')}</tr>`;
  const body = rows
    .map((row) =>
      cells([
        new Date(row.atMs).toISOString(),
        row.sourceId,
        row.accessId,
        row.actor,
        row.method,
        row.snapshotNumber,
        row.nodeNumber ?? '',
        row.label ?? '',
        row.decision === 'allowed' ? 'разрешено' : 'заблокировано',
        Object.hasOwn(reasons, row.reason) ? reasons[row.reason] : '',
        row.reason,
        row.outcome ?? '',
      ]),
    )
    .join('');
  const diagnostics = logEvents
    .map((event) =>
      cells([
        new Date(event.atMs).toISOString(),
        '',
        '',
        'kernel',
        '',
        '',
        '',
        '',
        '',
        'Технический журнал недоступен',
        event.code,
        '',
      ]),
    )
    .join('');
  return `<table><thead><tr>${header}</tr></thead><tbody>${body}${diagnostics}</tbody></table>`;
}

exports.renderProtocol = render;
