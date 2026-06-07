'use strict';

const BATCH_SIZE = 80;

// ── Storage helpers ────────────────────────────────────────────────────────
const store = {
  get favorites() { return new Set(JSON.parse(localStorage.getItem('quiz_fav')  || '[]')); },
  get wrong()     { return new Set(JSON.parse(localStorage.getItem('quiz_wrong') || '[]')); },
  get offset()    { return parseInt(localStorage.getItem('quiz_offset') || '0', 10); },

  saveFavorites(set) { localStorage.setItem('quiz_fav',   JSON.stringify([...set])); },
  saveWrong(set)     { localStorage.setItem('quiz_wrong', JSON.stringify([...set])); },
  saveOffset(n)      { localStorage.setItem('quiz_offset', String(n)); },
  resetOffset()      { localStorage.removeItem('quiz_offset'); },

  get session()      { return JSON.parse(localStorage.getItem('quiz_session') || 'null'); },
  saveSession(data)  { localStorage.setItem('quiz_session', JSON.stringify(data)); },
  clearSession()     { localStorage.removeItem('quiz_session'); },
};

// ── State ──────────────────────────────────────────────────────────────────
let QUIZ = null;

const state = {
  mode: 'pool',
  questions: [],
  current: 0,
  correct: 0,
  answered: 0,
  timerInterval: null,
  elapsed: 0,
  answered_current: false,
};

// ── DOM ────────────────────────────────────────────────────────────────────
const screens = {
  loading: document.getElementById('loading-screen'),
  home:    document.getElementById('home-screen'),
  quiz:    document.getElementById('quiz-screen'),
  results: document.getElementById('results-screen'),
};

const el = {
  homeSub:    document.getElementById('home-subtitle'),
  poolSub:    document.getElementById('pool-sub'),
  favSub:     document.getElementById('fav-sub'),
  wrongSub:   document.getElementById('wrong-sub'),
  btnPool:    document.getElementById('btn-pool'),
  btnFav:     document.getElementById('btn-favorites'),
  btnWrong:   document.getElementById('btn-wrong'),
  btnReset:   document.getElementById('btn-reset-progress'),

  timer:      document.getElementById('timer'),
  score:      document.getElementById('score'),
  progress:   document.getElementById('progress-bar'),
  qNum:       document.getElementById('question-num'),
  qText:      document.getElementById('question-text'),
  answers:    document.getElementById('answers-grid'),
  nextBtn:    document.getElementById('next-btn'),
  favToggle:  document.getElementById('fav-toggle'),
  backBtn:    document.getElementById('back-btn'),

  resIcon:    document.getElementById('result-icon'),
  resHeading: document.getElementById('result-heading'),
  statOk:     document.getElementById('stat-correct'),
  statBad:    document.getElementById('stat-wrong'),
  statTime:   document.getElementById('stat-time'),
};

// ── Screen manager ─────────────────────────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

// ── Home screen ────────────────────────────────────────────────────────────
function updateHome() {
  const total   = QUIZ.questions.length;
  const favSize = store.favorites.size;
  const badSize = store.wrong.size;
  const offset  = store.offset;

  el.homeSub.textContent = QUIZ.title;

  const batchSize = Math.min(BATCH_SIZE, total);
  const from = offset + 1;
  const to   = Math.min(offset + batchSize, total);
  el.poolSub.textContent = total <= BATCH_SIZE
    ? `Все ${total} вопросов`
    : `Вопросы ${from}–${to} из ${total}`;

  const session = store.session;

  if (session && session.mode === 'pool') {
    el.poolSub.textContent = `Продолжить: вопрос ${session.current + 1} из ${session.indices.length}`;
  } else {
    el.poolSub.textContent = total <= BATCH_SIZE
      ? `Все ${total} вопросов`
      : `Вопросы ${from}–${to} из ${total}`;
  }

  if (session && session.mode === 'favorites') {
    el.favSub.textContent = `Продолжить: вопрос ${session.current + 1} из ${session.indices.length}`;
    el.btnFav.disabled = false;
  } else {
    el.favSub.textContent = `${favSize} вопрос${plural(favSize)}`;
    el.btnFav.disabled    = favSize === 0;
  }

  if (session && session.mode === 'wrong') {
    el.wrongSub.textContent = `Продолжить: вопрос ${session.current + 1} из ${session.indices.length}`;
    el.btnWrong.disabled = false;
  } else {
    el.wrongSub.textContent = `${badSize} вопрос${plural(badSize)}`;
    el.btnWrong.disabled    = badSize === 0;
  }
}

function plural(n) {
  if (n % 10 === 1 && n % 100 !== 11) return '';
  if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) return 'а';
  return 'ов';
}

el.btnPool.addEventListener('click',  () => startQuiz('pool'));
el.btnFav.addEventListener('click',   () => startQuiz('favorites'));
el.btnWrong.addEventListener('click', () => startQuiz('wrong'));

el.btnReset.addEventListener('click', () => {
  store.resetOffset();
  updateHome();
});

// ── Build question set ─────────────────────────────────────────────────────
function buildSet(mode) {
  const total = QUIZ.questions.length;

  if (mode === 'favorites') {
    return [...store.favorites].map(i => ({ ...QUIZ.questions[i], originalIndex: i }));
  }
  if (mode === 'wrong') {
    return [...store.wrong].map(i => ({ ...QUIZ.questions[i], originalIndex: i }));
  }

  // pool: следующие BATCH_SIZE вопросов по порядку, с переходом на начало
  const batchSize = Math.min(BATCH_SIZE, total);
  const offset = store.offset;
  const indices = [];
  for (let i = 0; i < batchSize; i++) {
    indices.push((offset + i) % total);
  }
  store.saveOffset((offset + batchSize) % total);
  return indices.map(i => ({ ...QUIZ.questions[i], originalIndex: i }));
}

// ── Quiz ───────────────────────────────────────────────────────────────────
function startQuiz(mode) {
  const session = store.session;

  if (session && session.mode === mode) {
    // Восстанавливаем прерванную сессию
    state.mode      = mode;
    state.questions = session.indices.map(i => ({ ...QUIZ.questions[i], originalIndex: i }));
    state.current   = session.current;
    state.correct   = session.correct;
    state.answered  = session.answered;
    state.answered_current = false;

    showScreen('quiz');
    startTimer(session.elapsed);
    renderQuestion();
    return;
  }

  // Новый набор вопросов
  const questions = buildSet(mode);
  if (questions.length === 0) return;

  state.mode      = mode;
  state.questions = questions;
  state.current   = 0;
  state.correct   = 0;
  state.answered  = 0;
  state.answered_current = false;

  showScreen('quiz');
  startTimer(0);
  renderQuestion();
}

function saveCurrentSession() {
  if (state.questions.length === 0) return;
  store.saveSession({
    mode:     state.mode,
    indices:  state.questions.map(q => q.originalIndex),
    current:  state.current,
    correct:  state.correct,
    answered: state.answered,
    elapsed:  state.elapsed,
  });
}

function restartQuiz() {
  store.clearSession();
  state.current  = 0;
  state.correct  = 0;
  state.answered = 0;
  state.answered_current = false;

  showScreen('quiz');
  startTimer(0);
  renderQuestion();
}

function renderQuestion() {
  const q     = state.questions[state.current];
  const total = state.questions.length;

  state.answered_current   = false;
  el.nextBtn.style.display = 'none';
  el.answers.innerHTML     = '';

  el.progress.style.width = `${(state.current / total) * 100}%`;
  el.score.textContent    = `${state.correct} / ${state.answered}`;
  el.qNum.textContent     = `Вопрос ${state.current + 1} из ${total}`;
  el.qText.textContent    = q.question;

  const isFav = store.favorites.has(q.originalIndex);
  el.favToggle.textContent = isFav ? '★' : '☆';
  el.favToggle.classList.toggle('is-fav', isFav);

  const shuffled = [...q.answers].sort(() => Math.random() - 0.5);
  const letters  = ['A', 'B', 'C', 'D', 'E', 'F'];

  shuffled.forEach((answer, i) => {
    const btn = document.createElement('button');
    btn.className = 'answer-btn';
    btn.innerHTML = `<span class="letter">${letters[i]}</span><span>${answer.text}</span>`;
    btn.addEventListener('click', () => handleAnswer(btn, answer.correct, shuffled));
    el.answers.appendChild(btn);
  });
}

function handleAnswer(selectedBtn, isCorrect, shuffled) {
  if (state.answered_current) return;
  state.answered_current = true;
  state.answered++;

  const q        = state.questions[state.current];
  const wrongSet = store.wrong;

  if (isCorrect) {
    state.correct++;
    if (state.mode === 'wrong') {
      wrongSet.delete(q.originalIndex);
      store.saveWrong(wrongSet);
    }
  } else {
    wrongSet.add(q.originalIndex);
    store.saveWrong(wrongSet);
  }

  el.answers.querySelectorAll('.answer-btn').forEach((btn, i) => {
    btn.disabled = true;
    if (shuffled[i].correct) btn.classList.add('correct');
  });
  if (!isCorrect) selectedBtn.classList.add('wrong');

  el.score.textContent = `${state.correct} / ${state.answered}`;

  const isLast = state.current >= state.questions.length - 1;
  el.nextBtn.textContent   = isLast ? 'Завершить' : 'Следующий →';
  el.nextBtn.style.display = 'inline-block';
}

el.nextBtn.addEventListener('click', () => {
  state.current++;
  state.current >= state.questions.length ? finishQuiz() : renderQuestion();
});

// ── Favorites toggle ───────────────────────────────────────────────────────
el.favToggle.addEventListener('click', () => {
  const q      = state.questions[state.current];
  const favSet = store.favorites;

  favSet.has(q.originalIndex) ? favSet.delete(q.originalIndex) : favSet.add(q.originalIndex);
  store.saveFavorites(favSet);

  const isFav = favSet.has(q.originalIndex);
  el.favToggle.textContent = isFav ? '★' : '☆';
  el.favToggle.classList.toggle('is-fav', isFav);
});

// ── Timer ──────────────────────────────────────────────────────────────────
function startTimer(fromElapsed = 0) {
  clearInterval(state.timerInterval);
  state.elapsed = fromElapsed;
  renderTimer();

  state.timerInterval = setInterval(() => {
    state.elapsed++;

    if (QUIZ.timeLimit) {
      const rem = QUIZ.timeLimit - state.elapsed;
      el.timer.classList.toggle('warning', rem <= 30 && rem > 10);
      el.timer.classList.toggle('danger',  rem <= 10);
      if (rem <= 0) { clearInterval(state.timerInterval); finishQuiz(true); return; }
    }

    renderTimer();
  }, 1000);
}

function renderTimer() {
  const secs = QUIZ.timeLimit
    ? Math.max(0, QUIZ.timeLimit - state.elapsed)
    : state.elapsed;
  el.timer.textContent = fmt(secs);
}

function fmt(s) {
  return `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
}

// ── Results ────────────────────────────────────────────────────────────────
function finishQuiz(timeOut = false) {
  clearInterval(state.timerInterval);
  store.clearSession();

  const total = state.questions.length;
  const pct   = total > 0 ? Math.round((state.correct / total) * 100) : 0;

  el.resIcon.textContent    = pct >= 70 ? '🎉' : timeOut ? '⏰' : '😬';
  el.resHeading.textContent = timeOut
    ? 'Время вышло!'
    : pct >= 70 ? `Отлично! ${pct}%` : `Результат: ${pct}%`;

  el.statOk.textContent   = state.correct;
  el.statBad.textContent  = state.answered - state.correct;
  el.statTime.textContent = fmt(state.elapsed);

  showScreen('results');
}

document.getElementById('btn-restart').addEventListener('click', restartQuiz);

document.getElementById('btn-home').addEventListener('click', () => {
  clearInterval(state.timerInterval);
  updateHome();
  showScreen('home');
});

el.backBtn.addEventListener('click', () => {
  clearInterval(state.timerInterval);
  saveCurrentSession();
  updateHome();
  showScreen('home');
});

// ── Init: загружаем questions.json ─────────────────────────────────────────
async function init() {
  try {
    const res = await fetch('questions.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    QUIZ = await res.json();
    updateHome();
    showScreen('home');
  } catch (err) {
    screens.loading.innerHTML =
      `<p style="color:#ef4444;text-align:center">
        Не удалось загрузить questions.json<br>
        <small style="color:#8892a4">${err.message}</small>
       </p>`;
  }
}

init();
