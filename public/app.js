import { createPracticeEngine } from './practice-engine.js';
import { createRenderer } from './renderers.js';
import { bindExamChromeRefresh, resetViewport, reviewStatusMessage } from './exam-ui.js';
import { scoreSession } from './scoring.js';
import { formatReportFilename, generateMarkdownReport } from './results-report.js';
import { renderResults } from './results-view.js';
import { getBrowserStorage } from './completion-store.js';
import { completedIdsFromAttempts, confirmAndResetAttempts, createAttemptStore } from './attempt-store.js';
import { lastRecordLabel, renderAttemptHistory, sortGroupsByNumericId } from './history-view.js';
import { formatCountdown, formatDuration } from './timing.js';
import { createPhraseCaptureController } from './phrase-capture.js';
import { firstEnabledType, handleCatalogArrowKeydown, typesForSection } from './catalog-navigation.js';
import { createAudioActionRunner, createListeningAutoplayTracker } from './listening-autoplay.js';
import { createExceptionDialogController } from './exception-dialog.js';
import { createExceptionReportState } from './exception-report-state.js';
import { submissionMissingItemIds } from './submission-policy.js';

const typeDetails = {
  complete_words: { name: 'Complete the Words', chinese: '补全单词', section: 'Reading' },
  read_daily_life: { name: 'Read in Daily Life', chinese: '日常生活阅读', section: 'Reading' },
  read_academic_passage: { name: 'Read an Academic Passage', chinese: '学术文章阅读', section: 'Reading' },
  build_sentence: { name: 'Build a Sentence', chinese: '组建句子', section: 'Writing' },
  write_email: { name: 'Write an Email', chinese: '写电子邮件', section: 'Writing' },
  academic_discussion: { name: 'Academic Discussion', chinese: '学术讨论写作', section: 'Writing' },
  listen_and_response: { name: 'Listen and Choose a Response', chinese: '听句子并选择回应', section: 'Listening' },
  listen_and_answer: { name: 'Listen and Answer', chinese: '听材料并回答问题', section: 'Listening' },
};

const sectionDetails = {
  Reading: { chinese: '阅读', description: '选择一种阅读小题型' },
  Writing: { chinese: '写作', description: '选择一种写作小题型' },
  Listening: { chinese: '听力', description: '选择一种听力小题型' },
};

const isListeningType = (type) => type === 'listen_and_response' || type === 'listen_and_answer';
const reviewableSingleItemTypes = new Set(['build_sentence', 'write_email', 'academic_discussion', 'listen_and_response']);

const elements = Object.fromEntries([
  'catalog-view', 'catalog-message', 'catalog-errors', 'section-tabs', 'selected-section-heading', 'type-cards', 'group-count',
  'official-filter', 'unofficial-filter', 'custom-group-mode', 'random-count-control', 'custom-group-panel', 'custom-group-list',
  'custom-selection-count', 'refresh-catalog', 'view-history', 'reset-completion', 'start-session',
  'history-view', 'history-section-tabs', 'history-tabs', 'history-table', 'history-return', 'exam-view', 'exam-task-name', 'section-name',
  'group-progress', 'item-progress', 'exam-message', 'exam-content', 'review-button', 'back-button',
  'next-button', 'submit-group', 'abandon-group', 'pause-button', 'exit-practice', 'audio-play-pause', 'audio-replay', 'exam-timer', 'question-source', 'paused-overlay', 'results-view', 'results-message', 'result-details', 'result-summary',
  'return-home', 'submit-confirm-dialog', 'submit-confirm-title', 'submit-confirm-message', 'submit-confirm-cancel', 'submit-confirm-accept',
  'phrase-mode-button', 'phrase-confirm-popover', 'phrase-confirm-preview', 'phrase-confirm-accept', 'phrase-confirm-cancel',
  'report-exception-exam', 'report-exception-results', 'exception-dialog', 'exception-group-field', 'exception-group-select', 'exception-group-id',
  'exception-text', 'exception-count', 'exception-message', 'exception-cancel', 'exception-save',
].map((id) => [id, document.getElementById(id)]));

const attemptStore = createAttemptStore(getBrowserStorage(window));
let attempts = attemptStore.load();
let completedIds = completedIdsFromAttempts(attempts);
let sessionGroups = [];
let currentReport = null;
const engine = createPracticeEngine();
const listeningAutoplay = createListeningAutoplayTracker();
let catalog = null;
const exceptionReportState = createExceptionReportState({
  onChange: () => {
    updateExamChrome();
    if (catalog) {
      renderCustomGroupPanel();
      renderHistoryView();
    }
  },
});
const exceptionReports = exceptionReportState.getReports();
let selectedSection = 'Reading';
let selectedType = 'complete_words';
let catalogFocusLayer = 'type';
let catalogFocusPending = true;
let selectedHistorySection = 'Reading';
let selectedHistoryType = 'complete_words';
let selectedCustomGroupIds = new Set();
let renderer = null;
let timerInterval = null;
let handlingExpiration = false;
let phraseController = null;
const runAudioAction = createAudioActionRunner({
  getRenderer: () => renderer,
  setMessage: (message) => { elements['exam-message'].textContent = message; },
  updateChrome: () => updateExamChrome(),
});

function setView(name) {
  if (name !== 'exam') phraseController?.reset();
  elements['catalog-view'].hidden = name !== 'catalog';
  elements['history-view'].hidden = name !== 'history';
  elements['exam-view'].hidden = name !== 'exam';
  elements['results-view'].hidden = name !== 'results';
  resetViewport(window, elements['exam-content']);
}

function element(tagName, { className, text, attrs = {} } = {}) {
  const result = document.createElement(tagName);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  for (const [name, value] of Object.entries(attrs)) {
    if (name in result) result[name] = value;
    else result.setAttribute(name, String(value));
  }
  return result;
}

function selectedOfficials() {
  const officials = [];
  if (elements['unofficial-filter'].checked) officials.push(0);
  if (elements['official-filter'].checked) officials.push(1);
  return officials;
}

function filteredGroups(type) {
  const allowed = new Set(selectedOfficials());
  return (catalog?.groups?.[type] ?? []).filter((group) => allowed.has(group.official));
}

function customGroupModeEnabled() {
  return elements['custom-group-mode'].checked;
}

function catalogTypeEnabled(type) {
  return filteredGroups(type).length > 0;
}

function selectCatalogSection(section) {
  const sectionChanged = selectedSection !== section;
  selectedSection = section;
  if (sectionChanged || typeDetails[selectedType]?.section !== section || !catalogTypeEnabled(selectedType)) {
    const nextType = firstEnabledType(typeDetails, section, catalogTypeEnabled);
    if (selectedType !== nextType) selectedCustomGroupIds.clear();
    selectedType = nextType;
  }
}

function selectCatalogType(type) {
  if (!catalogTypeEnabled(type)) return;
  if (selectedType !== type) selectedCustomGroupIds.clear();
  selectedSection = typeDetails[type].section;
  selectedType = type;
}

function requestCatalogFocus(layer) {
  catalogFocusLayer = layer;
  catalogFocusPending = true;
}

function restoreCatalogFocus() {
  if (!catalogFocusPending) return;
  const container = catalogFocusLayer === 'section' ? elements['section-tabs'] : elements['type-cards'];
  const attribute = catalogFocusLayer === 'section' ? 'data-section' : 'data-type';
  const value = catalogFocusLayer === 'section' ? selectedSection : selectedType;
  const target = value ? container.querySelector(`[${attribute}="${value}"]`) : null;
  if (!target) return;
  target.focus();
  catalogFocusPending = false;
}

function selectedCustomGroups() {
  return sortGroupsByNumericId(filteredGroups(selectedType).filter((group) => selectedCustomGroupIds.has(group.id)));
}

function pruneCustomGroupSelection() {
  const availableIds = new Set(filteredGroups(selectedType).map((group) => group.id));
  selectedCustomGroupIds = new Set([...selectedCustomGroupIds].filter((id) => availableIds.has(id)));
}

function syncSetupAvailability() {
  const available = selectedType ? filteredGroups(selectedType).length : 0;
  elements['group-count'].max = String(Math.max(1, available));
  if (available > 0 && Number(elements['group-count'].value) > available) elements['group-count'].value = String(available);
  const hasSelection = customGroupModeEnabled() ? selectedCustomGroupIds.size > 0 : available > 0;
  elements['start-session'].disabled = !selectedType || !hasSelection || selectedOfficials().length === 0;
}

function renderCustomGroupPanel() {
  const enabled = customGroupModeEnabled();
  elements['random-count-control'].hidden = enabled;
  elements['custom-group-panel'].hidden = !enabled;
  if (!enabled) {
    syncSetupAvailability();
    return;
  }

  pruneCustomGroupSelection();
  elements['custom-group-list'].replaceChildren();
  const groups = sortGroupsByNumericId(filteredGroups(selectedType));
  if (!selectedType) {
    elements['custom-group-list'].append(element('p', { className: 'custom-group-empty', text: '请先在上方选择一种具体题型。' }));
  } else if (!groups.length) {
    elements['custom-group-list'].append(element('p', { className: 'custom-group-empty', text: '当前来源筛选下没有可选题组。' }));
  } else {
    for (const group of groups) {
      const row = element('div', { className: 'custom-group-row' });
      const exceptionCell = element('span', { className: 'custom-group-exception' });
      if (exceptionReports.has(group.id)) {
        const editButton = element('button', {
          className: 'exception-star',
          text: '*',
          attrs: { type: 'button', 'aria-label': `编辑题组 ${group.id} 的异常反馈` },
        });
        editButton.addEventListener('click', () => exceptionDialog.openForGroup(group));
        exceptionCell.append(editButton);
      }
      const groupId = element('span', { className: 'custom-group-id' });
      groupId.append(
        element('strong', { text: `#${group.numericId}` }),
        element('code', { text: group.id, attrs: { title: group.id } }),
      );
      const checkbox = element('input', {
        attrs: {
          type: 'checkbox',
          checked: selectedCustomGroupIds.has(group.id),
          'aria-label': `选择题组 ${group.id}`,
        },
      });
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedCustomGroupIds.add(group.id);
        else selectedCustomGroupIds.delete(group.id);
        elements['custom-selection-count'].textContent = `已选择 ${selectedCustomGroupIds.size} 组`;
        syncSetupAvailability();
      });
      row.append(
        exceptionCell,
        groupId,
        element('span', { className: 'custom-group-stat', text: String(attempts.get(group.id)?.attemptCount ?? 0) }),
        element('span', { className: 'custom-group-stat', text: lastRecordLabel(group, attempts.get(group.id)) }),
        element('label', { className: 'custom-group-check', attrs: { title: `选择题组 ${group.id}` } }),
      );
      row.lastChild.append(checkbox);
      elements['custom-group-list'].append(row);
    }
  }
  elements['custom-selection-count'].textContent = `已选择 ${selectedCustomGroupIds.size} 组`;
  syncSetupAvailability();
}

function renderCatalog() {
  elements['section-tabs'].replaceChildren();
  for (const [section, details] of Object.entries(sectionDetails)) {
    const tab = element('button', {
      className: `section-tab${selectedSection === section ? ' selected' : ''}`,
      attrs: { type: 'button', 'aria-pressed': selectedSection === section, 'data-section': section },
    });
    tab.append(element('strong', { text: details.chinese }), element('span', { text: section }));
    tab.addEventListener('click', () => {
      selectCatalogSection(section);
      requestCatalogFocus('section');
      renderCatalog();
    });
    elements['section-tabs'].append(tab);
  }

  const section = sectionDetails[selectedSection];
  elements['selected-section-heading'].replaceChildren(
    element('span', { text: selectedSection }),
    element('h2', { text: section.description }),
  );
  elements['type-cards'].replaceChildren();
  for (const type of typesForSection(typeDetails, selectedSection)) {
    const details = typeDetails[type];
    const groups = filteredGroups(type);
    const valid = groups.length;
    const unfinished = groups.filter((group) => !completedIds.has(group.id)).length;
    const card = element('button', { className: `task-card${selectedType === type ? ' selected' : ''}`, attrs: { type: 'button', disabled: valid === 0, 'aria-pressed': selectedType === type, 'data-type': type, 'data-question-type': type } });
    card.append(
      element('span', { className: 'task-card-section', text: details.section }),
      element('strong', { text: details.chinese }),
      element('span', { className: 'task-card-name', text: details.name }),
      element('span', { className: 'task-card-count', text: `有效 ${valid} · 未完成 ${unfinished}` }),
    );
    card.addEventListener('click', () => {
      selectCatalogType(type);
      requestCatalogFocus('type');
      renderCatalog();
    });
    elements['type-cards'].append(card);
  }

  renderCustomGroupPanel();

  const errors = catalog.errors ?? [];
  elements['catalog-errors'].replaceChildren();
  if (errors.length) {
    elements['catalog-errors'].append(element('h2', { text: `题库校验提示（${errors.length}）` }));
    const list = element('ul');
    for (const error of errors) list.append(element('li', { text: error.message }));
    elements['catalog-errors'].append(list);
  }
  restoreCatalogFocus();
}

function exceptionReportMap(payload) {
  if (!Array.isArray(payload?.reports)) throw new Error('Invalid exception feedback response.');
  return new Map(payload.reports
    .filter((report) => typeof report?.groupId === 'string' && report.groupId && typeof report.text === 'string')
    .map((report) => [report.groupId, report]));
}

async function loadExceptionReports() {
  const response = await fetch('/api/exceptions');
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Unable to load exception feedback.');
  return exceptionReportMap(body);
}

async function refreshCatalog() {
  elements['refresh-catalog'].disabled = true;
  elements['catalog-message'].textContent = '正在读取题库……';
  try {
    const response = await fetch('/api/catalog');
    if (!response.ok) throw new Error('无法读取题库');
    catalog = await response.json();
    engine.catalogReady(catalog);
    selectCatalogSection(selectedSection);
    let exceptionWarning = '';
    try {
      await exceptionReportState.load(loadExceptionReports);
    } catch (cause) {
      exceptionWarning = `Catalog loaded, but exception feedback could not be loaded: ${cause.message}`;
    }
    elements['catalog-message'].textContent = `已读取 ${Object.values(catalog.counts).reduce((sum, count) => sum + count, 0)} 个有效题组。`;
    renderCatalog();
    if (exceptionWarning) elements['catalog-message'].textContent = exceptionWarning;
  } catch (cause) {
    elements['catalog-message'].textContent = `题库读取失败：${cause.message}`;
  } finally {
    elements['refresh-catalog'].disabled = false;
  }
}

function renderHistoryView() {
  const sectionTypes = Object.entries(typeDetails).filter(([, details]) => details.section === selectedHistorySection);
  if (typeDetails[selectedHistoryType]?.section !== selectedHistorySection) selectedHistoryType = sectionTypes[0][0];

  elements['history-section-tabs'].replaceChildren();
  for (const [section, details] of Object.entries(sectionDetails)) {
    const tab = element('button', {
      className: `section-tab${selectedHistorySection === section ? ' selected' : ''}`,
      attrs: { type: 'button', 'aria-pressed': selectedHistorySection === section },
    });
    tab.append(element('strong', { text: details.chinese }), element('span', { text: section }));
    tab.addEventListener('click', () => {
      selectedHistorySection = section;
      renderHistoryView();
    });
    elements['history-section-tabs'].append(tab);
  }

  elements['history-tabs'].replaceChildren();
  for (const [type, details] of sectionTypes) {
    const tab = element('button', {
      className: 'history-tab',
      text: `${details.chinese} · ${details.name}`,
      attrs: { type: 'button', role: 'tab', 'aria-selected': selectedHistoryType === type },
    });
    tab.addEventListener('click', () => {
      selectedHistoryType = type;
      renderHistoryView();
    });
    elements['history-tabs'].append(tab);
  }
  renderAttemptHistory(
    document,
    elements['history-table'],
    catalog?.groups?.[selectedHistoryType] ?? [],
    attempts,
    exceptionReports,
    (group) => exceptionDialog.openForGroup(group),
  );
}

function openHistory() {
  if (!catalog) return;
  if (selectedType) {
    selectedHistoryType = selectedType;
    selectedHistorySection = typeDetails[selectedType].section;
  }
  renderHistoryView();
  setView('history');
}

function stopTimerUpdates() {
  if (timerInterval !== null) window.clearInterval(timerInterval);
  timerInterval = null;
}

function setPausedUi(paused) {
  elements['paused-overlay'].hidden = !paused;
  elements['pause-button'].textContent = paused ? 'Resume' : 'Pause';
  renderer?.setPracticePaused?.(paused);
  elements['exam-content'].inert = paused;
  if (paused) elements['exam-content'].setAttribute('aria-hidden', 'true');
  else elements['exam-content'].removeAttribute('aria-hidden');
}

function updateTimerDisplay() {
  const state = engine.snapshot();
  if (state.phase !== 'active' || !state.timing) return;
  elements['exam-timer'].textContent = state.timing.mode === 'fixed'
    ? '00:00'
    : state.timing.mode === 'countdown'
    ? formatCountdown(state.timing.remainingMs)
    : formatDuration(state.timing.elapsedMs);
  if (state.timing.expired && !state.currentDraft?.forcedComplete && !handlingExpiration) {
    handlingExpiration = true;
    queueMicrotask(() => {
      try { expireCurrentGroup(); } finally { handlingExpiration = false; }
    });
  }
}

function startTimerUpdates() {
  stopTimerUpdates();
  updateTimerDisplay();
  timerInterval = window.setInterval(updateTimerDisplay, 250);
}

function togglePause() {
  const state = engine.snapshot();
  if (state.phase !== 'active') return;
  const timing = state.timing.paused ? engine.resumeCurrent() : engine.pauseCurrent();
  setPausedUi(timing.paused);
  updateExamChrome();
  updateTimerDisplay();
}

function currentSubmissionMissingItemIds(state = engine.snapshot()) {
  if (!renderer) return [];
  return submissionMissingItemIds(state.currentGroup, renderer.missingItemIds(), {
    forcedComplete: state.currentDraft?.forcedComplete === true,
  });
}
function updateExamChrome() {
  const state = engine.snapshot();
  const activeGroup = state.phase === 'active' ? state.currentGroup : null;
  elements['abandon-group'].disabled = !activeGroup || state.timing?.paused === true;
  elements['report-exception-exam'].disabled = !activeGroup;
  elements['report-exception-exam'].textContent = activeGroup && exceptionReports.has(activeGroup.id)
    ? 'Report Exception *'
    : 'Report Exception';
  if (state.phase !== 'active' || !renderer) return;
  const details = typeDetails[state.currentGroup.type];
  const progress = renderer.progress();
  const listening = isListeningType(state.currentGroup.type);
  const navigation = renderer.navigationState?.() ?? null;
  const reviewable = state.reviewable === true;
  const lastGroup = state.currentGroupIndex === state.groupCount - 1;
  const singleItemGroup = !reviewable && progress.total === 1 && navigation?.phase !== 'overview';
  const allAnswered = currentSubmissionMissingItemIds(state).length === 0;
  elements['exam-task-name'].textContent = details.name;
  elements['exam-task-name'].hidden = listening;
  elements['section-name'].textContent = details.section;
  elements['question-source'].textContent = `题目来源：${state.currentGroup.id}`;
  if (listening) {
    const previousItems = sessionGroups.slice(0, state.currentGroupIndex).reduce((sum, group) => sum + (group.questions?.length ?? 1), 0);
    const totalItems = sessionGroups.reduce((sum, group) => sum + (group.questions?.length ?? 1), 0);
    const onOverview = navigation?.phase === 'overview';
    elements['group-progress'].hidden = onOverview;
    elements['group-progress'].textContent = onOverview ? '' : `Question ${previousItems + Math.max(1, progress.current)} of ${totalItems}`;
    elements['item-progress'].hidden = true;
  } else {
    elements['group-progress'].hidden = false;
    elements['item-progress'].hidden = false;
    elements['group-progress'].textContent = `Group ${state.currentGroupIndex + 1} of ${state.groupCount}`;
    elements['item-progress'].textContent = `Item ${progress.current} of ${progress.total}`;
  }
  const supportsItemNavigation = ['read_daily_life', 'read_academic_passage'].includes(state.currentGroup.type);
  const paused = state.timing?.paused === true;
  elements['review-button'].hidden = listening;
  elements['back-button'].hidden = listening && !reviewable;
  elements['next-button'].hidden = reviewable && lastGroup;
  elements['submit-group'].hidden = reviewable ? !lastGroup : listening || singleItemGroup;
  elements['submit-group'].textContent = reviewable ? 'Submit All' : 'Submit Group';
  elements['pause-button'].hidden = listening;
  elements['review-button'].disabled = paused;
  elements['submit-group'].disabled = paused || (reviewable && !allAnswered);
  elements['back-button'].disabled = reviewable
    ? paused || state.currentGroupIndex === 0
    : paused || !supportsItemNavigation || progress.index === 0;
  elements['next-button'].disabled = reviewable
    ? paused || !allAnswered
    : singleItemGroup
    ? paused || !allAnswered
    : listening
      ? paused || !(navigation?.canNext || navigation?.canSubmit)
      : paused || !supportsItemNavigation || progress.index === progress.total - 1;

  const showAudio = listening && renderer.canShowAudioControls?.();
  const audioState = renderer.audioState?.() ?? {};
  const audioPlaying = audioState.available && !audioState.paused && !audioState.ended;
  elements['audio-play-pause'].hidden = !showAudio;
  elements['audio-replay'].hidden = !showAudio;
  elements['audio-play-pause'].textContent = audioPlaying ? 'Pause' : 'Resume';
  elements['audio-play-pause'].disabled = false;
  elements['audio-replay'].disabled = false;
  phraseController?.sync();
  updateTimerDisplay();
}

function openCurrentGroup(message = '') {
  exceptionDialog.close();
  closeSubmitConfirmation();
  phraseController?.clearPending();
  const previousRenderer = renderer;
  renderer = null;
  previousRenderer?.dispose?.();
  const state = engine.snapshot();
  let nextRenderer;
  nextRenderer = createRenderer(state.currentGroup, {
    onNavigate: () => resetViewport(window, elements['exam-content']),
    onStateChange: () => {
      if (renderer === nextRenderer) updateExamChrome();
    },
  });
  renderer = nextRenderer;
  renderer.render(elements['exam-content']);
  const draft = state.currentDraft?.answer;
  if (draft) {
    if (state.currentGroup.type === 'build_sentence') {
      for (const [index, tokenId] of (draft.slotTokenIds ?? draft.tokenIds ?? []).entries()) {
        if (tokenId) renderer.placeToken(tokenId, index);
      }
    } else if (state.currentGroup.type === 'write_email' || state.currentGroup.type === 'academic_discussion') {
      renderer.setResponse(draft.text ?? '');
    } else if (state.currentGroup.type === 'listen_and_response') {
      renderer.selectOption(draft.responses?.response ?? '');
    }
  }
  elements['exam-message'].textContent = message;
  setPausedUi(false);
  updateExamChrome();
  setView('exam');
  if (listeningAutoplay.claim(state.currentGroup.id, isListeningType(state.currentGroup.type))) {
    void runAudioAction('toggleAudio', nextRenderer);
  }
  startTimerUpdates();
}

async function startSession() {
  if (!selectedType || !catalog) return;
  const count = Number(elements['group-count'].value);
  const officials = selectedOfficials();
  const available = filteredGroups(selectedType).length;
  const customMode = customGroupModeEnabled();
  const groupIds = customMode ? selectedCustomGroups().map((group) => group.id) : [];
  if (!officials.length) {
    elements['catalog-message'].textContent = '请至少勾选“官方”或“非官方”中的一种来源。';
    return;
  }
  if (customMode && groupIds.length === 0) {
    elements['catalog-message'].textContent = '请至少勾选一个题组。';
    return;
  }
  if (!customMode && (!Number.isInteger(count) || count < 1 || count > available)) {
    elements['catalog-message'].textContent = '请输入可用范围内的正整数题组数量。';
    elements['group-count'].focus();
    return;
  }
  elements['start-session'].disabled = true;
  elements['catalog-message'].textContent = '正在创建练习……';
  try {
    const response = await fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(customMode
        ? { type: selectedType, groupIds, officials }
        : { type: selectedType, count, completedIds: [...completedIds], officials }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? '无法创建练习');
    sessionGroups = body.groups;
    currentReport = null;
    listeningAutoplay.reset();
    engine.startSession(sessionGroups, { reviewable: reviewableSingleItemTypes.has(selectedType) });
    openCurrentGroup();
  } catch (cause) {
    elements['catalog-message'].textContent = `创建练习失败：${cause.message}`;
    syncSetupAvailability();
  }
}

function moveWithinGroup(direction) {
  if (!renderer || engine.snapshot().timing?.paused) return;
  phraseController?.clearPending();
  const moved = renderer[direction]();
  if (moved) elements['exam-message'].textContent = '';
  updateExamChrome();
}

function moveBetweenReviewableGroups(direction) {
  if (!renderer || engine.snapshot().timing?.paused) return;
  const result = engine.navigateReviewable({
    direction,
    missingItemIds: currentSubmissionMissingItemIds(),
    answer: renderer.normalizedAnswer(),
  });
  if (result.status === 'missing') {
    elements['exam-message'].textContent = 'Answer this item before moving to the next group.';
    renderer.focusItem(result.firstMissingItemId);
    updateExamChrome();
    return;
  }
  if (result.status === 'moved') openCurrentGroup();
}

function moveBack() {
  if (engine.snapshot().reviewable) moveBetweenReviewableGroups('back');
  else moveWithinGroup('back');
}

function moveNext() {
  const state = engine.snapshot();
  if (!renderer || state.timing?.paused) return;
  const progress = renderer.progress();
  const navigation = renderer.navigationState?.() ?? null;
  if (state.reviewable) {
    moveBetweenReviewableGroups('next');
    return;
  }
  if (progress.total === 1 && navigation?.phase !== 'overview') {
    completeGroupSubmission();
    return;
  }
  if (isListeningType(state.currentGroup?.type)) {
    if (navigation?.canSubmit) submitGroup();
    else if (navigation?.canNext) moveWithinGroup('next');
    return;
  }
  moveWithinGroup('next');
}

function showReview() {
  const state = engine.snapshot();
  if (state.timing?.paused) return;
  const missing = renderer?.missingItemIds() ?? [];
  if (['complete_words', 'build_sentence'].includes(state.currentGroup?.type) && missing.length) {
    elements['exam-message'].textContent = `${missing.length} 个空位未填写；提交后将计为错误。`;
    return;
  }
  const total = renderer?.progress().total ?? 0;
  elements['exam-message'].textContent = reviewStatusMessage(missing.length, total);
}
async function saveReportAutomatically(report, message) {
  elements['return-home'].disabled = true;
  try {
    const response = await fetch('/api/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? '保存失败');
    elements['results-message'].textContent = `${message} 报告已自动保存到：${body.path}`;
  } catch (cause) {
    elements['results-message'].textContent = `${message} 自动保存报告失败：${cause.message}。请确认本地服务仍在运行且“练题报告”文件夹可写。`;
  } finally {
    elements['return-home'].disabled = false;
  }
}

function finishSession(message = '详细结果按题组列出，汇总位于页面末尾。') {
  exceptionDialog.close();
  stopTimerUpdates();
  setPausedUi(false);
  renderer?.dispose?.();
  renderer = null;
  const state = engine.snapshot();
  const scored = scoreSession(sessionGroups, state.records);
  attempts = attemptStore.recordSession(scored.details);
  completedIds = completedIdsFromAttempts(attempts);
  renderResults(document, elements['result-details'], elements['result-summary'], scored);
  currentReport = {
    markdown: generateMarkdownReport(scored),
    filename: formatReportFilename(selectedType, new Date()),
  };
  elements['results-message'].textContent = `${message} 正在自动保存报告……`;
  setView('results');
  void saveReportAutomatically(currentReport, message);
}

function expireCurrentGroup() {
  exceptionDialog.close();
  if (!renderer) return;
  closeSubmitConfirmation();
  const result = engine.expireCurrent({ answer: renderer.normalizedAnswer() });
  if (result.status === 'not-expired' || result.status === 'already-handled') return;
  if (result.status === 'advanced') {
    openCurrentGroup(engine.snapshot().reviewable
      ? 'Time is up for the previous group. You can use Back to review or revise it before submitting all groups.'
      : 'Time is up. Your response was submitted automatically.');
    return;
  }
  if (result.status === 'reviewable-expired-last') {
    elements['exam-message'].textContent = 'Time is up. You can review earlier groups or select Submit All.';
    updateExamChrome();
    return;
  }
  finishSession('Time is up. Your response was submitted automatically. Detailed results are below.');
}

function closeSubmitConfirmation() {
  if (elements['submit-confirm-dialog'].open) elements['submit-confirm-dialog'].close();
}

function completeGroupSubmission() {
  if (!renderer || engine.snapshot().timing?.paused) return;
  if (engine.snapshot().timing?.expired) {
    expireCurrentGroup();
    return;
  }
  const state = engine.snapshot();
  const missingItemIds = currentSubmissionMissingItemIds(state);
  const result = state.reviewable
    ? engine.submitReviewable({ missingItemIds, answer: renderer.normalizedAnswer() })
    : engine.submitCurrent({ missingItemIds, answer: renderer.normalizedAnswer() });
  if (result.status === 'missing') {
    if (result.groupId && result.groupId !== state.currentGroup.id) openCurrentGroup('Answer every item before submitting all groups.');
    else elements['exam-message'].textContent = state.reviewable
      ? 'Answer every item before submitting all groups.'
      : 'Answer every item before submitting this group.';
    renderer.focusItem(result.firstMissingItemId);
    updateExamChrome();
    return;
  }
  if (result.status === 'cancelled') return;
  if (result.status === 'advanced') {
    openCurrentGroup();
    return;
  }
  finishSession();
}

function submitGroup() {
  if (!renderer || engine.snapshot().timing?.paused) return;
  if (engine.snapshot().timing?.expired) {
    expireCurrentGroup();
    return;
  }
  const state = engine.snapshot();
  const missingItemIds = currentSubmissionMissingItemIds(state);
  if (missingItemIds.length) {
    elements['exam-message'].textContent = 'Answer every item before submitting this group.';
    renderer.focusItem(missingItemIds[0]);
    updateExamChrome();
    return;
  }
  phraseController?.clearPending();
  elements['submit-confirm-title'].textContent = state.reviewable ? 'Submit all groups?' : 'Submit this group?';
  elements['submit-confirm-message'].textContent = state.reviewable
    ? 'All groups in this practice will be submitted and scored together. You cannot revise them after submitting.'
    : 'You cannot return to this group after submitting it. Any active timer will continue while this message is open.';
  elements['submit-confirm-accept'].textContent = state.reviewable ? 'Submit All' : 'Submit Group';
  elements['submit-confirm-dialog'].showModal();
}

function abandonCurrentGroup() {
  const state = engine.snapshot();
  if (!renderer || state.phase !== 'active' || state.timing?.paused) return;
  phraseController?.clearPending();
  exceptionDialog.close();
  closeSubmitConfirmation();
  const result = engine.abandonCurrent();
  sessionGroups = engine.snapshot().sessionGroups;
  if (result.status === 'abandoned') {
    stopTimerUpdates();
    renderer.dispose?.();
    renderer = null;
    currentReport = null;
    listeningAutoplay.reset();
    setPausedUi(false);
    renderCatalog();
    elements['catalog-message'].textContent = '已放弃本次练习中的全部题组，未生成作答记录。';
    setView('catalog');
    return;
  }
  if (result.status === 'results') {
    finishSession('已放弃当前题组；它未计入本次结果。详细结果如下。');
    return;
  }
  openCurrentGroup('已放弃当前题组；它不会计入作答记录。');
}
function resetCompletion() {
  if (!confirmAndResetAttempts(attemptStore, (message) => window.confirm(message))) return;
  attempts = new Map();
  completedIds = completedIdsFromAttempts(attempts);
  elements['catalog-message'].textContent = '作答记录已重置。';
  if (catalog) {
    renderCatalog();
    renderHistoryView();
  }
}

function exitPractice() {
  exceptionDialog.close();
  closeSubmitConfirmation();
  stopTimerUpdates();
  renderer?.dispose?.();
  renderer = null;
  sessionGroups = [];
  currentReport = null;
  window.location.reload();
}

function sourceFilterChanged() {
  selectCatalogSection(selectedSection);
  renderCatalog();
  elements['catalog-message'].textContent = selectedOfficials().length
    ? '来源筛选已更新，请选择题型或开始练习。'
    : '请至少勾选“官方”或“非官方”中的一种来源。';
}

async function savePhraseCapture(payload) {
  const response = await fetch('/api/phrase', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? '保存失败');
  return body;
}

async function saveExceptionReport({ groupId, text }) {
  return exceptionReportState.save({ groupId, text }, async (payload) => {
    const response = await fetch('/api/exceptions', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? 'Unable to save exception feedback.');
    return body.report;
  });
}

const exceptionDialog = createExceptionDialogController({
  dialog: elements['exception-dialog'],
  groupField: elements['exception-group-field'],
  groupSelect: elements['exception-group-select'],
  groupId: elements['exception-group-id'],
  textarea: elements['exception-text'],
  count: elements['exception-count'],
  message: elements['exception-message'],
  cancelButton: elements['exception-cancel'],
  saveButton: elements['exception-save'],
  getReports: () => exceptionReports,
  onSave: saveExceptionReport,
});

phraseController = createPhraseCaptureController({
  window,
  root: elements['exam-content'],
  modeButton: elements['phrase-mode-button'],
  popover: elements['phrase-confirm-popover'],
  preview: elements['phrase-confirm-preview'],
  confirmButton: elements['phrase-confirm-accept'],
  cancelButton: elements['phrase-confirm-cancel'],
  getContext: () => {
    const state = engine.snapshot();
    return {
      type: state.currentGroup?.type,
      source: state.currentGroup?.id,
      paused: state.phase !== 'active' || state.timing?.paused === true,
    };
  },
  onConfirm: savePhraseCapture,
  onMessage: (message) => { elements['exam-message'].textContent = message; },
});

elements['refresh-catalog'].addEventListener('click', refreshCatalog);
elements['report-exception-exam'].addEventListener('click', () => {
  phraseController?.clearPending();
  const state = engine.snapshot();
  if (state.phase === 'active' && state.currentGroup) exceptionDialog.openForGroup(state.currentGroup);
});
elements['report-exception-results'].addEventListener('click', () => {
  if (sessionGroups.length > 0) exceptionDialog.openForGroups(sessionGroups);
});
function navigateCatalogArrow(event) {
  handleCatalogArrowKeydown(event, {
    sectionDetails,
    typeDetails,
    selectedType,
    isTypeEnabled: catalogTypeEnabled,
    onNavigate: ({ section, type, focusLayer }) => {
      if (type) selectCatalogType(type);
      else selectCatalogSection(section);
      requestCatalogFocus(focusLayer);
      renderCatalog();
    },
  });
}

elements['section-tabs'].addEventListener('keydown', navigateCatalogArrow);
elements['type-cards'].addEventListener('keydown', navigateCatalogArrow);
elements['official-filter'].addEventListener('change', sourceFilterChanged);
elements['unofficial-filter'].addEventListener('change', sourceFilterChanged);
elements['custom-group-mode'].addEventListener('change', renderCustomGroupPanel);
elements['view-history'].addEventListener('click', openHistory);
elements['history-return'].addEventListener('click', () => setView('catalog'));
elements['reset-completion'].addEventListener('click', resetCompletion);
elements['start-session'].addEventListener('click', startSession);
elements['review-button'].addEventListener('click', showReview);
elements['back-button'].addEventListener('click', moveBack);
elements['next-button'].addEventListener('click', moveNext);
elements['submit-group'].addEventListener('click', submitGroup);
elements['abandon-group'].addEventListener('click', abandonCurrentGroup);
elements['pause-button'].addEventListener('click', togglePause);
elements['exit-practice'].addEventListener('click', exitPractice);
elements['audio-play-pause'].addEventListener('click', () => runAudioAction('toggleAudio'));
elements['audio-replay'].addEventListener('click', () => runAudioAction('replayAudio'));
elements['submit-confirm-cancel'].addEventListener('click', closeSubmitConfirmation);
elements['submit-confirm-accept'].addEventListener('click', () => {
  closeSubmitConfirmation();
  completeGroupSubmission();
});
bindExamChromeRefresh(elements['exam-content'], updateExamChrome);
elements['return-home'].addEventListener('click', () => window.location.reload());

setView('catalog');
refreshCatalog();
