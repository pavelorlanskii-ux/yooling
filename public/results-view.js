import { standardSentenceParts } from './build-sentence-format.js';
import { durationLabel } from './results-report.js';

function node(document, tagName, { className, text } = {}) {
  const result = document.createElement(tagName);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function line(document, label, value) {
  return node(document, 'p', { text: `${label}: ${value ?? ''}` });
}

function objectiveResult(document, article, item, displayAnswer = (value) => value) {
  article.append(
    line(document, 'Your answer', displayAnswer(item.userAnswer)),
    line(document, 'Correct answer', displayAnswer(item.correctAnswer)),
    line(document, 'Result', item.correct ? 'Correct' : 'Incorrect'),
  );
}

function standardSentence(document, group) {
  const result = node(document, 'p');
  result.append(document.createTextNode('Standard answer: '));
  for (const part of standardSentenceParts(group)) {
    result.append(part.answerToken
      ? node(document, 'strong', { text: part.text })
      : document.createTextNode(part.text));
  }
  return result;
}

function appendChoiceItem(document, article, item, heading) {
  const itemSection = node(document, 'section', { className: 'result-item' });
  itemSection.append(node(document, 'h5', { text: heading }));
  const options = node(document, 'ul', { className: 'result-options' });
  for (const option of item.question.options) options.append(node(document, 'li', { text: `${option.id}. ${option.text}` }));
  itemSection.append(options);
  objectiveResult(document, itemSection, item);
  article.append(itemSection);
}

function appendListeningMetadata(document, article, group) {
  article.append(
    node(document, 'h4', { text: 'Listening material' }),
    line(document, 'Audio file', group.audio),
    line(document, 'Material type', group.materialKind ?? 'response'),
  );
}

function appendGroupBody(document, article, detail) {
  const { group } = detail;
  article.append(node(document, 'h4', { text: 'Instructions' }), node(document, 'p', { className: 'preserve-lines', text: group.instruction }));

  if (group.type === 'complete_words') {
    article.append(node(document, 'h4', { text: 'Source material' }), node(document, 'p', { className: 'preserve-lines', text: group.passage }));
    detail.items.forEach((item, index) => {
      const itemSection = node(document, 'section', { className: 'result-item' });
      itemSection.append(node(document, 'h5', { text: `Blank ${index + 1}` }));
      objectiveResult(document, itemSection, item);
      article.append(itemSection);
    });
  } else if (group.type === 'read_daily_life' || group.type === 'read_academic_passage') {
    article.append(node(document, 'h4', { text: 'Source material' }), node(document, 'h5', { text: group.materialTitle }), node(document, 'p', { className: 'preserve-lines', text: group.materialBody }));
    for (const item of detail.items) {
      const itemSection = node(document, 'section', { className: 'result-item' });
      itemSection.append(node(document, 'h5', { text: `${item.question.id}: ${item.question.prompt}` }));
      const options = node(document, 'ul', { className: 'result-options' });
      for (const option of item.question.options) options.append(node(document, 'li', { text: `${option.id}. ${option.text}` }));
      itemSection.append(options);
      objectiveResult(document, itemSection, item);
      article.append(itemSection);
    }
  } else if (group.type === 'listen_and_response') {
    appendListeningMetadata(document, article, group);
    appendChoiceItem(document, article, detail.items[0], `Question: ${group.instruction}`);
  } else if (group.type === 'listen_and_answer') {
    appendListeningMetadata(document, article, group);
    for (const item of detail.items) appendChoiceItem(document, article, item, `${item.question.id}: ${item.question.prompt}`);
  } else if (group.type === 'build_sentence') {
    article.append(node(document, 'h4', { text: 'Original dialogue and material' }));
    for (const context of group.context ?? []) article.append(line(document, context.speaker, context.text));
    article.append(line(document, 'Sentence template', group.targetTemplate), standardSentence(document, group));
    const tokens = node(document, 'ul', { className: 'result-options' });
    for (const token of group.tokens ?? []) tokens.append(node(document, 'li', { text: `${token.text} (${token.id})` }));
    article.append(tokens);
    const tokenAnswer = (ids) => ids.map((id) => {
      const token = group.tokens.find((candidate) => candidate.id === id);
      return token ? `${token.text} (${token.id})` : id;
    }).join(' / ');
    objectiveResult(document, article, detail.items[0], tokenAnswer);
  } else if (group.type === 'write_email') {
    article.append(
      node(document, 'h4', { text: 'Original scenario and requirements' }),
      node(document, 'p', { className: 'preserve-lines', text: group.scenario }),
      line(document, 'Recipient', group.recipient),
      line(document, 'Subject', group.subject),
    );
    const requirements = node(document, 'ul');
    for (const requirement of group.requirements ?? []) requirements.append(node(document, 'li', { text: requirement }));
    article.append(requirements, node(document, 'h4', { text: 'Your response' }), node(document, 'p', { className: 'preserve-lines', text: detail.response }), node(document, 'p', { className: 'unscored', text: 'Not automatically scored' }));
  } else if (group.type === 'academic_discussion') {
    article.append(node(document, 'h4', { text: 'Original discussion' }), line(document, group.professor.name, group.professor.prompt));
    for (const student of group.students ?? []) article.append(line(document, student.name, student.response));
    article.append(line(document, 'Word count guidance', group.minimumWordsHint), node(document, 'h4', { text: 'Your response' }), node(document, 'p', { className: 'preserve-lines', text: detail.response }), node(document, 'p', { className: 'unscored', text: 'Not automatically scored' }));
  }
}

export function renderResults(document, detailsRoot, summaryRoot, result) {
  detailsRoot.replaceChildren();
  result.details.forEach((detail, index) => {
    const article = node(document, 'article', { className: 'result-group' });
    article.append(
      node(document, 'h2', { text: `Group ${index + 1}: ${detail.group.title || detail.group.id}` }),
      line(document, 'Source', detail.group.source),
    );
    appendGroupBody(document, article, detail);
    article.append(line(document, 'Time', durationLabel(detail.durationMs)));
    detailsRoot.append(article);
  });

  const { summary } = result;
  summaryRoot.replaceChildren(
    node(document, 'h2', { text: 'Summary' }),
    line(document, 'Correct', summary.correct),
    line(document, 'Scored items', summary.total),
    line(document, 'Accuracy', summary.accuracy === null ? 'N/A' : `${summary.accuracy.toFixed(2)}%`),
    line(document, 'Completed groups', summary.completedGroupCount),
    line(document, 'Total time', durationLabel(summary.totalDurationMs)),
  );
}
