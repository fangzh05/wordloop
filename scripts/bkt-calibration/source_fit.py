"""Exact no-forgetting BKT forward likelihood, accelerated for many learner streams."""
import numpy as np
from numba import njit
from scipy.optimize import minimize
from calibrate import FIXED, KEYS


@njit
def objective(values, outcomes, resets):
    prior, learn, guess, slip = values
    mastery = prior
    derivative = np.zeros(4)
    gradient = np.zeros(4)
    loss = 0.0
    for i in range(len(outcomes)):
        if resets[i]:
            mastery = prior
            derivative[:] = 0
            derivative[0] = 1
        y = outcomes[i]
        probability = mastery*(1-slip)+(1-mastery)*guess
        dp = derivative * (1-slip-guess)
        dp[2] += 1-mastery
        dp[3] -= mastery
        loss -= y*np.log(probability)+(1-y)*np.log(1-probability)
        gradient += (probability-y)/(probability*(1-probability))*dp
        if y:
            numerator = mastery*(1-slip)
            dn = derivative*(1-slip)
            dn[3] -= mastery
            denominator, dd = probability, dp
        else:
            numerator = mastery*slip
            dn = derivative*slip
            dn[3] += mastery
            denominator, dd = 1-probability, -dp
        posterior = numerator/denominator
        dpost = (dn*denominator-numerator*dd)/(denominator*denominator)
        mastery = posterior+(1-posterior)*learn
        derivative = dpost*(1-learn)
        derivative[1] += 1-posterior
    return loss, gradient


def fit_source(rows):
    outcomes = np.array([r["correct"] for r in rows], dtype=np.int64)
    resets = np.array([i == 0 or r["user_id"] != rows[i-1]["user_id"]
                       for i, r in enumerate(rows)], dtype=np.bool_)
    # Deterministic starts; train data only. Guess/slip < .5 preserves mastery interpretation.
    starts = [list(FIXED.values()), [.7, .02, .1, .2], [.3, .005, .3, .3],
              [.9, .001, .4, .1], [.1, .1, .1, .4]]
    fits = []
    for start in starts:
        result = minimize(objective, np.array(start), args=(outcomes, resets),
                          method="L-BFGS-B", jac=True,
                          bounds=[(1e-4, .9999), (1e-4, .5), (1e-4, .49), (1e-4, .49)],
                          options={"maxiter": 500, "ftol": 1e-11})
        fits.append(result)
        print(f"Training initialization {len(fits)}/5 complete; converged={result.success}", flush=True)
    valid = [r for r in fits if r.success and np.isfinite(r.fun) and np.all(np.isfinite(r.x))]
    if not valid:
        raise ValueError("No finite, converged source fit")
    best = min(valid, key=lambda r: r.fun)
    return {"params": {k: float(v) for k, v in zip(KEYS, best.x)},
            "negative_log_likelihood": float(best.fun), "converged_fits": len(valid),
            "initializations": len(starts), "iterations": int(best.nit),
            "bounds": {"prior": [.0001, .9999], "learn": [.0001, .5],
                       "guess": [.0001, .49], "slip": [.0001, .49]}}
