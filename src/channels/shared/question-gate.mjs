import { detectMessageLanguage } from './approval-gate.mjs';

const CANCEL_RE = /^(取消|取消提问|结束|不答了|no|cancel)$/i;

function questionText(question) {
  return typeof question?.question === 'string' && question.question ? question.question : '…';
}

function optionEntries(questions) {
  const entries = [];
  for (const question of questions) {
    const options = Array.isArray(question?.options)
      ? question.options.filter((option) => typeof option?.label === 'string')
      : [];
    for (const option of options) entries.push({ question, label: option.label });
  }
  return entries;
}

export function questionPromptText({ language = 'zh', questions = [] }) {
  const blocks = [];
  let optionIndex = 1;
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index] ?? {};
    const header = typeof question.header === 'string' && question.header ? question.header : null;
    const detail = typeof question.detail === 'string' && question.detail ? question.detail : null;
    const options = Array.isArray(question.options)
      ? question.options.filter((option) => typeof option?.label === 'string')
      : [];
    const multi = question.multiSelect === true;
    const lines = [header ?? (language === 'zh' ? `问题${index + 1}` : `Question ${index + 1}`), questionText(question)];
    if (detail) lines.push(detail);
    if (options.length > 0) {
      for (const option of options) {
        const desc = typeof option.description === 'string' && option.description
          ? `（${option.description}）`
          : '';
        lines.push(`${optionIndex}. ${option.label}${desc}`);
        optionIndex += 1;
      }
      lines.push(multi
        ? (language === 'zh' ? '可多选，回复多个编号，如「1,3」。' : 'You may select multiple options; reply with numbers such as "1,3".')
        : (language === 'zh' ? '请回复选项编号，如「1」。' : 'Reply with an option number, such as "1".'));
    } else {
      lines.push(language === 'zh' ? '请直接回复你的答案。' : 'Reply with your answer.');
    }
    blocks.push(lines.filter(Boolean).join('\n'));
  }
  blocks.push(language === 'zh' ? '回复「取消」结束提问。' : 'Reply "cancel" to dismiss.');
  return blocks.join('\n');
}

/**
 * Parse a user's IM reply into the Harness question answer batch, or null when
 * the reply is not a recognizable answer (so the bridge treats it as a normal
 * message). Mixed open + optioned question batches are unsupported. While a
 * single question is pending any non-cancel reply is honored as an answer:
 * option numbers/labels become `selected`, anything else becomes `custom`,
 * matching the GUI modal where free text is always accepted.
 */
export function answersFromReply(questions, rawText) {
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (!text) return null;
  if (CANCEL_RE.test(text)) return { cancelled: true };

  const hasOptions = questions.some((question) => (
    Array.isArray(question?.options) && question.options.some((option) => typeof option?.label === 'string')
  ));
  const hasOpen = questions.some((question) => (
    !Array.isArray(question?.options) || question.options.length === 0
  ));
  if (hasOpen && hasOptions) return null;
  if (hasOpen) {
    if (questions.length !== 1) return null;
    const question = questions[0];
    if (!question?.id) return null;
    return { answers: [{ id: question.id, selected: [], custom: text }] };
  }

  const entries = optionEntries(questions);
  const tokens = text.split(/[,，、\s]+/).map((token) => token.trim()).filter(Boolean);
  const picked = [];
  for (const token of tokens) {
    const numeric = /^\d+$/.test(token);
    const entry = numeric
      ? entries[Number(token) - 1]
      : entries.find((candidate) => candidate.label === token);
    if (!entry) {
      if (questions.length === 1 && questions[0]?.id) {
        return { answers: [{ id: questions[0].id, selected: [], custom: text }] };
      }
      return null;
    }
    picked.push(entry);
  }
  if (tokens.length === 0 || picked.length !== new Set(picked).size) return null;

  const answers = questions.map((question) => {
    const selected = picked
      .filter((entry) => entry.question === question)
      .map((entry) => entry.label);
    if (selected.length === 0) return null;
    if (question.multiSelect !== true && selected.length > 1) return null;
    return { id: question.id, selected };
  });
  if (answers.some((answer) => answer === null)) return null;
  return { answers };
}

/**
 * Coordinates the ask_user_question round-trip for one IM conversation: while a
 * Harness question is pending it surfaces the prompt through the channel's
 * sender and intercepts the user's reply (option number, label, free text, or
 * 取消) instead of feeding it into the session as a new prompt.
 */
export class QuestionGate {
  #pending = new Map();
  #logger;

  constructor({ logger = console } = {}) {
    this.#logger = logger;
  }

  /**
   * Called from a bridge's `onQuestion` hook. Sends the localized prompt and
   * returns a promise resolving to `{ answers }` or `{ cancelled: true }`.
   */
  request({ key, questions, sendPrompt, language = 'zh', signal }) {
    if (!key || !Array.isArray(questions) || questions.length === 0) {
      return Promise.resolve({ cancelled: true });
    }
    return new Promise((resolve) => {
      const pending = { resolve, questions };
      const onAbort = () => {
        if (this.#pending.get(key) !== pending) return;
        this.#pending.delete(key);
        resolve({ cancelled: true });
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });
      pending.cleanup = () => {
        signal?.removeEventListener?.('abort', onAbort);
      };
      this.#pending.set(key, pending);
      Promise.resolve().then(() => sendPrompt(questionPromptText({ language, questions }))).then(
        () => undefined,
        (error) => {
          this.#logger.error?.('[dsh-im] failed to send question prompt:', error);
          if (this.#pending.get(key) !== pending) return;
          this.#pending.delete(key);
          pending.cleanup?.();
          resolve({ cancelled: true });
        },
      );
    });
  }

  /** Returns true when the incoming message answered a pending question. */
  tryResolve({ key, text, messageId, markSeen }) {
    const pending = this.#pending.get(key);
    if (!pending) return false;
    const result = answersFromReply(pending.questions, text);
    if (result === null) return false;
    this.#pending.delete(key);
    pending.cleanup?.();
    pending.resolve(result);
    if (markSeen && messageId) {
      Promise.resolve(markSeen(messageId)).catch((error) => {
        this.#logger.error?.('[dsh-im] failed to mark a question reply as seen:', error);
      });
    }
    return true;
  }

  /** Clears any leftover pending question for a conversation when its turn ends. */
  cancelFor(key) {
    const pending = this.#pending.get(key);
    if (!pending) return;
    this.#pending.delete(key);
    pending.cleanup?.();
    pending.resolve({ cancelled: true });
  }
}
