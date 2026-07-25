from __future__ import annotations

import hashlib
import io
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, features

from tile_core import (
    BASE_URL,
    DIMENSIONS,
    LAYERS,
    LODS,
    TILE_PIXELS,
    TileSpec,
    WebPValidationError,
    atomic_write_json,
    dimension_id,
    dimension_name,
    human_bytes,
    human_duration,
    parse_retry_after,
    sha256_file,
    tile_output_path,
    tile_relative_path,
    tile_shard,
    tile_url,
    trunc_div,
    validate_webp_bytes,
    validate_webp_file,
)


class SchemaTests(unittest.TestCase):
    def test_verified_constants(self) -> None:
        self.assertEqual(BASE_URL, "https://2b2t.place")
        self.assertEqual(
            DIMENSIONS,
            {"overworld": 0, "nether": 1, "end": 2},
        )
        self.assertEqual(LAYERS, ("base", "overlay", "newchunks"))
        self.assertEqual(LODS, tuple(range(11)))
        self.assertEqual(TILE_PIXELS, 512)

    def test_truncation_toward_zero_at_shard_boundaries(self) -> None:
        expected = {
            -65: -2,
            -33: -1,
            -32: -1,
            -31: 0,
            -1: 0,
            0: 0,
            1: 0,
            31: 0,
            32: 1,
            33: 1,
            65: 2,
        }
        for coordinate, shard in expected.items():
            with self.subTest(coordinate=coordinate):
                self.assertEqual(tile_shard(coordinate), shard)

    def test_truncation_is_integer_safe(self) -> None:
        enormous = 10**400
        self.assertEqual(trunc_div(enormous, 32), enormous // 32)
        self.assertEqual(trunc_div(-enormous, 32), -(enormous // 32))
        self.assertEqual(trunc_div(7, -3), -2)

    def test_dimension_resolution(self) -> None:
        self.assertEqual(dimension_id("nether"), 1)
        self.assertEqual(dimension_id(2), 2)
        self.assertEqual(dimension_name(0), "overworld")
        with self.assertRaises(ValueError):
            dimension_id("moon")
        with self.assertRaises(ValueError):
            dimension_id(True)

    def test_tile_spec_url_and_paths(self) -> None:
        spec = TileSpec(
            layer="base",
            lod=3,
            dimension="overworld",
            tile_x=-31,
            tile_z=-33,
        )
        self.assertEqual(spec.dimension_id, 0)
        self.assertEqual(spec.shard_x, 0)
        self.assertEqual(spec.shard_z, -1)
        self.assertEqual(spec.blocks_per_pixel, 8)
        self.assertEqual(spec.tile_blocks, 4096)
        self.assertEqual(spec.filename, "t.-31.-33.webp")
        self.assertEqual(
            tile_url(spec),
            "https://2b2t.place/tiles/base/3/0/0/-1/t.-31.-33.webp",
        )
        expected = Path("base/3/overworld/0/-1/t.-31.-33.webp")
        self.assertEqual(tile_relative_path(spec), expected)
        self.assertEqual(spec.relative_path, expected)
        self.assertEqual(tile_output_path("/tiles", spec), Path("/tiles") / expected)
        self.assertEqual(spec.output_path("/tiles"), Path("/tiles") / expected)
        self.assertEqual(
            spec.url("https://example.invalid/"),
            "https://example.invalid/tiles/base/3/0/0/-1/t.-31.-33.webp",
        )

    def test_tile_spec_normalizes_numeric_dimension(self) -> None:
        spec = TileSpec("overlay", 10, 2, 0, 0)  # type: ignore[arg-type]
        self.assertEqual(spec.dimension, "end")

    def test_tile_spec_rejects_invalid_values(self) -> None:
        with self.assertRaises(ValueError):
            TileSpec("unknown", 0, "overworld", 0, 0)
        with self.assertRaises(ValueError):
            TileSpec("base", 11, "overworld", 0, 0)
        with self.assertRaises(TypeError):
            TileSpec("base", 0, "overworld", True, 0)


@unittest.skipUnless(features.check("webp"), "Pillow lacks WebP support")
class WebPValidationTests(unittest.TestCase):
    @staticmethod
    def make_image_bytes(
        *,
        image_format: str = "WEBP",
        size: tuple[int, int] = (512, 512),
    ) -> bytes:
        buffer = io.BytesIO()
        with Image.new("RGB", size, (20, 40, 60)) as image:
            image.save(buffer, image_format, lossless=True)
        return buffer.getvalue()

    def test_valid_webp_bytes_and_file(self) -> None:
        payload = self.make_image_bytes()
        self.assertEqual(validate_webp_bytes(payload), (512, 512))

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tile.webp"
            path.write_bytes(payload)
            self.assertEqual(validate_webp_file(path), (512, 512))

    def test_rejects_non_webp_content(self) -> None:
        png = self.make_image_bytes(image_format="PNG")
        with self.assertRaisesRegex(WebPValidationError, "RIFF/WebP"):
            validate_webp_bytes(png)

    def test_rejects_wrong_dimensions(self) -> None:
        payload = self.make_image_bytes(size=(511, 512))
        with self.assertRaisesRegex(WebPValidationError, "511x512"):
            validate_webp_bytes(payload)

    def test_rejects_truncated_webp(self) -> None:
        payload = self.make_image_bytes()
        with self.assertRaisesRegex(WebPValidationError, "RIFF size mismatch"):
            validate_webp_bytes(payload[:-7])

    def test_rejects_fake_riff_webp(self) -> None:
        payload = b"RIFF" + (4).to_bytes(4, "little") + b"WEBP"
        with self.assertRaises(WebPValidationError):
            validate_webp_bytes(payload)

    def test_missing_file_has_validation_error(self) -> None:
        with self.assertRaisesRegex(WebPValidationError, "cannot read tile"):
            validate_webp_file("/definitely/not/a/tile.webp")


class UtilityTests(unittest.TestCase):
    def test_sha256_file(self) -> None:
        payload = b"2b2t tile data"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "payload.bin"
            path.write_bytes(payload)
            self.assertEqual(
                sha256_file(path, chunk_size=3),
                hashlib.sha256(payload).hexdigest(),
            )
        with self.assertRaises(ValueError):
            sha256_file("/unused", chunk_size=0)

    def test_retry_after_delta_seconds(self) -> None:
        self.assertEqual(parse_retry_after("120"), 120.0)
        self.assertEqual(parse_retry_after(" 0 "), 0.0)
        self.assertIsNone(parse_retry_after("-1"))
        self.assertIsNone(parse_retry_after("1.5"))
        self.assertIsNone(parse_retry_after(None))

    def test_retry_after_http_date(self) -> None:
        now = datetime(2015, 10, 21, 7, 27, 0, tzinfo=timezone.utc)
        self.assertEqual(
            parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT", now=now),
            60.0,
        )
        self.assertEqual(
            parse_retry_after("Wed, 21 Oct 2015 07:26:00 GMT", now=now),
            0.0,
        )
        self.assertIsNone(parse_retry_after("not a date", now=now))

    def test_atomic_json_write_creates_and_replaces(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "nested" / "progress.json"
            atomic_write_json(destination, {"completed": 1, "name": "área"})
            self.assertEqual(
                json.loads(destination.read_text(encoding="utf-8")),
                {"completed": 1, "name": "área"},
            )

            atomic_write_json(destination, {"completed": 2}, indent=None)
            self.assertEqual(
                json.loads(destination.read_text(encoding="utf-8")),
                {"completed": 2},
            )
            self.assertEqual(
                list(destination.parent.glob(".progress.json.*.tmp")),
                [],
            )

    def test_human_bytes(self) -> None:
        self.assertEqual(human_bytes(0), "0 B")
        self.assertEqual(human_bytes(1024), "1.00 KiB")
        self.assertEqual(human_bytes(1536), "1.50 KiB")
        self.assertEqual(human_bytes(-1024), "-1.00 KiB")
        self.assertEqual(human_bytes(None), "unknown")
        self.assertEqual(human_bytes(float("inf")), "∞")

    def test_human_duration(self) -> None:
        self.assertEqual(human_duration(0), "0s")
        self.assertEqual(human_duration(59.4), "59s")
        self.assertEqual(human_duration(90), "1m 30s")
        self.assertEqual(human_duration(3661), "1h 1m 1s")
        self.assertEqual(human_duration(90061), "1d 1h 1m 1s")
        self.assertEqual(human_duration(-1), "0s")
        self.assertEqual(human_duration(None), "unknown")


if __name__ == "__main__":
    unittest.main()
