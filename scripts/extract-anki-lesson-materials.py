#!/usr/bin/env python3
"""Extract only Lesson-relevant text fields from an authorized APKG into a private directory."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import sqlite3
import tempfile
import zipfile
from html.parser import HTMLParser
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
FIELD_ALIASES = {
    "word": {"word", "headword", "lemma", "目标词", "单词", "词条", "英文单词"},
    "meaning_zh": {"simpledefinition", "meaningzh", "definitioncn", "definitionzh", "meaning", "释义", "中文释义", "核心释义", "常考释义", "definition"},
    "part_of_speech": {"pos", "partofspeech", "词性", "词性语法"},
    "ipa": {"ipa", "ipaus", "usipa", "phonetic", "美式音标", "美音", "音标美"},
    "ipa_uk": {"ipauk", "ukipa", "英式音标", "英音", "音标英"},
    "collocations": {"collocation", "collocations", "phrase", "phrases", "搭配", "常用搭配"},
    "derivations": {"derivation", "derivations", "wordfamily", "wordforms", "派生词", "词形变化", "相关词形"},
    "examples": {"example", "examples", "例句", "真题例句", "双语例句"},
    "note": {"examnote", "memorynote", "note", "学习提示", "考试提示", "记忆提示"},
}


def normalized_field_name(value: str) -> str:
    return re.sub(r"[^a-z0-9\u3400-\u9fff]+", "", value.casefold())


class TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.hidden = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "svg"}:
            self.hidden += 1
        elif tag in {"br", "p", "div", "li", "section", "article", "tr", "h1", "h2", "h3"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "svg"} and self.hidden:
            self.hidden -= 1
        elif tag in {"p", "div", "li", "section", "article", "tr", "h1", "h2", "h3"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.hidden:
            self.parts.append(data)


def plain_text(value: str) -> str:
    parser = TextExtractor()
    parser.feed(value)
    text = html.unescape("".join(parser.parts))
    text = text.replace("\u00a0", " ").replace("\r", "\n")
    return re.sub(r"[ \t]+", " ", re.sub(r"\n[ \t]*\n+", "\n", text)).strip()


def find_field(field_map: dict[str, str], canonical: str) -> tuple[str | None, str | None]:
    aliases = {normalized_field_name(item) for item in FIELD_ALIASES[canonical]}
    items = list(field_map.items())
    if canonical == "meaning_zh":
        priorities = {"simpledefinition": 0, "meaningzh": 0, "definitioncn": 0, "definitionzh": 0, "definition": 1, "meaning": 2}
        items.sort(key=lambda item: priorities.get(normalized_field_name(item[0]), 3))
    for name, value in items:
        if normalized_field_name(name) in aliases and value.strip():
            return name, value.strip()
    return None, None


def bilingual_pairs(value: str) -> list[tuple[str, str]]:
    lines = [re.sub(r"^\s*(?:[-*•]|\d+[.)、])\s*", "", line).strip() for line in value.splitlines()]
    lines = [line for line in lines if line]
    pairs: list[tuple[str, str]] = []
    index = 0
    while index < len(lines):
        left = lines[index]
        if re.search(r"[A-Za-z]", left) and re.search(r"[\u3400-\u9fff]", left):
            match = re.match(r"^(.+?[.!?])\s+([\u3400-\u9fff].+)$", left)
            if match:
                pairs.append((match.group(1).strip(), match.group(2).strip()))
        elif index + 1 < len(lines) and re.search(r"[A-Za-z]", left) and re.search(r"[\u3400-\u9fff]", lines[index + 1]):
            pairs.append((left, lines[index + 1]))
            index += 1
        index += 1
    return pairs


def bilingual_list(value: str) -> list[str]:
    result: list[str] = []
    for line in value.splitlines():
        line = line.strip()
        if re.search(r"[A-Za-z]", line) and re.search(r"[\u3400-\u9fff]", line):
            result.append(line[:200])
    return list(dict.fromkeys(result))[:8]


def derivation_list(value: str) -> list[str]:
    # WordForms mixes lexical derivations with inflections and source labels.
    # Import only entries that can be read as a word plus a Chinese meaning;
    # the importer can ask CodeBuddy to fill a genuinely missing field later.
    entries = bilingual_list(value)
    source_label = re.compile(
        r"(?i)\becdict\b|(?:词形变化|派生词|相关词形).*(?:补充|来源|词典)|"
        r"(?:补充|来源|词典).*(?:词形变化|派生词|相关词形)"
    )
    inflection_label = re.compile(
        r"原形|复数|第三人称单数|现在分词|过去式|过去分词|比较级|最高级|"
        r"词形变化|词形|过去虚拟式|现在时(?:第一人称|第二人称|第三人称)?"
    )
    part_of_speech_label = re.compile(r"名词|动词|形容词|副词|及物动词|不及物动词|缩写")
    result: list[str] = []
    for entry in entries:
        if source_label.search(entry) or inflection_label.search(entry):
            continue
        chinese = "".join(re.findall(r"[\u3400-\u9fff]+", entry))
        meaning = part_of_speech_label.sub("", chinese)
        if not meaning.strip():
            continue
        result.append(entry)
    return result


def stable_word(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().casefold())


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_apkg(apkg: Path, output_dir: Path, source_version: str) -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix="anki-apkg-", dir=output_dir) as temporary:
        temp_root = Path(temporary)
        with zipfile.ZipFile(apkg) as archive:
            collection_name = next((name for name in ("collection.anki21", "collection.anki2") if name in archive.namelist()), None)
            if not collection_name:
                raise ValueError("APKG_COLLECTION_DATABASE_MISSING")
            db_path = temp_root / "collection.sqlite3"
            db_path.write_bytes(archive.read(collection_name))

        connection = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True)
        try:
            collection = connection.execute("SELECT models FROM col LIMIT 1").fetchone()
            if not collection or not collection[0]:
                raise ValueError("APKG_NOTE_MODELS_MISSING")
            models = json.loads(collection[0])
            model_fields = {int(model_id): [field["name"] for field in model.get("flds", [])] for model_id, model in models.items()}
            notes = connection.execute("SELECT id, mid, flds FROM notes ORDER BY id").fetchall()
            output_path = output_dir / "anki-lesson-materials.jsonl"
            temporary_output = output_dir / "anki-lesson-materials.jsonl.tmp"
            distinct: dict[str, dict[str, object]] = {}
            encountered_fields: set[str] = set()
            nonempty_field_counts: dict[str, int] = {}
            unmapped = 0
            for note_id, model_id, field_values in notes:
                names = model_fields.get(int(model_id), [])
                encountered_fields.update(names)
                values = field_values.split("\x1f")
                fields = {
                    name: plain_text(values[index])
                    for index, name in enumerate(names)
                    if index < len(values) and plain_text(values[index])
                }
                encountered_fields.update(fields.keys())
                for name in fields:
                    nonempty_field_counts[name] = nonempty_field_counts.get(name, 0) + 1
                word_name, word_value = find_field(fields, "word")
                if not word_value:
                    unmapped += 1
                    continue
                mapped: dict[str, object] = {
                    "normalized_word": stable_word(word_value),
                    "display_word": word_value[:120],
                    "source_note_id": str(note_id),
                    "source_model_id": str(model_id),
                    "source_fields": [],
                }
                used_fields: list[str] = []
                for key in ("meaning_zh", "part_of_speech", "ipa", "ipa_uk", "note"):
                    field_name, value = find_field(fields, key)
                    if value:
                        mapped[key] = value[:1000]
                        if field_name:
                            used_fields.append(field_name)
                for key in ("collocations", "derivations"):
                    field_name, value = find_field(fields, key)
                    if value:
                        entries = derivation_list(value) if key == "derivations" else bilingual_list(value)
                        if entries:
                            mapped[key] = entries
                            if field_name:
                                used_fields.append(field_name)
                example_name, example_value = find_field(fields, "examples")
                if example_value:
                    pairs = bilingual_pairs(example_value)
                    if pairs:
                        mapped["example_en"], mapped["example_zh"] = pairs[0]
                        if example_name:
                            used_fields.append(example_name)
                if word_name:
                    used_fields.insert(0, word_name)
                mapped["source_fields"] = list(dict.fromkeys(used_fields))[:40]
                prior = distinct.get(mapped["normalized_word"])
                if prior:
                    # Keep a single deterministic card. If duplicate normalized
                    # headwords have distinct senses, retain unique sense text.
                    if mapped.get("meaning_zh") and mapped.get("meaning_zh") != prior.get("meaning_zh"):
                        senses = list(prior.get("alternate_meanings_zh", []))
                        if mapped["meaning_zh"] not in senses:
                            senses.append(mapped["meaning_zh"])
                        prior["alternate_meanings_zh"] = senses
                    continue
                distinct[str(mapped["normalized_word"])] = mapped

            with temporary_output.open("w", encoding="utf-8", newline="\n") as handle:
                for key in sorted(distinct):
                    handle.write(json.dumps(distinct[key], ensure_ascii=False, separators=(",", ":")) + "\n")
            temporary_output.replace(output_path)
        finally:
            connection.close()

    manifest = {
        "source": "https://github.com/CHNragdoll/anki-pipeline",
        "source_version": source_version,
        "apkg_sha256": sha256_file(apkg),
        "apkg_bytes": apkg.stat().st_size,
        "note_count": len(notes),
        "unique_normalized_words": len(distinct),
        "notes_without_word_field": unmapped,
        "available_field_names": sorted(encountered_fields),
        "nonempty_field_counts": nonempty_field_counts,
        "output_file": str(output_path),
    }
    manifest_path = output_dir / "anki-lesson-materials.manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apkg", required=True, type=Path)
    parser.add_argument("--private-data-dir", required=True, type=Path)
    parser.add_argument("--source-version", default="anki-pipeline:2027-redbook:20261015")
    args = parser.parse_args()
    private_dir = args.private_data_dir.resolve(strict=True)
    repository_root = REPOSITORY_ROOT.resolve(strict=True)
    if private_dir == repository_root or repository_root in private_dir.parents:
        raise SystemExit("PRIVATE_DATA_DIR_MUST_BE_OUTSIDE_CHECKOUT")
    apkg = args.apkg.resolve(strict=True)
    if not zipfile.is_zipfile(apkg):
        raise SystemExit("APKG_FILE_IS_NOT_A_VALID_ZIP")
    result = parse_apkg(apkg, private_dir, args.source_version)
    print(json.dumps({key: value for key, value in result.items() if key not in {"output_file", "available_field_names"}}, ensure_ascii=False))


if __name__ == "__main__":
    main()
