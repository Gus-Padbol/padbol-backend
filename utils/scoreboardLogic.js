const SCORE_ADVANTAGE = 45;

export function snapshotPartido(partido) {
  return {
    estado: partido.estado,
    saque_actual: partido.saque_actual,
    score_a: partido.score_a,
    score_b: partido.score_b,
    games_a: partido.games_a,
    games_b: partido.games_b,
    sets_a: partido.sets_a,
    sets_b: partido.sets_b,
    historial_sets: JSON.parse(JSON.stringify(partido.historial_sets || [])),
    es_tiebreak: partido.es_tiebreak,
    ultimo_punto: partido.ultimo_punto,
  };
}

function toggleSaque(saque) {
  return saque === 'A' ? 'B' : 'A';
}

function isDeuce(scoreA, scoreB) {
  return scoreA === 40 && scoreB === 40;
}

function hasAdvantage(scoreA, scoreB) {
  if (scoreA === SCORE_ADVANTAGE && scoreB === 40) return 'A';
  if (scoreB === SCORE_ADVANTAGE && scoreA === 40) return 'B';
  return null;
}

function incrementScore(current) {
  if (current === 0) return 15;
  if (current === 15) return 30;
  if (current === 30) return 40;
  return current;
}

function resetGame(partido) {
  partido.score_a = 0;
  partido.score_b = 0;
  partido.es_tiebreak = false;
}

function maybeStartTiebreak(partido) {
  if (partido.games_a === 6 && partido.games_b === 6 && !partido.es_tiebreak) {
    partido.es_tiebreak = true;
    partido.score_a = 0;
    partido.score_b = 0;
  }
}

function winGame(partido, equipo) {
  if (equipo === 'A') partido.games_a += 1;
  else partido.games_b += 1;

  resetGame(partido);
  partido.saque_actual = toggleSaque(partido.saque_actual);
  maybeStartTiebreak(partido);
  checkSetWin(partido);
}

function checkSetWin(partido) {
  const { games_a: ga, games_b: gb, es_tiebreak } = partido;

  if (es_tiebreak) return;

  let winner = null;
  if (ga >= 6 && ga - gb >= 2) winner = 'A';
  else if (gb >= 6 && gb - ga >= 2) winner = 'B';

  if (!winner) return;

  finishSet(partido, winner, ga, gb);
}

function finishSet(partido, winner, gamesA, gamesB) {
  const setNumber = (partido.historial_sets?.length || 0) + 1;
  const historial = Array.isArray(partido.historial_sets) ? [...partido.historial_sets] : [];
  historial.push({ set: setNumber, a: gamesA, b: gamesB });
  partido.historial_sets = historial;

  if (winner === 'A') partido.sets_a += 1;
  else partido.sets_b += 1;

  partido.games_a = 0;
  partido.games_b = 0;
  partido.score_a = 0;
  partido.score_b = 0;
  partido.es_tiebreak = false;

  if (partido.sets_a >= 2 || partido.sets_b >= 2) {
    partido.estado = 'terminado';
  }
}

function winTiebreakPoint(partido, equipo) {
  if (equipo === 'A') partido.score_a += 1;
  else partido.score_b += 1;

  const totalPoints = partido.score_a + partido.score_b;
  if (totalPoints > 0 && totalPoints % 2 === 0) {
    partido.saque_actual = toggleSaque(partido.saque_actual);
  }

  const { score_a: sa, score_b: sb } = partido;
  const leader = sa > sb ? 'A' : sb > sa ? 'B' : null;
  const leaderScore = Math.max(sa, sb);
  const trailerScore = Math.min(sa, sb);

  if (leader && leaderScore >= 7 && leaderScore - trailerScore >= 2) {
    const gamesA = leader === 'A' ? 7 : 6;
    const gamesB = leader === 'B' ? 7 : 6;
    partido.games_a = gamesA;
    partido.games_b = gamesB;
    partido.es_tiebreak = false;
    finishSet(partido, leader, gamesA, gamesB);
  }
}

function winRegularPoint(partido, equipo) {
  const adv = hasAdvantage(partido.score_a, partido.score_b);

  if (adv) {
    if (adv === equipo) {
      winGame(partido, equipo);
      return;
    }
    partido.score_a = 40;
    partido.score_b = 40;
    return;
  }

  if (isDeuce(partido.score_a, partido.score_b)) {
    if (equipo === 'A') partido.score_a = SCORE_ADVANTAGE;
    else partido.score_b = SCORE_ADVANTAGE;
    return;
  }

  const myScore = equipo === 'A' ? partido.score_a : partido.score_b;
  const oppScore = equipo === 'A' ? partido.score_b : partido.score_a;
  const newScore = incrementScore(myScore);

  if (equipo === 'A') partido.score_a = newScore;
  else partido.score_b = newScore;

  if (newScore === 40 && oppScore < 40) {
    winGame(partido, equipo);
  } else if (newScore === 40 && oppScore === 40) {
    // deuce — scores already 40-40
  }
}

export function registrarPunto(partido, equipo) {
  if (!['A', 'B'].includes(equipo)) {
    throw Object.assign(new Error('Equipo inválido'), { status: 400 });
  }
  if (partido.estado === 'terminado') {
    throw Object.assign(new Error('El partido ya terminó'), { status: 400 });
  }

  const snapshot = snapshotPartido(partido);
  const historial = Array.isArray(partido.historial_puntos) ? [...partido.historial_puntos] : [];
  historial.push(snapshot);
  if (historial.length > 1) historial.shift();
  partido.historial_puntos = historial;

  if (partido.estado === 'pendiente') partido.estado = 'en_curso';

  if (partido.es_tiebreak) {
    winTiebreakPoint(partido, equipo);
  } else {
    winRegularPoint(partido, equipo);
  }

  partido.ultimo_punto = equipo;
  partido.updated_at = new Date().toISOString();
  return partido;
}

export function deshacerPunto(partido) {
  const historial = Array.isArray(partido.historial_puntos) ? partido.historial_puntos : [];
  if (!historial.length) {
    throw Object.assign(new Error('No hay puntos para deshacer'), { status: 400 });
  }

  const prev = historial.pop();
  Object.assign(partido, prev);
  partido.historial_puntos = historial;
  partido.updated_at = new Date().toISOString();
  return partido;
}

export function cambiarSaque(partido) {
  partido.saque_actual = toggleSaque(partido.saque_actual);
  partido.updated_at = new Date().toISOString();
  return partido;
}

export function iniciarTiebreak(partido) {
  if (partido.es_tiebreak) {
    throw Object.assign(new Error('Ya está en tie-break'), { status: 400 });
  }
  partido.es_tiebreak = true;
  partido.score_a = 0;
  partido.score_b = 0;
  partido.updated_at = new Date().toISOString();
  return partido;
}

export function formatScoreDisplay(scoreA, scoreB, esTiebreak) {
  if (esTiebreak) {
    return { displayA: String(scoreA), displayB: String(scoreB), mode: 'tiebreak' };
  }

  const adv = hasAdvantage(scoreA, scoreB);
  if (adv === 'A') {
    return { displayA: 'VENT.', displayB: '—', mode: 'ventaja', ventaja: 'A' };
  }
  if (adv === 'B') {
    return { displayA: '—', displayB: 'VENT.', mode: 'ventaja', ventaja: 'B' };
  }
  if (isDeuce(scoreA, scoreB)) {
    return { displayA: 'DEUCE', displayB: 'DEUCE', mode: 'deuce' };
  }

  const map = (n) => (n === 0 ? '0' : String(n));
  return { displayA: map(scoreA), displayB: map(scoreB), mode: 'normal' };
}

export function getCronometroSegundos(partido) {
  let total = Number(partido.cronometro_segundos) || 0;
  if (!partido.cronometro_pausado && partido.cronometro_inicio) {
    const inicio = new Date(partido.cronometro_inicio).getTime();
    total += Math.floor((Date.now() - inicio) / 1000);
  }
  return total;
}

export function formatCronometro(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function enrichPartidoResponse(partido) {
  const score = formatScoreDisplay(partido.score_a, partido.score_b, partido.es_tiebreak);
  const cronometroSegundos = getCronometroSegundos(partido);
  return {
    ...partido,
    display: {
      ...score,
      cronometro: formatCronometro(cronometroSegundos),
      cronometroSegundos,
      cronometroActivo: !partido.cronometro_pausado && !!partido.cronometro_inicio,
    },
  };
}
