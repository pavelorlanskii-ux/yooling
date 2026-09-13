import { standardSentenceParts } from './build-sentence-format.js';
import { formatDuration } from './timing.js';

function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/gu, '\\\\')
    .replace(/([`*\[\]#|<>])/gu, '\\$1')
    .replace(/(^|[^\p{L}\p{N}])_(?=\S)/gu, '$1\\_')
    .replace(/(?<=\S)_(?=$|[^\p{L}\p{N}])/gu, '$1\\_');
}

function singleLine(value) {
  return escapeText(String(value ?? '').replace(/(?:\r\n?|\n)+/gu, ' ').replace(/[ \t]+/gu, ' '));
}

function blockLine(value) {
  return escapeText(value)
    .replace(/^(\s*)([-+])(?=\s)/u, '$1\\$2')
    .replace(/^(\s*)(\d+)([.)])(?=\s)/u, '$1$2\\$3')
    .replace(/^(\s*)(?=(?:-{3,}|={3,})\s*$)/u, '$1\\');
}

function blockquote(value) {
  return String(value ?? '').split(/\r\n?|\n/u).map((line) => `> ${blockLine(line)}`).join('\n');
}

function durationLabel(durationMs) {
  return formatDuration(durationMs);
}

function tokenText(group, tokenId) {
  const token = group.tokens?.find((item) => item.id === tokenId);
  return token ? `${token.text} (${token.id})` : tokenId;
}

function standardSentenceMarkdown(group) {
  return standardSentenceParts(group).map((part) => (
    part.answerToken ? `**${singleLine(part.text)}**` : singleLine(part.text)
  )).join('');
}

function detailLines(detail, index) {
  const { group } = detail;
  const lines = [
    `## Group ${index + 1}`,
    '',
    `### ${singleLine(group.title || group.id)}`,
    '',
    `- Numeric ID: ${singleLine(group.numericId ?? '')}`,
    `- Group ID: ${singleLine(group.id)}`,
    `- Source category: ${group.official === 1 ? 'Official' : 'Unofficial'}`,
    `- Question type: ${singleLine(group.type)}`,
    `- Source: ${singleLine(group.source ?? '')}`,
    '',
    '**Instructions**',
    '',
    blockquote(group.instruction ?? ''),
    '',
  ];

  if (group.type === 'complete_words') {
    lines.push('**Source material**', '', blockquote(group.passage), '');
    for (const [itemIndex, item] of detail.items.entries()) {
      lines.push(
        `#### Blank ${itemIndex + 1}`,
        '',
        `- Your answer: ${singleLine(item.userAnswer)}`,
        `- Correct answer: ${singleLine(item.correctAnswer)}`,
        `- Result: ${item.correct ? 'Correct' : 'Incorrect'}`,
        '',
      );
    }
  } else if (group.type === 'read_daily_life' || group.type === 'read_academic_passage') {
    lines.push('**Source material**', '', `**${singleLine(group.materialTitle)}**`, '', blockquote(group.materialBody), '');
    for (const item of detail.items) {
      lines.push(`#### ${singleLine(item.question.id)}: ${singleLine(item.question.prompt)}`, '');
      for (const option of item.question.options) lines.push(`- ${singleLine(option.id)}. ${singleLine(option.text)}`);
      lines.push(
        '',
        `- Your answer: ${singleLine(item.userAnswer)}`,
        `- Correct answer: ${singleLine(item.correctAnswer)}`,
        `- Result: ${item.correct ? 'Correct' : 'Incorrect'}`,
        '',
      );
    }
  } else if (group.type === 'listen_and_response' || group.type === 'listen_and_answer') {
    lines.push(
      '**Listening material**',
      '',
      `- Audio file: ${singleLine(group.audio)}`,
      `- Material type: ${singleLine(group.materialKind ?? 'response')}`,
      '',
    );
    for (const item of detail.items) {
      const heading = group.type === 'listen_and_response'
        ? `#### Question: ${singleLine(group.instruction)}`
        : `#### ${singleLine(item.question.id)}: ${singleLine(item.question.prompt)}`;
      lines.push(heading, '');
      for (const option of item.question.options) lines.push(`- ${singleLine(option.id)}. ${singleLine(option.text)}`);
      lines.push(
        '',
        `- Your answer: ${singleLine(item.userAnswer)}`,
        `- Correct answer: ${singleLine(item.correctAnswer)}`,
        `- Result: ${item.correct ? 'Correct' : 'Incorrect'}`,
        '',
      );
    }
  } else if (group.type === 'build_sentence') {
    lines.push('**Original dialogue and material**', '');
    for (const context of group.context ?? []) lines.push(`- ${singleLine(context.speaker)}: ${singleLine(context.text)}`);
    lines.push('', `- Sentence template: ${singleLine(group.targetTemplate)}`, `- Standard answer: ${standardSentenceMarkdown(group)}`, '- All tokens:');
    for (const token of group.tokens ?? []) lines.push(`  - ${singleLine(token.text)} (${singleLine(token.id)})`);
    const item = detail.items[0];
    lines.push(
      '',
      `- Your answer: ${item.userAnswer.map((id) => singleLine(tokenText(group, id))).join(' / ')}`,
      `- Correct answer: ${item.correctAnswer.map((id) => singleLine(tokenText(group, id))).join(' / ')}`,
      `- Result: ${item.correct ? 'Correct' : 'Incorrect'}`,
      '',
    );
  } else if (group.type === 'write_email') {
    lines.push(
      '**Original scenario and requirements**',
      '',
      blockquote(group.scenario),
      '',
      `- Recipient: ${singleLine(group.recipient)}`,
      `- Subject: ${singleLine(group.subject)}`,
      '- Requirements:',
    );
    for (const requirement of group.requirements ?? []) lines.push(`  - ${singleLine(requirement)}`);
    lines.push('', '**Your response**', '', blockquote(detail.response), '', '- Not automatically scored', '');
  } else if (group.type === 'academic_discussion') {
    lines.push(
      '**Original discussion**',
      '',
      `- ${singleLine(group.professor.name)}: ${singleLine(group.professor.prompt)}`,
    );
    for (const student of group.students ?? []) lines.push(`- ${singleLine(student.name)}: ${singleLine(student.response)}`);
    lines.push('', `- Word count guidance: ${singleLine(group.minimumWordsHint)}`, '', '**Your response**', '', blockquote(detail.response), '', '- Not automatically scored', '');
  }

  lines.push(`- Time: ${durationLabel(detail.durationMs)}`, '');
  return lines;
}

export function generateMarkdownReport(result) {
  const lines = ['# TOEFull detailed practice results', ''];
  result.details.forEach((detail, index) => lines.push(...detailLines(detail, index)));
  const { summary } = result;
  lines.push(
    '# Summary',
    '',
    `- Correct: ${summary.correct}`,
    `- Scored items: ${summary.total}`,
    `- Accuracy: ${summary.accuracy === null ? 'N/A' : `${summary.accuracy.toFixed(2)}%`}`,
    `- Completed groups: ${summary.completedGroupCount}`,
    `- Total time: ${durationLabel(summary.totalDurationMs)}`,
    '',
  );
  return lines.join('\n');
}

function pad(value) {
  return String(value).padStart(2, '0');
}

export function formatReportFilename(type, date = new Date()) {
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}`;
  return `TOEFL_${type}_${stamp}.md`;
}

export { durationLabel };
