import { createHash } from 'node:crypto';

export const ASYNC_INPUT_METHOD = 'item/tool/requestUserInputAsync';
const REPLY_OPEN = '<send_user_message_question_reply>';
const REPLY_CLOSE = '</send_user_message_question_reply>';

// Async questions are agent-message items, not app-server requests. They can
// remain unanswered after the model finishes its turn, including in tail:* history.
export function pendingAsyncInputs(state) {
  const turns = new Map();
  for (const turn of [...(state?.turns ?? []), ...Object.values(state?.turnHistory?.history?.entitiesByKey ?? {})]) {
    if (typeof turn?.turnId === 'string' && Array.isArray(turn.items)) turns.set(turn.turnId, turn);
  }
  const answered = new Set();
  for (const turn of turns.values()) {
    for (const item of turn.items) {
      if (item?.type !== 'userMessage' && !(item?.type === 'steeringUserMessage' && item.status === 'accepted')) continue;
      const input = item.type === 'userMessage' ? item.content : item.input;
      if (input?.length !== 1 || input[0]?.type !== 'text') continue;
      for (const reply of questionReplies(input[0].text)) answered.add(reply.questionItemId);
    }
  }
  const requests = [];
  for (const turn of turns.values()) {
    for (const item of turn.items) {
      if (item?.type !== 'agentMessage' || item.delivery !== 'async' || typeof item.id !== 'string' || !Array.isArray(item.questions)) continue;
      item.questions.slice(0, 20).forEach((question, index) => {
        if (typeof question?.title !== 'string' || !question.title.trim()) return;
        // Use the desktop's per-question identity in replies; keep Relay IDs bounded.
        const questionItemId = JSON.stringify(['request_user_input_async', item.id, index]);
        if (answered.has(questionItemId)) return;
        const id = `async-input:${createHash('sha256').update(JSON.stringify([turn.turnId, questionItemId])).digest('hex')}`;
        requests.push({ id, method: ASYNC_INPUT_METHOD, params: {
          turnId: turn.turnId, itemId: item.id, questionItemId,
          startedAtMs: turn.agentMessageCompletedAtMsById?.[item.id] ?? turn.turnStartedAtMs,
          questions: [{ id: 'answer', question: question.title.slice(0, 2_000), isOther: true,
            options: (Array.isArray(question.options) ? question.options : []).filter(value => typeof value === 'string').slice(0, 20)
              .map(label => ({ label: label.slice(0, 200), description: '' })) }],
        } });
      });
    }
  }
  return requests;
}

export function asyncQuestionReply(request, answer) {
  return `${REPLY_OPEN}\n${JSON.stringify([{
    questionItemId: request.params.questionItemId,
    question: request.params.questions[0].question,
    answer,
  }])}\n${REPLY_CLOSE}`;
}

export function questionReplyText(text) {
  const replies = questionReplies(text);
  return replies.length ? replies.map(reply => `${reply.question}\n${reply.answer}`).join('\n\n') : text;
}

function questionReplies(text) {
  if (typeof text !== 'string') return [];
  const value = text.trim();
  if (!value.startsWith(REPLY_OPEN) || !value.endsWith(REPLY_CLOSE)) return [];
  try {
    const decoded = JSON.parse(value.slice(REPLY_OPEN.length, -REPLY_CLOSE.length));
    const replies = Array.isArray(decoded) ? decoded : [decoded];
    return replies.filter(reply => typeof reply?.questionItemId === 'string'
      && typeof reply.question === 'string' && typeof reply.answer === 'string');
  } catch { return []; }
}
