const unscoredTypes = new Set(['write_email', 'academic_discussion']);

function node(document, tagName, { className, text, attrs = {} } = {}) {
  const result = document.createElement(tagName);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  for (const [name, value] of Object.entries(attrs)) result.setAttribute(name, String(value));
  return result;
}

export function sortGroupsByNumericId(groups) {
  return [...groups].sort((left, right) => left.numericId - right.numericId || left.id.localeCompare(right.id));
}

export function lastRecordLabel(group, attempt) {
  if (unscoredTypes.has(group.type)) return 'Н/Д';
  if (!attempt?.attemptCount || !Number.isFinite(attempt.lastAccuracy)) return '—';
  return attempt.lastAccuracy === 100 ? 'Верно' : 'Ошибка';
}

export function renderAttemptHistory(document, root, groups, attempts, exceptionReports = new Map(), onEditException = () => {}) {
  const table = node(document, 'table', { className: 'history-table' });
  const head = node(document, 'thead');
  const headingRow = node(document, 'tr');
  headingRow.append(node(document, 'th', { text: '', attrs: { scope: 'col' } }));
  for (const heading of ['№', 'ID группы', 'Источник', 'Попыток', 'Последний результат']) {
    headingRow.append(node(document, 'th', { text: heading, attrs: { scope: 'col' } }));
  }
  head.append(headingRow);

  const body = node(document, 'tbody');
  for (const group of sortGroupsByNumericId(groups)) {
    const attempt = attempts.get(group.id) ?? { attemptCount: 0, lastAccuracy: null };
    const row = node(document, 'tr');
    const exceptionCell = node(document, 'td');
    if (exceptionReports.has(group.id)) {
      const editButton = node(document, 'button', {
        className: 'exception-star',
        text: '*',
        attrs: { type: 'button', 'aria-label': `Редактировать замечание для группы ${group.id}` },
      });
      editButton.addEventListener('click', () => onEditException(group));
      exceptionCell.append(editButton);
    }
    row.append(
      exceptionCell,
      node(document, 'td', { text: String(group.numericId) }),
      node(document, 'td', { className: 'history-string-id', text: group.id }),
      node(document, 'td', { text: group.official === 1 ? 'Официальный' : 'Неофициальный' }),
      node(document, 'td', { text: String(attempt.attemptCount) }),
      node(document, 'td', { text: lastRecordLabel(group, attempt) }),
    );
    body.append(row);
  }
  table.append(head, body);
  root.replaceChildren(table);
}
