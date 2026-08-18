const APPROVE_RE = /^(同意|批准|允许|确认|是|好|好的|可以|行|ok|yes|y|approve|sure)$/i;
const REJECT_RE = /^(拒绝|不同意|取消|否|不行|不要|不可以|no|n|deny|reject|cancel)$/i;

const CJK_RE = /[\u3400-\u9fff]/;

export function detectMessageLanguage(text) {
  return CJK_RE.test(typeof text === 'string' ? text : '') ? 'zh' : 'en';
}

export function approvalOutcomeFromText(text) {
  const normalized = typeof text === 'string' ? text.trim().toLowerCase() : '';
  if (APPROVE_RE.test(normalized)) return 'allowed-once';
  if (REJECT_RE.test(normalized)) return 'rejected';
  return null;
}

export function isApprovalReplyText(text) {
  return approvalOutcomeFromText(text) !== null;
}

export function approvalPromptText({ language = 'zh', approval = {} }) {
  const reason = typeof approval.reason === 'string' && approval.reason ? approval.reason : null;
  const toolName = typeof approval.toolName === 'string' && approval.toolName ? approval.toolName : null;
  if (language === 'en') {
    return [
      'Approval required:',
      toolName ? `Tool: ${toolName}` : '',
      reason ? `Reason: ${reason}` : '',
      '',
      'Reply "yes" to continue, or "no" to cancel.',
    ].filter(Boolean).join('\n');
  }
  return [
    '需要你审批：',
    toolName ? `工具：${toolName}` : '',
    reason ? `原因：${reason}` : '',
    '',
    '回复「同意」继续，回复「拒绝」取消。',
  ].filter(Boolean).join('\n');
}

/**
 * Coordinates the approval round-trip for one IM conversation: while a Harness
 * approval is pending it remembers the conversation key, surfaces the prompt
 * through the channel's sender, and intercepts the user's "同意 / 拒绝" reply
 * instead of feeding it into the session as a new prompt.
 */
export class ApprovalGate {
  #pending = new Map();
  #logger;

  constructor({ logger = console } = {}) {
    this.#logger = logger;
  }

  /**
   * Called from a bridge's `onApproval` hook. Sends the localized prompt and
   * returns a promise that resolves to 'allowed-once', 'rejected', or
   * 'cancelled' (abort or send failure).
   */
  request({ key, approval, sendPrompt, language = 'zh' }) {
    if (!key || !approval) return Promise.resolve('cancelled');
    return new Promise((resolve) => {
      const pending = { resolve, approval };
      const onAbort = () => {
        if (this.#pending.get(key) !== pending) return;
        this.#pending.delete(key);
        resolve('cancelled');
      };
      approval.signal?.addEventListener('abort', onAbort, { once: true });
      pending.cleanup = () => approval.signal?.removeEventListener('abort', onAbort);
      this.#pending.set(key, pending);
      Promise.resolve().then(() => sendPrompt(approvalPromptText({ language, approval }))).then(
        () => undefined,
        (error) => {
          this.#logger.error?.('[dsh-im] failed to send approval prompt:', error);
          if (this.#pending.get(key) !== pending) return;
          this.#pending.delete(key);
          pending.cleanup?.();
          resolve('cancelled');
        },
      );
    });
  }

  /**
   * Returns true when the incoming message was an approval answer that settled
   * the pending request; the bridge must then mark the message as seen and
   * stop normal processing.
   */
  tryResolve({ key, text, messageId, markSeen }) {
    const pending = this.#pending.get(key);
    if (!pending) return false;
    const outcome = approvalOutcomeFromText(text);
    if (outcome === null) return false;
    this.#pending.delete(key);
    pending.cleanup?.();
    pending.resolve(outcome);
    if (markSeen && messageId) {
      Promise.resolve(markSeen(messageId)).catch((error) => {
        this.#logger.error?.('[dsh-im] failed to mark an approval reply as seen:', error);
      });
    }
    return true;
  }

  /** Clears any leftover pending request for a conversation, e.g. when its turn ends. */
  cancelFor(key) {
    const pending = this.#pending.get(key);
    if (!pending) return;
    this.#pending.delete(key);
    pending.cleanup?.();
    pending.resolve('cancelled');
  }
}
