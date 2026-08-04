import base64
import os
import subprocess
import sys
import unittest

from bettertts_sidecar import TEST_SAMPLE_RATE, test_pcm16, validate_synthesis


class SidecarContractTests(unittest.TestCase):
    def test_validation_accepts_bounded_custom_voice_request(self):
        validate_synthesis({
            "text": "Hello from the isolated sidecar.",
            "language": "English",
            "speaker": "Vivian",
            "instruct": "Warm and clear.",
            "speed": 1.0,
        })

    def test_validation_rejects_oversized_text(self):
        with self.assertRaises(ValueError):
            validate_synthesis({
                "text": "x" * 5_001,
                "language": "English",
                "speaker": "Vivian",
                "speed": 1.0,
            })

    def test_validation_rejects_unknown_voice_metadata(self):
        with self.assertRaises(ValueError):
            validate_synthesis({
                "text": "hello",
                "language": "Klingon",
                "speaker": "Vivian",
                "speed": 1.0,
            })

    def test_test_adapter_produces_pcm_and_speed_changes_duration(self):
        normal = test_pcm16("hello", 1.0)
        fast = test_pcm16("hello", 1.5)
        self.assertGreater(len(normal), 0)
        self.assertLess(len(fast), len(normal))
        self.assertEqual(len(base64.b64decode(base64.b64encode(normal))), len(normal))
        self.assertEqual(TEST_SAMPLE_RATE, 24_000)

    def test_protocol_process_reports_status_and_audio_in_test_mode(self):
        environment = dict(os.environ)
        environment["BETTERTTS_SIDECAR_TEST_MODE"] = "1"
        process = subprocess.Popen(
            [sys.executable, "-u", "bettertts_sidecar.py"],
            cwd=os.path.dirname(__file__),
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert process.stdin is not None
        assert process.stdout is not None
        process.stdin.write('{"type":"status","id":1}\n')
        process.stdin.write('{"type":"synthesize","id":2,"text":"hello","language":"English","speaker":"Vivian","speed":1.0}\n')
        process.stdin.flush()
        lines = [process.stdout.readline() for _ in range(3)]
        process.stdin.write('{"type":"shutdown","id":3}\n')
        process.stdin.flush()
        process.wait(timeout=10)
        process.stdin.close()
        assert process.stdout is not None
        assert process.stderr is not None
        process.stdout.close()
        process.stderr.close()
        self.assertTrue(any('"type":"status"' in line and '"available":true' in line for line in lines))
        self.assertTrue(any('"type":"result"' in line and '"pcm16"' in line for line in lines))


if __name__ == "__main__":
    unittest.main()
