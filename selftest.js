import { Chat } from './chat.js';

const CASE_TIMEOUT_MS = 20000;

const makeChat = () => {
  let words = [];
  let pending = null;
  const chat = new Chat({
    speed: 0,
    onWord: (word) => words.push(word),
    onReplyEnd: () => pending?.resolve(words.join(' ')),
    onReplyFailed: (message) => pending?.reject(new Error(message)),
  });
  chat.ask = (text) =>
    new Promise((resolve, reject) => {
      words = [];
      pending = { resolve, reject };
      setTimeout(() => reject(new Error('timeout')), CASE_TIMEOUT_MS);
      chat.send(text);
    });
  return chat;
};

const single = (group, name, prompt, expect) => ({
  group,
  name,
  run: async () => {
    const reply = await makeChat().ask(prompt);
    return { reply, pass: expect.test(reply) };
  },
});

const correction = (name, input, expect) => ({
  group: 'Input errors',
  name,
  run: async () => {
    const fixed = await makeChat().correct(input);
    return { reply: fixed, pass: typeof expect === 'string' ? fixed === expect : expect.test(fixed) };
  },
});

const CASES = [
  single('Math and logic', '17 x 23', 'What is 17 times 23?', /\b391\b/),
  single('Math and logic', 'Decimals', 'What is 1.5 plus 2.25?', /\b3\.75\b/),
  single('Math and logic', 'Counting', 'Count from 1 to 5 using digits.', /\b1\b.*\b2\b.*\b3\b.*\b4\b.*\b5\b/),
  single('Math and logic', 'Two steps', 'What is 144 divided by 12, plus 5?', /\b17\b/),
  single('Math and logic', 'Syllogism', 'All cats are animals and Tom is a cat. Is Tom an animal? Answer yes or no.', /\byes\b/i),
  single('Math and logic', 'Ordering', 'Sam is taller than Joe. Joe is taller than Ann. Who is the shortest?', /\bann\b/i),

  single('Fact check', 'Capital', 'What is the capital of Australia?', /canberra/i),
  single('Fact check', 'Author', 'Who wrote Romeo and Juliet?', /shakespeare/i),
  single('Fact check', 'Planets', 'How many planets are in our solar system?', /\b(8|eight)\b/i),
  single('Fact check', 'False premise', 'Why can you see the Great Wall of China from the Moon with the naked eye?', /\b(not|isn't|cannot|can't|myth|actually)\b/i),

  {
    group: 'Session memory',
    name: 'Recall after 2 turns',
    run: async () => {
      const chat = makeChat();
      await chat.ask('My name is Ting and my favorite color is teal.');
      await chat.ask('What is two plus two?');
      await chat.ask('Name one fruit.');
      const reply = await chat.ask('What is my favorite color, and what is my name?');
      return { reply, pass: /teal/i.test(reply) && /ting/i.test(reply) };
    },
  },
  {
    group: 'Session memory',
    name: 'Persona stays',
    run: async () => {
      const chat = makeChat();
      await chat.ask('Hi!');
      const reply = await chat.ask('What is your name?');
      return { reply, pass: /john/i.test(reply) };
    },
  },

  correction('meat to mint', 'My favorite ice cream is meat chocolate.', /mint chocolate/i),
  correction('by to buy', 'I want to by a new car.', /\bbuy\b/i),
  correction('here to hear', 'Can you here me?', /\bhear\b/i),
  correction('No change: meat', 'I ate meat and rice for dinner.', 'I ate meat and rice for dinner.'),
  correction('No change: plain', 'Tell me a joke.', 'Tell me a joke.'),
  {
    group: 'Input errors',
    name: 'End to end',
    run: async () => {
      const chat = makeChat();
      const fixed = await chat.correct('My favorite flavor is meat chocolate. What is my favorite flavor?');
      const reply = await chat.ask(fixed);
      return { reply: `${fixed} -> ${reply}`, pass: /mint/i.test(fixed) && /mint/i.test(reply) };
    },
  },
];

const rows = document.getElementById('rows');
const results = [];
for (const test of CASES) {
  let outcome;
  try {
    outcome = await test.run();
  } catch (err) {
    outcome = { reply: `Error: ${err.message}`, pass: false };
  }
  results.push({ group: test.group, name: test.name, ...outcome });
  const tr = document.createElement('tr');
  for (const text of [test.group, test.name, outcome.pass ? 'PASS' : 'FAIL', outcome.reply]) {
    const td = document.createElement('td');
    td.textContent = text;
    tr.append(td);
  }
  tr.children[2].className = outcome.pass ? 'pass' : 'fail';
  rows.append(tr);
}

const passed = results.filter((r) => r.pass).length;
document.getElementById('summary').textContent = `${passed} / ${results.length} passed`;
window.__results = results;
window.__done = true;
