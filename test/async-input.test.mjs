import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

for (const [label, root] of [['release', '../plugins/codex-control-plugin/runtime']]) {
  const { pendingAsyncInputs, asyncQuestionReply } = await import(`${root}/desktop-ipc/async-input.mjs`);
  const { buildAgentState, CodexDeviceAgent } = await import(`${root}/agent-core/index.mjs`);
  const { DesktopTasks } = await import(`${root}/desktop-ipc/tasks.mjs`);
  const { conversationMessage } = await import(`${root}/agent-core/src/conversation.mjs`);
  const question = { type: 'agentMessage', id: 'call-question', delivery: 'async', text: 'Choose a topic',
    questions: [{ title: 'Which topic?', options: ['My hometown', 'My interests'] }] };
  const turn = { turnId: 'turn-question', status: 'completed', turnStartedAtMs: 1_792_744_929_848,
    agentMessageCompletedAtMsById: { 'call-question': 1_792_744_936_093 }, items: [question] };
  const snapshot = (items = turn.items, extraTurns = []) => ({ requests: [], threadRuntimeStatus: { type: 'idle' }, turns: [],
    turnHistory: { history: { entitiesByKey: { 'tail:0:local:test': { ...turn, items },
      ...Object.fromEntries(extraTurns.map(value => [`turn:${value.turnId}`, value])) } } } });
  const reply = (text, extras = {}) => ({ type: 'userMessage', content: [{ type: 'text', text }], ...extras });

  test(`${label}: an unanswered async card in a completed tail turn becomes an actionable inbox request`, () => {
    const state = buildAgentState([{ id: 'thread', status: 'idle' }], new Map([['thread', snapshot()]]));
    assert.equal(state.tasks[0].status, 'waiting_input');
    assert.equal(state.requests.length, 1);
    const request = state.requests[0];
    assert.equal(request.kind, 'user_input');
    assert.equal(request.turnId, turn.turnId);
    assert.equal(request.updatedAt, turn.agentMessageCompletedAtMsById[question.id]);
    assert.ok(request.requestId.length <= 100);
    assert.deepEqual(request.payload.questions, [{ id: 'answer', header: null, question: 'Which topic?',
      isOther: true, isSecret: false, options: [{ label: 'My hometown', description: '' }, { label: 'My interests', description: '' }] }]);
    assert.deepEqual(buildAgentState([{ id: 'thread', status: 'idle' }], new Map([['thread', snapshot()]])).requests, state.requests);
  });

  test(`${label}: ordinary text questions do not invent pending requests`, () => {
    assert.deepEqual(pendingAsyncInputs(snapshot([{ ...question, delivery: null }])), []);
    assert.deepEqual(pendingAsyncInputs(snapshot([{ ...question, questions: null }])), []);
    assert.deepEqual(pendingAsyncInputs(undefined), []);
  });

  test(`${label}: replies resolve only their question, including replies in later turns`, () => {
    const items = [{ ...question, questions: [...question.questions, { title: 'Any details?' }] }];
    const [first, second] = pendingAsyncInputs(snapshot(items));
    const text = asyncQuestionReply(first, 'A custom topic');
    const answered = snapshot(items, [{ turnId: 'next', turnStartedAtMs: turn.turnStartedAtMs + 100, items: [reply(text)] }]);
    assert.deepEqual(pendingAsyncInputs(answered).map(value => value.id), [second.id]);
    assert.equal(pendingAsyncInputs(snapshot(items)).length, 2, 'finishing a model turn is not an answer');
    assert.equal(pendingAsyncInputs(snapshot([...items, reply('A custom topic')])).length, 2, 'ordinary text does not silently resolve cards');
    assert.equal(pendingAsyncInputs(snapshot([...items, reply('<send_user_message_question_reply>invalid</send_user_message_question_reply>')])).length, 2);
  });

  test(`${label}: rejected steering replies leave the question unanswered`, () => {
    const [request] = pendingAsyncInputs(snapshot());
    const text = asyncQuestionReply(request, 'My hometown');
    const steering = { type: 'steeringUserMessage', input: [{ type: 'text', text }], status: 'rejected' };
    assert.equal(pendingAsyncInputs(snapshot([question, steering])).length, 1);
    assert.equal(pendingAsyncInputs(snapshot([question, { ...steering, status: 'accepted' }])).length, 0);
  });

  test(`${label}: inbox answers use the desktop question identity and allow free text`, async () => {
    const sent = [];
    const ipc = Object.assign(new EventEmitter(), { request: async (...args) => { sent.push(args); return { result: {} }; }, send: () => {} });
    const tasks = new DesktopTasks(ipc);
    tasks.owners.set('thread', 'owner');
    tasks.snapshot = async () => snapshot();
    const [request] = pendingAsyncInputs(snapshot());
    const result = await tasks.submitUserInput('thread', { requestId: request.id, turnId: turn.turnId, answers: { answer: ['A custom topic'] } });
    assert.deepEqual(result, { submitted: true });
    assert.equal(sent.length, 1);
    const [method, params, options] = sent[0];
    assert.equal(method, 'thread-follower-start-turn');
    assert.equal(options.version, 2);
    const text = params.turnStart.request.input[0].text;
    const payload = JSON.parse(text.split('\n')[1]);
    assert.deepEqual(payload, [{ questionItemId: JSON.stringify(['request_user_input_async', 'call-question', 0]), question: 'Which topic?', answer: 'A custom topic' }]);
    assert.equal(pendingAsyncInputs(snapshot([question, reply(text)])).length, 0);
    const visible = conversationMessage({ type: 'event_msg', timestamp: '2026-10-23T08:42:30Z', payload: { type: 'user_message', message: text } }, 1);
    assert.equal(visible.text, 'Which topic?\nA custom topic');
    tasks.close();
  });

  test(`${label}: already answered cards and stale turn identities cannot submit another answer`, async () => {
    const ipc = Object.assign(new EventEmitter(), { request: async () => assert.fail('stale request must not be sent'), send: () => {} });
    const tasks = new DesktopTasks(ipc);
    const [request] = pendingAsyncInputs(snapshot());
    const command = { requestId: request.id, turnId: turn.turnId, answers: { answer: ['My hometown'] } };
    tasks.snapshot = async () => snapshot([question, reply(asyncQuestionReply(request, 'My interests'))]);
    await assert.rejects(tasks.submitUserInput('thread', command), /expired or already resolved/);
    tasks.snapshot = async () => snapshot();
    await assert.rejects(tasks.submitUserInput('thread', { ...command, turnId: 'wrong-turn' }), /expired or already resolved/);
    await assert.rejects(tasks.submitUserInput('thread', { ...command, answers: { unknown: ['x'] } }), /unknown question/);
    assert.equal(tasks.pending.size, 0);
    tasks.close();
  });

  test(`${label}: idle chats are scanned and discovered questions stay present until answered`, async () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    let hasAnswer = false;
    const calls = [];
    const agent = Object.assign(Object.create(CodexDeviceAgent.prototype), {
      connectDesktop: async () => {},
      appTools: { listThreads: async () => ({ threads: ids.map(id => ({ id, kind: 'codex', status: 'idle' })) }) },
      catalog: { read: () => [{ id: 'a' }] },
      rollouts: { read: () => ({ latestTurnId: 'turn-question', status: 'completed' }) },
      snapshots: new Map(), activeSnapshotLimit: 1, taskLimit: 50,
      tasks: { snapshot: async id => {
        calls.push(id);
        return id === 'e' ? snapshot(hasAnswer ? [question, reply(asyncQuestionReply(pendingAsyncInputs(snapshot())[0], 'My hometown'))] : turn.items)
          : { turns: [{ ...turn, items: [] }], requests: [] };
      } },
    });
    let state;
    for (let index = 0; index < ids.length; index++) state = await agent.collectState();
    assert.equal(state.requests.length, 1);
    assert.equal(state.requests[0].threadId, 'e');
    assert.equal(state.tasks.find(task => task.threadId === 'e').status, 'waiting_input');
    for (let index = 0; index < ids.length; index++) assert.equal((await agent.collectState()).requests.length, 1, 'rotation must not make a known pending card disappear');
    hasAnswer = true;
    assert.equal((await agent.collectState()).requests.length, 0);
    assert.ok(ids.every(id => calls.includes(id)));
  });

  test(`${label}: a rejected conversation page reports a read error without failing inbox sync`, async () => {
    const responses = [];
    const state = { tasks: [{ threadId: 'thread' }], requests: [{ threadId: 'thread', kind: 'user_input' }] };
    const agent = Object.assign(Object.create(CodexDeviceAgent.prototype), {
      collectState: async () => state,
      imageBurstDurationMs: 0,
      conversations: { read: () => ({ messages: [{ text: '', attachments: [{ id: 'image' }] }] }) },
      relay: {
        sync: async value => assert.equal(value, state), commands: async () => [],
        conversationRequests: async () => [{ id: 'read', threadId: 'thread' }],
        respondConversation: async (id, value) => {
          responses.push(value);
          if (!value.error) throw Object.assign(new Error('text is invalid'), { status: 400 });
        },
      },
    });
    const result = await agent.cycle();
    assert.equal(result.requestCount, 1);
    assert.deepEqual(responses[1], { error: 'text is invalid' });
  });
}
