import unittest

from duration import minutes_to_seconds


class DurationTest(unittest.TestCase):
    def test_minutes_to_seconds(self):
        self.assertEqual(minutes_to_seconds(2), 120, "DURATION_SCALE")
