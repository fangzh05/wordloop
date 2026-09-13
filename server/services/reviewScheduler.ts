export function isMastered(input: {
  correctCount: number;
  consecutiveCorrect: number;
  hasErrors: boolean;
}): boolean {
  return input.correctCount >= 3 && input.consecutiveCorrect >= 2 && !input.hasErrors;
}

export function advanceErrorLayerStreak(current: number, isCorrect: boolean): {
  consecutiveCorrect: number;
  active: boolean;
} {
  const consecutiveCorrect = isCorrect ? current + 1 : 0;
  return { consecutiveCorrect, active: consecutiveCorrect < 2 };
}

export function applyAttemptCounters(
  state: { correctCount: number; wrongCount: number; consecutiveCorrect: number },
  isCorrect: boolean,
): { correctCount: number; wrongCount: number; consecutiveCorrect: number } {
  return isCorrect
    ? { ...state, correctCount: state.correctCount + 1, consecutiveCorrect: state.consecutiveCorrect + 1 }
    : { ...state, wrongCount: state.wrongCount + 1, consecutiveCorrect: 0 };
}
