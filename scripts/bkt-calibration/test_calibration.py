import unittest
from calibrate import FIXED, fit_local, frequency, predict, trusted_rows
from slam import read_exercises
from pathlib import Path
from tempfile import TemporaryDirectory
import numpy as np
from source_fit import objective
from evaluate_slam import evaluate


class CalibrationTests(unittest.TestCase):
    def row(self, index, outcome="correct", **extra):
        return {"id": index, "created_at": str(index).zfill(5), "outcome": outcome,
                "skill_id": "retrieval", "quality": "OBSERVE", "deterministic_audit": True,
                "first_unprompted": True, "hint_used": False, "answer_revealed": False,
                "modified_correct": False, **extra}

    def test_runtime_bayes_equivalence(self):
        rows = [self.row(1), self.row(2, "incorrect")]
        probabilities = predict(rows, FIXED)
        self.assertAlmostEqual(probabilities[0], .34)
        posterior = .2*.9 / (.2*.9+.8*.2)
        mastery = posterior+(1-posterior)*.1
        self.assertAlmostEqual(probabilities[1], mastery*.9+(1-mastery)*.2)

    def test_no_frequency_lookahead(self):
        a = [self.row(1), self.row(2)]
        b = [self.row(1), self.row(2, "incorrect")]
        self.assertEqual(list(frequency(a)), list(frequency(b)))

    def test_excludes_assisted_and_unreviewed(self):
        rows = [self.row(1), self.row(2, hint_used=True), self.row(3, deterministic_audit=None),
                self.row(4, modified_correct=True), self.row(5, first_unprompted=False)]
        self.assertEqual([r["id"] for r in trusted_rows({"rows": rows})], [1])
        with self.assertRaises(ValueError):
            trusted_rows({"rows": [self.row(1), self.row(1)]})

    def test_training_is_deterministic(self):
        train = [self.row(i, "correct" if i % 3 == 0 else "incorrect") for i in range(30)]
        self.assertEqual(fit_local(train, 2), fit_local(train, 2))

    def test_slam_mistake_inversion_and_attempt_grouping(self):
        with TemporaryDirectory() as tmp:
            file = Path(tmp)/"train"
            file.write_text("# user:student days:1 format:reverse_translate\na word NOUN _ dep 0 0\nb wrong NOUN _ dep 0 1\n\n# user:student days:2 format:reverse_tap\nc word NOUN _ dep 0 0\n\n# user:student days:3 format:reverse_translate\nd word NOUN _ dep 0 0\n", encoding="utf-8")
            rows = read_exercises(file)
            self.assertEqual([r["correct"] for r in rows], [0, 1])

    def test_dev_key_missing_label_is_rejected(self):
        with TemporaryDirectory() as tmp:
            file, key = Path(tmp)/"dev", Path(tmp)/"key"
            file.write_text("# user:student days:1 format:reverse_translate\na word NOUN _ dep 0\n", encoding="utf-8")
            key.write_text("b 0\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                read_exercises(file, key)

    def test_source_gradient_matches_finite_difference_and_runtime_loss(self):
        values = np.array(list(FIXED.values()))
        outcomes = np.array([1, 0, 0, 1, 1])
        resets = np.array([True, False, False, True, False])
        loss, gradient = objective(values, outcomes, resets)
        first = [self.row(i, "correct" if y else "incorrect") for i, y in enumerate(outcomes[:3])]
        second = [self.row(i, "correct" if y else "incorrect") for i, y in enumerate(outcomes[3:])]
        from calibrate import losses, labels
        reference = sum(losses(predict(rs, FIXED), labels(rs))["log_loss"].sum() for rs in (first, second))
        self.assertAlmostEqual(loss, reference)
        for index in range(4):
            left, right = values.copy(), values.copy()
            left[index] -= 1e-6
            right[index] += 1e-6
            finite = (objective(right, outcomes, resets)[0]-objective(left, outcomes, resets)[0])/2e-6
            self.assertAlmostEqual(gradient[index], finite, places=5)

    def test_source_chronology_and_past_only_prediction(self):
        a = {"user_id": "anonymous", "days": 1, "order_id": 0, "correct": 0}
        b = {**a, "days": 2, "correct": 1}
        first = evaluate([a], [b], [], FIXED)
        changed = evaluate([a], [{**b, "correct": 0}], [], FIXED)
        # Brier losses differ but source prediction uses train state only.
        p = predict([self.row(1, "incorrect"), self.row(2)], FIXED)[1]
        self.assertAlmostEqual(first["dev"]["source-candidate"]["brier"], (p-1)**2)
        self.assertAlmostEqual(changed["dev"]["source-candidate"]["brier"], p**2)
        with self.assertRaises(ValueError):
            evaluate([b], [a], [], FIXED)


if __name__ == "__main__":
    unittest.main()
