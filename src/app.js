/* ==========================================================================
   State & Configuration Management
   ========================================================================== */
const CONFIG_KEY = 'jp_grammar_study_config';
const ANSWERED_KEY = 'jp_grammar_answered_items';

// These must be the same as the `SECTION_MAP` keys!
const LESSON_SEC = 'ls'; // lesson/explanation
const EXAMPLE_SEC = 'ex'; // examples
const TRANSLATION_SEC = 'tr'; // translation practice
const RESPONSE_SEC = 'resp'; // response practice

const SECTION_MAP = {
  ls: { type: 'Lesson', field: 'Explanation' },
  ex: { type: 'Examples', field: '10 Example Sentences' },
  tr: { type: 'Translation Practice', field: '15 Practice Sentences' },
  resp: { type: '返答練習 Sentences', field: '15 Japanese Response Sentences' },
};

// Other constants (i'm kinda inconsistent)
const INPUT_PREFIX = 'input-';


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
  lessonKey: '',
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

function _markAnswered(itemKey) {
  document.getElementById(`check-${itemKey}`)?.classList.remove('hidden');
  state.answeredItems.add(itemKey);
}

function _unMarkAnswered(itemKey) {
  document.getElementById(`check-${itemKey}`)?.classList.add('hidden');
  state.answeredItems.delete(itemKey);
}

function markItemAnswered(itemKey) {
  _markAnswered(itemKey);
  saveAnsweredItems();
  updateLessonProgress(state.lessonKey);
}

function unMarkItemAnswered(itemKey) {
  _unMarkAnswered(itemKey);
  saveAnsweredItems();
  updateLessonProgress(state.lessonKey);
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
   SSE Utility
   ========================================================================== */
async function* parseSSE(response) {
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
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ') || trimmed.includes('[DONE]')) continue;
      try {
        yield JSON.parse(trimmed.slice(6));
      } catch {
        // Discard keep-alives or non-JSON payloads
      }
    }
  }
}

/* ==========================================================================
   Retry & Network Utilities
   ========================================================================== */

/**
 * Abort-aware delay helper.
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

/**
 * Wraps window.fetch with exponential backoff and jitter.
 * Automatically catches 429 (Rate Limit) and 5xx (Server) errors.
 */
async function fetchWithRetry(url, options = {}, {
  maxRetries = 3,
  initialDelay = 1000,
  backoffFactor = 2,
  maxDelay = 15000,
} = {}) {
  const signal = options.signal;
  let attempt = 0;
  let delay = initialDelay;

  while (true) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    try {
      const res = await fetch(url, options);

      // Statuses that warrant a retry
      const isRetryable = res.status === 429 || (res.status >= 500 && res.status <= 504);

      if (!res.ok && isRetryable && attempt < maxRetries) {
        attempt++;
        let waitTime = delay;

        // Honor standard Retry-After headers if provided by OpenAI / Anthropic
        const retryAfter = res.headers.get('retry-after');
        if (retryAfter) {
          const seconds = Number(retryAfter);
          if (!Number.isNaN(seconds)) {
            waitTime = seconds * 1000;
          } else {
            const parsedDate = Date.parse(retryAfter);
            if (!Number.isNaN(parsedDate)) {
              waitTime = Math.max(0, parsedDate - Date.now());
            }
          }
        } else {
          // Exponential backoff with ±20% jitter
          waitTime = Math.min(maxDelay, delay * (0.8 + 0.4 * Math.random()));
          delay *= backoffFactor;
        }

        showToast(`Request busy (${res.status}). Retrying in ${(waitTime / 1000).toFixed(1)}s (attempt ${attempt}/${maxRetries})...`);
        await sleep(waitTime, signal);
        continue;
      }

      return res;
    } catch (err) {
      // Do not retry if cancelled intentionally by user
      if (err.name === 'AbortError' || signal?.aborted) {
        throw err;
      }

      // Retry on network disconnects / DNS dropouts
      if (attempt < maxRetries) {
        attempt++;
        const waitTime = Math.min(maxDelay, delay * (0.8 + 0.4 * Math.random()));
        delay *= backoffFactor;

        showToast(`Network error. Retrying in ${(waitTime / 1000).toFixed(1)}s (attempt ${attempt}/${maxRetries})...`);
        await sleep(waitTime, signal);
        continue;
      }

      throw err;
    }
  }
}

/* ==========================================================================
   Multi-Provider LLM Adapters
   ========================================================================== */
const adapters = {
  OpenAI: {
    async listModels({ customEndpoint }, apiKey) {
      const url = `${customEndpoint || 'https://api.openai.com'}/v1/models`;
      const res = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) throw new Error(`HTTP Error ${res.status}: ${res.statusText}`);
      const data = await res.json();
      return (data.data || []).map(m => m.id).sort();
    },
    async *streamChat({ customEndpoint, selectedModel }, apiKey, messages, signal) {
      const url = `${customEndpoint || 'https://api.openai.com'}/v1/chat/completions`;
      const res = await fetchWithRetry(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: selectedModel, stream: true, messages }),
        signal,
      });

      for await (const chunk of parseSSE(res)) {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        const thinking = delta.reasoning_content || delta.reasoning;
        if (thinking) yield { type: 'thinking', delta: thinking };
        if (delta.content) yield { type: 'text', delta: delta.content };
      }
    },
  },

  Anthropic: {
    async listModels(_, apiKey) {
      const res = await fetchWithRetry('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      });
      if (!res.ok) throw new Error(`HTTP Error ${res.status}: ${res.statusText}`);
      const data = await res.json();
      return (data.data || []).map(m => m.id).sort();
    },
    async *streamChat({ selectedModel }, apiKey, messages, signal) {
      const systemMsg = messages.find(m => m.role === 'system')?.content || '';
      const convMessages = messages.filter(m => m.role !== 'system');

      const res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: selectedModel,
          stream: true,
          max_tokens: 4096,
          system: systemMsg,
          messages: convMessages,
        }),
        signal,
      });

      for await (const chunk of parseSSE(res)) {
        if (chunk.type !== 'content_block_delta') continue;
        const { delta } = chunk;

        if (delta?.type === 'thinking_delta' && delta.thinking) {
          yield { type: 'thinking', delta: delta.thinking };
        } else if (delta?.type === 'text_delta' && delta.text) {
          yield { type: 'text', delta: delta.text };
        }
      }
    },
  },

  Gemini: {
    async listModels(_, apiKey) {
      const res = await fetchWithRetry(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      if (!res.ok) throw new Error(`HTTP Error ${res.status}: ${res.statusText}`);
      const data = await res.json();
      return (data.models || [])
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => m.name.replace('models/', ''));
    },
    async *streamChat({ selectedModel }, apiKey, messages, signal) {
      const contents = messages.filter(m => m.role !== 'system').map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
      const systemPrompt = messages.find(m => m.role === 'system')?.content;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:streamGenerateContent?alt=sse&key=${apiKey}`;
      const res = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          ...(systemPrompt && { systemInstruction: { parts: [{ text: systemPrompt }] } }),
        }),
        signal,
      });

      for await (const chunk of parseSSE(res)) {
        const parts = chunk.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (!part.text) continue;
          yield { type: part.thought ? 'thinking' : 'text', delta: part.text };
        }
      }
    },
  },
};

adapters.Custom = adapters.OpenAI;

/* ==========================================================================
   Prompt Formatting
   ========================================================================== */

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
  const inputEl = document.getElementById(INPUT_PREFIX + itemKey);
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
  const historyEl = document.getElementById(`history-${itemKey}`);
  historyEl.scrollTop = historyEl.scrollHeight;
  await executeStreamingChat(itemKey, systemPrompt);
}

/* ==========================================================================
   Streaming & History Management
   ========================================================================== */
async function executeStreamingChat(itemKey, systemPrompt) {
  const adapter = adapters[state.config.provider];
  const history = state.chatHistories.get(itemKey) || [];

  // Exclude thinking from past context when submitting to the LLM
  const apiMessages = [
    { role: 'system', content: systemPrompt },
    ...history.map(({ role, content }) => ({ role, content })),
  ];

  const controller = new AbortController();
  state.activeControllers.set(itemKey, controller);
  toggleSubmissionState(itemKey, true);

  const assistantMessage = { role: 'assistant', content: '', thinking: '' };
  const historyEl = document.getElementById(`history-${itemKey}`);

  try {
    for await (const chunk of adapter.streamChat(state.config, state.apiKey, apiMessages, controller.signal)) {
      if (chunk.type === 'thinking') {
        assistantMessage.thinking += chunk.delta;
      } else {
        assistantMessage.content += chunk.delta;
      }
      updateStreamingUIWithAutoScroll(historyEl, itemKey, assistantMessage);
    }
    history.push(assistantMessage);
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

function updateStreamingUIWithAutoScroll(historyEl, itemKey, message) {
  const threshold = 50;
  const prevHeight = historyEl.scrollHeight;
  const isAtBottom = prevHeight - historyEl.scrollTop - historyEl.clientHeight <= threshold;

  updateStreamingUI(itemKey, message);

  if (historyEl.scrollHeight !== prevHeight && isAtBottom) {
    historyEl.scrollTop = historyEl.scrollHeight;
  }
}

function updateStreamingUI(itemKey, { thinking, content }) {
  const container = document.getElementById(`live-reply-${itemKey}`);
  if (!container) return;

  const thinkingBlock = thinking
    ? `<details open class="thinking-block"><summary>Reasoning</summary><div>${escapeHtml(thinking)}</div></details>`
    : '';

  const contentBlock = content
    ? `<div>${DOMPurify.sanitize(marked.parse(content))}</div>`
    : (thinking ? '' : '<div>...</div>');

  container.innerHTML = thinkingBlock + contentBlock;
}

function renderHistory(itemKey) {
  const container = document.getElementById(`history-${itemKey}`);
  if (!container) return;
  const history = state.chatHistories.get(itemKey) || [];

  container.innerHTML = history.map(msg => {
    if (msg.role === 'user') {
      return `<div class="chat-msg user">${escapeHtml(msg.content)}</div>`;
    }
    return `
      <div class="chat-msg assistant">
        ${msg.thinking ? `<details class="thinking-block"><summary>Reasoning</summary><div>${escapeHtml(msg.thinking)}</div></details>` : ''}
        <div>${DOMPurify.sanitize(marked.parse(msg.content || ''))}</div>
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
        <input type="text" id="${INPUT_PREFIX}${itemKey}" placeholder="${placeholder}"
               onkeydown="if(event.key==='Enter') handleSubmission('${itemKey}')">
        <button id="submit-btn-${itemKey}" class="btn btn-primary" tabindex="-1" onclick="handleSubmission('${itemKey}')">Submit</button>
        <button id="stop-btn-${itemKey}" class="btn btn-danger hidden" tabindex="-1" onclick="cancelStream('${itemKey}')">Stop</button>
        <button class="btn btn-secondary" tabindex="-1" onclick="clearChat('${itemKey}')">Clear</button>
      </div>
    </div>`;
}

function renderLessonView(lessonKey) {
  const mode = state.config.furiganaEnabled ? 'furigana' : 'normal';
  const lesson = window.LESSONS_DATA?.[lessonKey]?.[mode];
  const app = document.getElementById('app');
  const keysBySection = allKeysBySection(lessonKey);

  if (!lesson) {
    app.innerHTML = `<p>Lesson not found. <a href="#/">Back to lessons</a></p>`;
    return;
  }

  document.getElementById('top-bar-title').textContent = lesson.Lesson || '';

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
        <section class="explanation-box">${DOMPurify.sanitize(marked.parse(lesson.Explanation || ''))}</section>
        ${renderSubmissionDiv(getKey(LESSON_SEC, 0), lessonPlaceholder)}
      </section>


      <h2 class="section-title">例文 (Examples)</h2>
      ${(lesson['10 Example Sentences'] || []).map((item, idx) => `
        <div class="item-card">
          <div class="prompt-text">${idx + 1}. ${item.Japanese}</div>
          <details id="details-${getKey(EXAMPLE_SEC, idx)}">
            <summary>Translation</summary>
            <div class="details-content">
              <div class="meta-block"><strong>Meaning:</strong> ${item.Translation}</div>
              <div class="meta-block"><strong>Explanation:</strong> ${item.Explanation}</div>
              ${renderSubmissionDiv(getKey(EXAMPLE_SEC, idx), examplePlaceholder)}
            </div>
          </details>
        </div>
      `).join('')}

      <h2 class="section-title">翻訳練習 (Translation Practice) ${progressBySectionWithID(keysBySection, lessonKey, TRANSLATION_SEC)}</h2>
      ${(lesson['15 Practice Sentences'] || []).map((item, idx) => `
        <div class="item-card">
          <div class="prompt-text">
            ${makeCheckSpanButton(getKey(TRANSLATION_SEC, idx))}
            ${idx + 1}. ${item.English}
          </div>
          <details id="details-${getKey(TRANSLATION_SEC, idx)}" tabindex="-1">
            <summary>Answers</summary>
            <div class="details-content">
              <div class="meta-block"><strong>Reference Answers:</strong> ${renderReferenceAnswers(item['Reference Answers'])}</div>
              <div class="meta-block"><strong>Explanation:</strong> ${item.Explanation}</div>
            </div>
          </details>
          ${renderSubmissionDiv(getKey(TRANSLATION_SEC, idx), answerPlaceholder)}
        </div>
      `).join('')}

      <h2 class="section-title">返答練習 (Response Practice) ${progressBySectionWithID(keysBySection, lessonKey, RESPONSE_SEC)}</h2>
      ${(lesson['15 Japanese Response Sentences'] || []).map((item, idx) => `
        <div class="item-card">
          <div class="prompt-text">
            ${makeCheckSpanButton(getKey(RESPONSE_SEC, idx))}
            ${idx + 1}. ${item['Respond-able statement']}
          </div>
          <details id="context-details-${getKey(RESPONSE_SEC, idx)}" tabindex="-1">
            <summary>Context</summary>
            <div class="details-content">
              <div class="meta-block"><strong>Context:</strong> ${item.Context}</div>
            </div>
          </details>
          <details id="details-${getKey(RESPONSE_SEC, idx)}" tabindex="-1">
            <summary>Answers</summary>
            <div class="details-content">
              <div class="meta-block"><strong>Reference Answers:</strong> ${renderReferenceAnswers(item['Reference Answers'])}</div>
              <div class="meta-block"><strong>Explanation:</strong> ${item.Explanation}</div>
            </div>
          </details>
          ${renderSubmissionDiv(getKey(RESPONSE_SEC, idx), answerPlaceholder)}
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
  document.getElementById('top-bar-title').textContent = '';

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

function toggleSectionProgress(lessonKey, section) {
  const keys = allKeysBySection(lessonKey)[section] || [];
  const action = countIntersection(state.answeredItems, keys) > 0 ? _unMarkAnswered : _markAnswered;

  keys.forEach(action);
  saveAnsweredItems();
  updateLessonProgress(lessonKey);
}

function formatProgressRatio(current, total, lessonKey, section) {
  let statusClass = 'progress-none';
  if (total > 0 && current === total) {
    statusClass = 'progress-complete';
  } else if (current > 0) {
    statusClass = 'progress-partial';
  }

  const hint = current > 0 ? 'CLEAR progress' : 'Mark all COMPLETE';
  const clickAttr = (lessonKey && section)
    ? `onclick="toggleSectionProgress('${lessonKey}', '${section}')"`
    : '';

  return `<button type="button" class="progress-ratio-btn ${statusClass}" tabindex="-1" title="${hint}" ${clickAttr}>(${current}/${total})</button>`;
}

// a section is a key of SECTION_MAP (i.e. ls, ex, tr, resp)
function progressBySection(keysBySection, lessonKey, section) {
  const total = keysBySection[section]?.length || 0;
  const ansNum = countIntersection(state.answeredItems, keysBySection[section] || []);
  return formatProgressRatio(ansNum, total, lessonKey, section);
}

function _sectionProgressID(lessonKey, section) {
  return `${lessonKey}-${section}-section-progress`
}

// a setion is a key of SECTION_MAP (i.e. ls, ex, tr, resp)
function progressBySectionWithID(keysBySection, lessonKey, section) {
  const progress = progressBySection(keysBySection, lessonKey, section);
  return `<span id="${_sectionProgressID(lessonKey, section)}">${progress}</span>`;
}

function updateLessonProgress(lessonKey) {
  const keysBySection = allKeysBySection(lessonKey);
  const trBadge = progressBySection(keysBySection, lessonKey, TRANSLATION_SEC);
  const respBadge = progressBySection(keysBySection, lessonKey, RESPONSE_SEC);

  const trEl = document.getElementById(_sectionProgressID(lessonKey, TRANSLATION_SEC));
  const respEl = document.getElementById(_sectionProgressID(lessonKey, RESPONSE_SEC));

  if (trEl) trEl.innerHTML = trBadge;
  if (respEl) respEl.innerHTML = respBadge;
}

function completedSentences(lessonKey) {
  const keysBySection = allKeysBySection(lessonKey);
  return `${progressBySectionWithID(keysBySection, lessonKey, TRANSLATION_SEC)} || ${progressBySectionWithID(keysBySection, lessonKey, RESPONSE_SEC)}`;
}

function router() {
  const hash = window.location.hash || '#/';
  if (hash.startsWith('#/lesson/')) {
    state.lessonKey = hash.replace('#/lesson/', '')
    renderLessonView(state.lessonKey);
  } else {
    renderIndexView();
  }
  window.scrollTo(0, 0);
  applyAnsweredCheckmarks()
}

/* ==========================================================================
   Config UI & Model Fetching
   ========================================================================== */

function bindHowToUseModal() {
  const modal = document.getElementById('how-to-use-modal');
  const openBtn = document.getElementById('how-to-use-btn');
  const closeBtn = document.getElementById('how-to-use-close-btn');
  const contentEl = document.getElementById('how-to-use-content');

  if (!modal || !openBtn) return;

  openBtn.addEventListener('click', () => {
    const markdown = window.HOW_TO_USE || 'No instructions provided.';
    contentEl.innerHTML = DOMPurify.sanitize(marked.parse(markdown));
    modal.showModal();
  });

  closeBtn?.addEventListener('click', () => modal.close());

  // Close when clicking outside the dialog box
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.close();
  });
}

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
  if (!models || models.length === 0) return;

  const select = document.getElementById('cfg-model');
  const savedModel = state.config.selectedModel;

  select.innerHTML = '<option value="">Select a model...</option>' +
    models.map(m => `<option value="${m}">${m}</option>`).join('');

  if (savedModel && models.includes(savedModel)) {
    select.value = savedModel;
  } else if (models.length > 0) {
    select.value = models[0];
    state.config.selectedModel = models[0];
  }
}

function handleGlobalKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
    const activeEl = document.activeElement;

    // Check if the user is currently inside an input box for an item
    const isItemInput = activeEl?.id?.startsWith(INPUT_PREFIX);
    if (!isItemInput) return;

    // If they have selected text inside the input, let native copy work
    if (activeEl.selectionStart !== activeEl.selectionEnd) return;

    // Extract the itemKey
    const itemKey = activeEl.id.slice(INPUT_PREFIX.length);

    // Only cancel if this specific item is actually streaming
    if (state.activeControllers.has(itemKey)) {
      e.preventDefault();
      cancelStream(itemKey);
      showToast('Streaming stopped');
    }
  }
}

function bindConfigUI() {
  const providerEl = document.getElementById('cfg-provider');
  const endpointEl = document.getElementById('cfg-endpoint');
  const keyEl = document.getElementById('cfg-key');
  const usernameEl = document.getElementById('cfg-username');
  const keyForm = document.getElementById('cfg-key-form');
  const modelEl = document.getElementById('cfg-model');
  const furiganaEl = document.getElementById('cfg-furigana');
  const fetchBtn = document.getElementById('cfg-fetch-models-btn');

  providerEl.value = state.config.provider;
  endpointEl.value = state.config.customEndpoint;
  if (usernameEl) usernameEl.value = state.config.provider;
  furiganaEl.checked = state.config.furiganaEnabled;
  document.body.classList.toggle('hide-furigana', !state.config.furiganaEnabled);

  const toggleEndpoint = () => endpointEl.classList.toggle('hidden', providerEl.value !== 'Custom');
  toggleEndpoint();

  providerEl.addEventListener('change', () => {
    state.config.provider = providerEl.value;
    if (usernameEl) usernameEl.value = providerEl.value; // Syncs credential label in Google Password Manager
    toggleEndpoint();
    saveConfig();

    // Reset key state on provider change so keys aren't mixed between providers
    state.apiKey = '';
    keyEl.value = '';
    modelEl.innerHTML = '<option value="">Select or fetch model...</option>';
  });

  endpointEl.addEventListener('input', () => {
    state.config.customEndpoint = endpointEl.value;
    saveConfig();
  });

  // Handle explicit submission (triggers the password manager prompt and fetches models)
  keyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const key = keyEl.value.trim();
    if (!key) return;

    state.apiKey = key;
    fetchModels();
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
  bindHowToUseModal();

  try {
    const res = await fetch('lessons.json');
    window.LESSONS_DATA = await res.json();
  } catch (err) {
    console.error('Failed to load lessons.json:', err);
    document.getElementById('app').innerHTML = '<p>Error loading lesson data.</p>';
  }

  window.addEventListener('hashchange', router);
  window.addEventListener('keydown', handleGlobalKeydown);
  router();
}

window.addEventListener('DOMContentLoaded', init);
