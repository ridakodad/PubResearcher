/**
 * Mini-langage de document : quelques blocs, rendus en Markdown ou en HTML autonome.
 *
 * Le rapport « Méthodes et traçabilité » doit s'ouvrir partout — dans un éditeur de texte, collé dans un
 * article, imprimé depuis un navigateur — sans dépendance. Il est donc construit une fois, en blocs, puis
 * rendu dans le format voulu.
 */

export type Block =
  | { type: 'title'; text: string; subtitle?: string }
  | { type: 'h2'; text: string }
  | { type: 'h3'; text: string }
  | { type: 'p'; text: string }
  | { type: 'note'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'table'; head: string[]; rows: string[][]; align?: ('left' | 'right')[] }
  | { type: 'code'; text: string };

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Cellule de tableau Markdown : les barres verticales et les retours à la ligne la casseraient. */
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function renderMarkdown(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'title':
        out.push(`# ${b.text}`, ...(b.subtitle ? ['', `*${b.subtitle}*`] : []), '');
        break;
      case 'h2':
        out.push(`## ${b.text}`, '');
        break;
      case 'h3':
        out.push(`### ${b.text}`, '');
        break;
      case 'p':
        out.push(b.text, '');
        break;
      case 'note':
        out.push(...b.text.split('\n').map((line) => `> ${line}`), '');
        break;
      case 'list':
        out.push(...b.items.map((item) => `- ${item}`), '');
        break;
      case 'table': {
        const align = b.align ?? b.head.map(() => 'left' as const);
        out.push(
          `| ${b.head.map(cell).join(' | ')} |`,
          `| ${align.map((a) => (a === 'right' ? '---:' : '---')).join(' | ')} |`,
          ...b.rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
          '',
        );
        break;
      }
      case 'code':
        out.push('```', b.text, '```', '');
        break;
    }
  }
  return out.join('\n').trimEnd() + '\n';
}

export function renderHtml(blocks: Block[], options: { lang: string; title: string }): string {
  const body = blocks
    .map((b) => {
      switch (b.type) {
        case 'title':
          return `<header><h1>${escapeHtml(b.text)}</h1>${b.subtitle ? `<p class="subtitle">${escapeHtml(b.subtitle)}</p>` : ''}</header>`;
        case 'h2':
          return `<h2>${escapeHtml(b.text)}</h2>`;
        case 'h3':
          return `<h3>${escapeHtml(b.text)}</h3>`;
        case 'p':
          return `<p>${escapeHtml(b.text)}</p>`;
        case 'note':
          return `<aside>${b.text.split('\n').map((line) => `<p>${escapeHtml(line)}</p>`).join('')}</aside>`;
        case 'list':
          return `<ul>${b.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
        case 'table': {
          const align = b.align ?? b.head.map(() => 'left' as const);
          const th = b.head.map((h, i) => `<th class="${align[i]}">${escapeHtml(h)}</th>`).join('');
          const rows = b.rows
            .map((row) => `<tr>${row.map((c, i) => `<td class="${align[i] ?? 'left'}">${escapeHtml(c)}</td>`).join('')}</tr>`)
            .join('');
          return `<div class="table"><table><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table></div>`;
        }
        case 'code':
          return `<pre>${escapeHtml(b.text)}</pre>`;
      }
    })
    .join('\n');

  return `<!doctype html>
<html lang="${escapeHtml(options.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>
  :root { color-scheme: light dark; --ink: #0c0a26; --muted: #5a6184; --line: #d9ddf0; --soft: #f1f3fb; --accent: #3d55c0; --bg: #ffffff; }
  @media (prefers-color-scheme: dark) { :root { --ink: #f2f0ff; --muted: #a29fce; --line: #332e66; --soft: #1b1745; --accent: #8ea6ff; --bg: #0f0b26; } }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.6 system-ui, "Segoe UI", sans-serif; }
  main { max-width: 56rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
  h1 { font-size: 1.9rem; line-height: 1.2; margin: 0 0 .25rem; }
  h2 { font-size: 1.3rem; margin: 2.2rem 0 .6rem; padding-top: 1rem; border-top: 1px solid var(--line); }
  h3 { font-size: 1.05rem; margin: 1.4rem 0 .4rem; }
  .subtitle { color: var(--muted); margin: 0 0 1.5rem; }
  p, ul { max-width: 46rem; }
  aside { border-left: 3px solid var(--accent); background: var(--soft); padding: .1rem 1rem; margin: 1rem 0; border-radius: 0 6px 6px 0; }
  .table { overflow-x: auto; margin: 1rem 0; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; font-variant-numeric: tabular-nums; }
  th, td { padding: .4rem .65rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { text-align: left; font-weight: 600; background: var(--soft); white-space: nowrap; }
  .right { text-align: right; }
  pre { background: var(--soft); padding: .8rem 1rem; border-radius: 6px; overflow-x: auto; font-size: .85rem; }
  @media print { body { font-size: 11pt; } main { padding: 0; } h2 { break-after: avoid; } table, aside { break-inside: avoid; } }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}
