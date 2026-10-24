export const tableCaption = (title: string, scope: string) => `${title} · 范围：${scope} · 资料状态：未联网核验，不能保证名单完整或最新`;
export function renderTestTable(node: HTMLElement, columns: readonly string[], rows: readonly (readonly string[])[], caption: string) {
  const label = document.createElement('caption'); label.textContent = caption;
  const head = document.createElement('thead'); const headings = document.createElement('tr');
  for (const text of columns) { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = text; headings.append(cell); }
  head.append(headings);
  const body = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (let index = 0; index < columns.length; index++) { const cell = document.createElement('td'); cell.textContent = row[index] ?? ''; tr.append(cell); }
    body.append(tr);
  }
  node.replaceChildren(label, head, body);
}
