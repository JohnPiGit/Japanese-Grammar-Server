/* ==========================================================================
   State & Configuration Management
   ========================================================================== */
const CONFIG_KEY = 'jp_grammar_study_config';
const ANSWERED_KEY = 'jp_grammar_answered_items';

const state = {
  config: {
    provider: 'OpenAI',
    customEndpoint: '',
    selectedModel: '',
    furiganaEnabled: false,
  },
  answeredItems: new Set(),
  // In-memory only!
  apiKey: '',
  chatHistories: new Map(),
  activeControllers: new Map(),
};

function loadStoredConfig() {
  const saved = localStorage.getItem(CONFIG_KEY);
  if (saved) {
    try {
      state.config = { ...state.config, ...JSON.parse(saved) };
    } catch (e) {
      console.error('Failed to parse config:', e);
    }
  }
}

function saveConfig() {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config));
}

function loadAnsweredItems() {
  const saved = localStorage.getItem(ANSWERED_KEY);
  if (saved) {
    try {
      state.answeredItems = new Set(JSON.parse(saved));
    } catch (e) {
      console.error('Failed to parse answered items:', e);
    }
  }
}

function saveAnsweredItems() {
  localStorage.setItem(ANSWERED_KEY, JSON.stringify(Array.from(state.answeredItems)));
}

/* ==========================================================================
   Answer history functions
   ========================================================================== */
function markItemAnswered(itemKey) {
  document.getElementById(`check-${itemKey}`)?.classList.remove('hidden');
  state.answeredItems.add(itemKey);
  saveAnsweredItems();
}

function unMarkItemAnswered(itemKey) {
  document.getElementById(`check-${itemKey}`)?.classList.add('hidden');
  state.answeredItems.delete(itemKey);
  saveAnsweredItems();
}

function makeCheckSpanButton(itemKey) {
  return `<button id="check-${itemKey}" class="check-mark-btn hidden" title="Mark as uncompleted" onclick="unMarkItemAnswered('${itemKey}')">✓</button>`;
}

function applyAnsweredCheckmarks() {
  for (const itemKey of state.answeredItems) {
    document.getElementById(`check-${itemKey}`)?.classList.remove('hidden');
  }
}

function isLLMSet() {
  const { provider, customEndpoint, selectedModel } = state.config;
  const hasEndpoint = provider !== 'Custom' || Boolean(customEndpoint.trim());
  return Boolean(state.apiKey !== '' && selectedModel && hasEndpoint);
}

/* ==========================================================================
   Multi-Provider LLM Adapters
   ========================================================================== */
const adapters = {
  OpenAI: {
    async listModels({ customEndpoint }, apiKey) {
      const url = `${customEndpoint || 'https://api.openai.com'}/v1/models`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      const data = await res.json();
      return (data.data || []).map(m => m.id).sort();
    },
    async streamChat({ customEndpoint, selectedModel }, apiKey, messages, onChunk, signal) {
      const url = `${customEndpoint || 'https://api.openai.com'}/v1/chat/completions`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: selectedModel, stream: true, messages }),
        signal,
      });
      return readSSE(res, line => {
        if (!line.startsWith('data: ') || line.includes('[DONE]')) return;
        const json = JSON.parse(line.slice(6));
        onChunk(json.choices?.[0]?.delta?.content || '');
      });
    },
  },

  Anthropic: {
    async listModels(_, apiKey) {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      });
      const data = await res.json();
      return (data.data || []).map(m => m.id).sort();
    },
    async streamChat({ selectedModel }, apiKey, messages, onChunk, signal) {
      const systemMsg = messages.find(m => m.role === 'system')?.content || '';
      const convMessages = messages.filter(m => m.role !== 'system');
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: selectedModel, stream: true, max_tokens: 1024, system: systemMsg, messages: convMessages }),
        signal,
      });
      return readSSE(res, line => {
        if (!line.startsWith('data: ')) return;
        const json = JSON.parse(line.slice(6));
        if (json.type === 'content_block_delta') onChunk(json.delta?.text || '');
      });
    },
  },

  Gemini: {
    async listModels(_, apiKey) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      const data = await res.json();
      return (data.models || [])
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => m.name.replace('models/', ''));
    },
    async streamChat({ selectedModel }, apiKey, messages, onChunk, signal) {
      const contents = messages.filter(m => m.role !== 'system').map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
      const systemPrompt = messages.find(m => m.role === 'system')?.content;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:streamGenerateContent?alt=sse&key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          ...(systemPrompt && { systemInstruction: { parts: [{ text: systemPrompt }] } }),
        }),
        signal,
      });
      return readSSE(res, line => {
        if (!line.startsWith('data: ')) return;
        const json = JSON.parse(line.slice(6));
        onChunk(json.candidates?.[0]?.content?.parts?.[0]?.text || '');
      });
    },
  },
};

// Custom provider reuses OpenAI API structure
adapters.Custom = adapters.OpenAI;

async function readSSE(response, onLine) {
  if (!response.ok) throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) onLine(line.trim());
    }
  }
}

/* ==========================================================================
   Prompt Formatting
   ========================================================================== */

const SECTION_MAP = {
  ls: { type: 'Lesson', field: 'Explanation' },
  ex: { type: 'Examples', field: '10 Example Sentences' },
  tr: { type: 'Translation Practice', field: '15 Practice Sentences' },
  resp: { type: '返答練習 Sentences', field: '15 Japanese Response Sentences' },
};

function makeSystemPrompt(sectionType, item, lesson) {
  if (sectionType === SECTION_MAP.ls.type) return formatLessonPrompt(lesson);
  if (sectionType === SECTION_MAP.ex.type) return formatExamplePrompt(item, lesson);
  if (sectionType === SECTION_MAP.tr.type) return formatPracticeTranslationPrompt(item);
  if (sectionType === SECTION_MAP.resp.type) return formatPracticeRespondPrompt(item);
  return '';
}

function formatLessonPrompt(lesson) {
  const tpl = window.SYSTEM_PROMPTS?.lesson_system_prompt || '';
  // {lesson_name}, {lesson}, {japanese}, {english}
  return tpl
    .replaceAll('{lesson_name}', lesson.Lesson || '')
    .replaceAll('{lesson}', lesson.Explanation || '')
}

function formatExamplePrompt(item, lesson) {
  const tpl = window.SYSTEM_PROMPTS?.example_system_prompt || '';
  // {lesson_name}, {lesson}, {japanese}, {english}
  return tpl
    .replaceAll('{lesson_name}', lesson.Lesson || '')
    .replaceAll('{lesson}', lesson.Explanation || '')
    .replaceAll('{japanese}', item.Japanese || '')
    .replaceAll('{english}', item.Translation || '');
}

function formatPracticeTranslationPrompt(item) {
  const tpl = window.SYSTEM_PROMPTS?.practice_translation_system_prompt || '';
  // {english}, {answers}
  return tpl
    .replaceAll('{english}', item.English || '')
    .replaceAll('{answers}', (item['Reference Answers'] || []).join('\n'));
}

function formatPracticeRespondPrompt(item) {
  const tpl = window.SYSTEM_PROMPTS?.practice_respond_system_prompt || '';
  // {statement}, {context}, {answers}
  return tpl
    .replaceAll('{statement}', item['Respond-able statement'] || '')
    .replaceAll('{context}', item.Context || '')
    .replaceAll('{answers}', (item['Reference Answers'] || []).join('\n'));
}

/* ==========================================================================
   Submission, Streaming & UI Interactions
   ========================================================================== */
function parseThinkingBlocks(rawText) {
  const thinkMatch = rawText.match(/<think>([\s\S]*?)(?:<\/think>|$)/i);
  const thinking = thinkMatch ? thinkMatch[1].trim() : '';
  const content = rawText.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
  return { thinking, content };
}

// toast is the pop-up message that fades away after a short time. Just like your toast melts back into the toaster if you're not quick enough
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add('hidden'), 3500);
}

async function handleSubmission(itemKey) {
  // first, open details dropdown to reveal answer and mark the answer as "answered"
  openDetails(itemKey);
  markItemAnswered(itemKey);
  const inputEl = document.getElementById(`input-${itemKey}`);
  const userText = inputEl.value.trim();
  if (!userText) return;

  const { sectionType, item } = getSectionTypeItem(itemKey);
  const lesson = getLesson(itemKey);
  const systemPrompt = makeSystemPrompt(sectionType, item, lesson);

  if (!isLLMSet()) {
    const standalone = `${systemPrompt}\n\nStudent Submission / Question:\n${userText}`;
    await copyToClipboard(standalone);
    showToast('Prompt copied to clipboard!');
    return;
  }

  inputEl.value = '';
  const history = state.chatHistories.get(itemKey) || [];
  history.push({ role: 'user', content: userText });
  state.chatHistories.set(itemKey, history);

  renderHistory(itemKey);
  await executeStreamingChat(itemKey, systemPrompt);
}

async function executeStreamingChat(itemKey, systemPrompt) {
  const adapter = adapters[state.config.provider];
  const history = state.chatHistories.get(itemKey);
  const messages = [{ role: 'system', content: systemPrompt }, ...history];

  const controller = new AbortController();
  state.activeControllers.set(itemKey, controller);
  toggleSubmissionState(itemKey, true);

  let fullResponse = '';
  try {
    // start streaming response. First, scroll to the bottom
    const historyEl = document.getElementById(`history-${itemKey}`);
    historyEl.scrollTop = historyEl.scrollHeight;
    await adapter.streamChat(
      state.config,
      state.apiKey,
      messages,
      chunk => {
        fullResponse += chunk;
        updateStreamingUIWithAutoScroll(historyEl, itemKey, fullResponse);
      },
      controller.signal
    );
    history.push({ role: 'assistant', content: fullResponse });
  } catch (err) {
    if (err.name !== 'AbortError') {
      showToast(`Stream error: ${err.message}`);
    }
  } finally {
    state.activeControllers.delete(itemKey);
    toggleSubmissionState(itemKey, false);
    renderHistory(itemKey);
  }
}

function updateStreamingUIWithAutoScroll(historyEl, itemKey, text) {
  const threshold = 50; // Distance in pixels from bottom considered "at the bottom"
  const prevHeight = historyEl.scrollHeight;
  const isAtBottom = prevHeight - historyEl.scrollTop - historyEl.clientHeight <= threshold;

  updateStreamingUI(itemKey, text);

  // Only scroll if the box expanded AND you were already at the bottom
  if (historyEl.scrollHeight !== prevHeight && isAtBottom) {
    historyEl.scrollTop = historyEl.scrollHeight;
  }
}

function updateStreamingUI(itemKey, text) {
  const container = document.getElementById(`live-reply-${itemKey}`);
  if (!container) return;
  const { thinking, content } = parseThinkingBlocks(text);

  let html = '';
  if (thinking) {
    html += `<details open class="thinking-block"><summary>Reasoning</summary><div>${escapeHtml(thinking)}</div></details>`;
  }
  html += `<div>${marked.parse(content || '...')}</div>`;
  container.innerHTML = html;
}

function renderHistory(itemKey) {
  const container = document.getElementById(`history-${itemKey}`);
  if (!container) return;
  const history = state.chatHistories.get(itemKey) || [];

  container.innerHTML = history.map(msg => {
    if (msg.role === 'user') {
      return `<div class="chat-msg user">${escapeHtml(msg.content)}</div>`;
    }
    const { thinking, content } = parseThinkingBlocks(msg.content);
    return `
      <div class="chat-msg assistant">
        ${thinking ? `<details class="thinking-block"><summary>Reasoning</summary><div>${escapeHtml(thinking)}</div></details>` : ''}
        <div>${marked.parse(content)}</div>
      </div>`;
  }).join('') + `<div id="live-reply-${itemKey}"></div>`;
}

function toggleSubmissionState(itemKey, isStreaming) {
  document.getElementById(`submit-btn-${itemKey}`)?.classList.toggle('hidden', isStreaming);
  document.getElementById(`stop-btn-${itemKey}`)?.classList.toggle('hidden', !isStreaming);
}

function cancelStream(itemKey) {
  state.activeControllers.get(itemKey)?.abort();
}

function clearChat(itemKey) {
  cancelStream(itemKey);
  state.chatHistories.set(itemKey, []);
  renderHistory(itemKey);
}

/* ==========================================================================
   Component & View Rendering
   ========================================================================== */
function renderSubmissionDiv(itemKey, placeholder) {
  return `
    <div class="submission-container">
      <div id="history-${itemKey}" class="chat-history"></div>
      <div class="submission-controls">
        <input type="text" id="input-${itemKey}" placeholder="${placeholder}"
               onkeydown="if(event.key==='Enter') handleSubmission('${itemKey}')">
        <button id="submit-btn-${itemKey}" class="btn btn-primary" onclick="handleSubmission('${itemKey}')">Submit</button>
        <button id="stop-btn-${itemKey}" class="btn btn-danger hidden" onclick="cancelStream('${itemKey}')">Stop</button>
        <button class="btn btn-secondary" onclick="clearChat('${itemKey}')">Clear</button>
      </div>
    </div>`;
}

function renderLessonView(lessonKey) {
  const mode = state.config.furiganaEnabled ? 'furigana' : 'normal';
  const lesson = window.LESSONS_DATA?.[lessonKey]?.[mode];
  const app = document.getElementById('app');

  if (!lesson) {
    app.innerHTML = `<p>Lesson not found. <a href="#/">Back to lessons</a></p>`;
    return;
  }

  const keys = Object.keys(window.LESSONS_DATA);
  const curIdx = keys.indexOf(lessonKey);
  const prevKey = keys[curIdx - 1];
  const nextKey = keys[curIdx + 1];

  const getKey = (type, idx) => `${lessonKey}-${type}-${idx}`;
  const lessonPlaceholder = "Ask a question about the lesson..."
  const examplePlaceholder = "Ask a question about this example..."
  const answerPlaceholder = "type your answer or follow-up question..."

  app.innerHTML = `
    <article>
      <h1 class="lesson-title">${lesson.Lesson}</h1>
      <section class="explanation-box">
        ${marked.parse(lesson.Explanation || '')}
        ${renderSubmissionDiv(getKey('ls', 0), lessonPlaceholder)}
      </section>


      <h2 class="section-title">例文 (Examples)</h2>
      ${(lesson['10 Example Sentences'] || []).map((item, idx) => `
        <div class="item-card">
          <div class="prompt-text">${item.Japanese}</div>
          <details id="details-${getKey('ex', idx)}">
            <summary>Translation</summary>
            <div class="details-content">
              <div class="meta-block"><strong>Meaning:</strong> ${item.Translation}</div>
              <div class="meta-block"><strong>Explanation:</strong> ${item.Explanation}</div>
              ${renderSubmissionDiv(getKey('ex', idx), examplePlaceholder)}
            </div>
          </details>
        </div>
      `).join('')}

      <h2 class="section-title">練習問題 (Translation Practice)</h2>
      ${(lesson['15 Practice Sentences'] || []).map((item, idx) => `
        <div class="item-card">
          <div class="prompt-text">
            ${makeCheckSpanButton(getKey('tr', idx))}
            ${idx + 1}. ${item.English}
          </div>
          <details id="details-${getKey('tr', idx)}">
            <summary>Answers</summary>
            <div class="details-content">
              <div class="meta-block"><strong>Reference Answers:</strong> ${renderReferenceAnswers(item['Reference Answers'])}</div>
              <div class="meta-block"><strong>Explanation:</strong> ${item.Explanation}</div>
            </div>
          </details>
          ${renderSubmissionDiv(getKey('tr', idx), answerPlaceholder)}
        </div>
      `).join('')}

      <h2 class="section-title">返答練習 (Response Practice)</h2>
      ${(lesson['15 Japanese Response Sentences'] || []).map((item, idx) => `
        <div class="item-card">
          <div class="prompt-text">
            ${makeCheckSpanButton(getKey('resp', idx))}
            ${idx + 1}. ${item['Respond-able statement']}
          </div>
          <details id="context-details-${getKey('resp', idx)}">
            <summary>Context</summary>
            <div class="details-content">
              <div class="meta-block"><strong>Context:</strong> ${item.Context}</div>
            </div>
          </details>
          <details id="details-${getKey('resp', idx)}">
            <summary>Answers</summary>
            <div class="details-content">
              <div class="meta-block"><strong>Reference Answers:</strong> ${renderReferenceAnswers(item['Reference Answers'])}</div>
              <div class="meta-block"><strong>Explanation:</strong> ${item.Explanation}</div>
            </div>
          </details>
          ${renderSubmissionDiv(getKey('resp', idx), answerPlaceholder)}
        </div>
      `).join('')}

      <nav class="lesson-nav">
        ${prevKey ? `<a href="#/lesson/${prevKey}" class="btn">← Previous Lesson</a>` : '<span></span>'}
        <a href="#/" class="btn">Index</a>
        ${nextKey ? `<a href="#/lesson/${nextKey}" class="btn">Next Lesson →</a>` : '<span></span>'}
      </nav>
    </article>
  `;
}

function renderIndexView() {
  const data = window.LESSONS_DATA || {};
  const mode = state.config.furiganaEnabled ? 'furigana' : 'normal';
  const app = document.getElementById('app');

  const links = Object.entries(data).map(([key, val]) => {
    const title = val[mode]?.Lesson || key;
    return `<li>${completedSentences(key)} <a href="#/lesson/${key}">${title}</a></li>`;
  }).join('');

  app.innerHTML = `
    <div class="lesson-index">
      <h1>Japanese Grammar Lessons</h1>
      <ul>${links || '<p>No lessons available.</p>'}</ul>
    </div>
  `;
}

function formatProgressRatio(current, total) {
  let statusClass = 'progress-none';
  if (total > 0 && current === total) {
    statusClass = 'progress-complete';
  } else if (current > 0) {
    statusClass = 'progress-partial';
  }
  return `<span class="progress-ratio ${statusClass}">(${current}/${total})</span>`;
}

// TODO: make function to create (x/y) for a section
// then make it a button that clears all the answers for that section
// then make that button set all answers for that section if it's empty
// then add that to each section on a lesson
// Then make certain buttons not tab-able
// Then add button class to 日本語文法
function completedSentences(lessonKey) {
  const keysBySection = allKeysBySection(lessonKey);
  const trTotal = keysBySection.tr?.length || 0;
  const respTotal = keysBySection.resp?.length || 0;

  const trAnsNum = countIntersection(state.answeredItems, keysBySection.tr || []);
  const respAnsNum = countIntersection(state.answeredItems, keysBySection.resp || []);

  const trBadge = formatProgressRatio(trAnsNum, trTotal);
  const respBadge = formatProgressRatio(respAnsNum, respTotal);

  return `${trBadge} || ${respBadge}`;
}

function router() {
  const hash = window.location.hash || '#/';
  if (hash.startsWith('#/lesson/')) {
    renderLessonView(hash.replace('#/lesson/', ''));
  } else {
    renderIndexView();
  }
  window.scrollTo(0, 0);
  applyAnsweredCheckmarks()
}

/* ==========================================================================
   Config UI & Model Fetching
   ========================================================================== */
async function fetchModels() {
  const adapter = adapters[state.config.provider];
  if (!adapter || !state.apiKey) {
    showToast('Enter an API Key to fetch models.');
    return;
  }
  const btn = document.getElementById('cfg-fetch-models-btn');
  btn.textContent = 'Fetching...';
  try {
    const models = await adapter.listModels(state.config, state.apiKey);
    populateModelSelect(models);
    showToast(`Fetched ${models.length} models.`);
  } catch (err) {
    showToast(`Error fetching models: ${err.message}`);
  } finally {
    btn.textContent = 'Fetch Models';
  }
}

function populateModelSelect(models) {
  const select = document.getElementById('cfg-model');
  select.innerHTML = '<option value="">Select a model...</option>' +
    models.map(m => `<option value="${m}">${m}</option>`).join('');

  if (models.includes(state.config.selectedModel)) {
    select.value = state.config.selectedModel;
  } else if (models.length > 0) {
    select.value = models[0];
    state.config.selectedModel = models[0];
    saveConfig();
  }
}

function bindConfigUI() {
  const providerEl = document.getElementById('cfg-provider');
  const endpointEl = document.getElementById('cfg-endpoint');
  const keyEl = document.getElementById('cfg-key');
  const modelEl = document.getElementById('cfg-model');
  const furiganaEl = document.getElementById('cfg-furigana');
  const fetchBtn = document.getElementById('cfg-fetch-models-btn');

  providerEl.value = state.config.provider;
  endpointEl.value = state.config.customEndpoint;
  furiganaEl.checked = state.config.furiganaEnabled;
  document.body.classList.toggle('hide-furigana', !state.config.furiganaEnabled);

  const toggleEndpoint = () => endpointEl.classList.toggle('hidden', providerEl.value !== 'Custom');
  toggleEndpoint();

  if (state.config.selectedModel) {
    modelEl.innerHTML = `<option value="${state.config.selectedModel}">${state.config.selectedModel}</option>`;
  }

  providerEl.addEventListener('change', () => {
    state.config.provider = providerEl.value;
    toggleEndpoint();
    saveConfig();
    if (state.apiKey) fetchModels();
  });

  endpointEl.addEventListener('input', () => {
    state.config.customEndpoint = endpointEl.value;
    saveConfig();
  });

  keyEl.addEventListener('input', () => {
    state.apiKey = keyEl.value;
  });

  // fetch models automatically after 1 second of inputting API key
  keyEl.addEventListener('blur', () => {
    if (state.apiKey && modelEl.options.length <= 1) fetchModels();
  });

  modelEl.addEventListener('change', () => {
    state.config.selectedModel = modelEl.value;
    saveConfig();
  });

  furiganaEl.addEventListener('change', () => {
    state.config.furiganaEnabled = furiganaEl.checked;
    document.body.classList.toggle('hide-furigana', !furiganaEl.checked);
    saveConfig();
    router();
  });

  fetchBtn.addEventListener('click', fetchModels);
}

/* ==========================================================================
   Item Key Resolution Helpers
   ========================================================================== */

// Build the regex pattern once from the SECTION_MAP keys for less hardcoding
const sectionCodes = Object.keys(SECTION_MAP).join('|');
const ITEM_KEY_REGEX = new RegExp(`^(.*)-(${sectionCodes})-(\\d+)$`);

function parseItemKey(itemKey) {
  const match = itemKey?.match(ITEM_KEY_REGEX);
  return match ? { lessonKey: match[1], code: match[2], index: Number(match[3]) } : null;
}

function getLesson(itemKey) {
  const parsed = parseItemKey(itemKey);
  const key = parsed ? parsed.lessonKey : itemKey;
  return window.LESSONS_DATA?.[key]?.['normal'] || null;
}

// Get both the `SectionType` and `item` corresponding to the `itemKey` (uses the normal mode, as furigana is just for the display)
function getSectionTypeItem(itemKey) {
  const parsed = parseItemKey(itemKey);
  if (!parsed || !SECTION_MAP[parsed.code]) return { sectionType: null, item: null };

  const { type, field } = SECTION_MAP[parsed.code];
  const lesson = getLesson(itemKey);
  const item = lesson?.[field]?.[parsed.index] || null;

  return { sectionType: type, item };
}

function allKeysBySection(lessonKey) {
  const lesson = window.LESSONS_DATA?.[lessonKey]?.normal;
  const keys = {};

  for (const [section, { field }] of Object.entries(SECTION_MAP)) {
    const val = lesson?.[field];

    if (Array.isArray(val)) {
      keys[section] = val.map((_, idx) => `${lessonKey}-${section}-${idx}`);
    } else if (typeof val === 'string' && val.trim()) {
      keys[section] = [`${lessonKey}-${section}-0`];
    } else {
      keys[section] = [];
    }
  }

  return keys;
}

/* ==========================================================================
   Utilities & Initialization
   ========================================================================== */
function escapeHtml(str) {
  return (str || '').replace(/[&<>'"]/g, tag => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[tag] || tag));
}


// Counts the number of elements that intersect between the itemsSet  and the itemList
function countIntersection(itemSet, itemList) {
  return itemList.reduce((count, key) => count + (itemSet.has(key) ? 1 : 0), 0);
}

function renderReferenceAnswers(answers) {
  if (!Array.isArray(answers) || answers.length === 0) return '';
  return `<ul class="reference-answers">${answers.map(a => `<li>${a}</li>`).join('')}</ul>`;
}

function openDetails(itemKey) {
  const detailsEl = document.getElementById(`details-${itemKey}`);
  if (detailsEl) {
    detailsEl.open = true;
  }

  // catch-all that tries to open the context details/dropdown (will do nothing if there is no associated dropdown)
  const contextDetailsEl = document.getElementById(`context-details-${itemKey}`);
  if (contextDetailsEl) {
    contextDetailsEl.open = true;
  }
}

// Helper func to allow for copying when testing on localhost
async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback for non-secure contexts (file:// or LAN IP testing)
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(ta);
  }
}

async function init() {
  loadStoredConfig();
  loadAnsweredItems();
  bindConfigUI();

  try {
    const res = await fetch('lessons.json');
    window.LESSONS_DATA = await res.json();
  } catch (err) {
    console.error('Failed to load lessons.json:', err);
    document.getElementById('app').innerHTML = '<p>Error loading lesson data.</p>';
  }

  window.addEventListener('hashchange', router);
  router();
}

window.addEventListener('DOMContentLoaded', init);
