#!/usr/bin/env python3
"""
Voice embedding sidecar for meeting-cli.
Extracts speaker embeddings using Resemblyzer and matches against stored profiles.

Usage:
  voice_embed.py extract <wav_path> [--start <sec>] [--end <sec>]
    → Returns JSON: { "embedding": [256 floats] }

  voice_embed.py match <wav_path> --profiles <dir> [--start <sec>] [--end <sec>] [--candidates name1,name2]
    → Returns JSON: { "matches": [{ "name": "Lucas", "similarity": 0.82 }, ...] }

  voice_embed.py enroll <wav_path> --name <name> --profiles <dir> [--start <sec>] [--end <sec>]
    → Extracts embedding and saves to profiles dir. Returns JSON: { "saved": "lucas.json" }
"""

import sys
import json
import os
import io
import numpy as np
from pathlib import Path

# Lazy-load Resemblyzer (heavy import, ~2s)
_encoder = None

def get_encoder():
    global _encoder
    if _encoder is None:
        # Suppress Resemblyzer's "Loaded the voice encoder model" message
        old_stdout = sys.stdout
        sys.stdout = io.StringIO()
        try:
            import warnings
            warnings.filterwarnings("ignore")
            from resemblyzer import VoiceEncoder
            _encoder = VoiceEncoder("cpu")
        finally:
            sys.stdout = old_stdout
    return _encoder


def load_wav_segment(wav_path: str, start: float = 0, end: float = 0):
    """Load a WAV file (or segment) as float32 numpy array at 16kHz."""
    from resemblyzer import preprocess_wav
    import struct

    with open(wav_path, "rb") as f:
        data = f.read()

    # Parse WAV header
    channels = struct.unpack_from("<H", data, 22)[0]
    sample_rate = struct.unpack_from("<I", data, 24)[0]
    bits = struct.unpack_from("<H", data, 34)[0]

    pcm = data[44:]
    samples = np.frombuffer(pcm, dtype=np.int16 if bits == 16 else np.float32)

    # If stereo, take channel 0 (remote speakers)
    if channels == 2:
        samples = samples[0::2]

    audio = samples.astype(np.float32) / (32768.0 if bits == 16 else 1.0)

    # Trim to segment
    if start > 0 or end > 0:
        start_sample = int(start * sample_rate)
        end_sample = int(end * sample_rate) if end > 0 else len(audio)
        audio = audio[start_sample:end_sample]

    # Resemblyzer expects 16kHz
    if sample_rate != 16000:
        # Simple decimation (good enough for 16kHz target from 44.1/48kHz)
        ratio = sample_rate / 16000
        indices = np.arange(0, len(audio), ratio).astype(int)
        indices = indices[indices < len(audio)]
        audio = audio[indices]

    return preprocess_wav(audio, source_sr=16000)


def extract_embedding(wav_path: str, start: float = 0, end: float = 0) -> list:
    """Extract a 256-dim voice embedding from a WAV file."""
    encoder = get_encoder()
    wav = load_wav_segment(wav_path, start, end)

    if len(wav) < 16000:  # Less than 1 second
        return []

    embedding = encoder.embed_utterance(wav)
    return embedding.tolist()


def load_profiles(profiles_dir: str, candidates: list = None) -> dict:
    """Load voice profiles from directory. Returns {name: embedding_array}."""
    profiles = {}
    profiles_path = Path(profiles_dir)

    if not profiles_path.exists():
        return profiles

    for f in profiles_path.glob("*.json"):
        try:
            data = json.loads(f.read_text())
            name = data.get("name", f.stem)
            # Filter by candidates if provided
            if candidates and name.lower() not in [c.lower() for c in candidates]:
                continue
            embedding = np.array(data["embedding"], dtype=np.float32)
            profiles[name] = embedding
        except (json.JSONDecodeError, KeyError):
            continue

    return profiles


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity between two vectors."""
    dot = np.dot(a, b)
    norm = np.linalg.norm(a) * np.linalg.norm(b)
    return float(dot / norm) if norm > 0 else 0.0


def match_against_profiles(embedding: list, profiles: dict, threshold: float = 0.35) -> list:
    """Match an embedding against stored profiles. Returns sorted matches."""
    if not embedding or not profiles:
        return []

    emb = np.array(embedding, dtype=np.float32)
    matches = []

    for name, profile_emb in profiles.items():
        sim = cosine_similarity(emb, profile_emb)
        if sim >= threshold:
            matches.append({"name": name, "similarity": round(sim, 4)})

    return sorted(matches, key=lambda x: x["similarity"], reverse=True)


def save_profile(name: str, embedding: list, profiles_dir: str):
    """Save or update a voice profile."""
    profiles_path = Path(profiles_dir)
    profiles_path.mkdir(parents=True, exist_ok=True)

    safe_name = name.lower().replace(" ", "_")
    filepath = profiles_path / f"{safe_name}.json"

    # If profile exists, weighted average (existing has more weight for stability)
    if filepath.exists():
        try:
            existing = json.loads(filepath.read_text())
            old_emb = np.array(existing["embedding"], dtype=np.float32)
            new_emb = np.array(embedding, dtype=np.float32)
            sessions = existing.get("sessions", 1)
            # Weighted average: old profiles have more inertia
            weight = min(sessions, 10)  # cap weight at 10 sessions
            merged = (old_emb * weight + new_emb) / (weight + 1)
            merged = merged / np.linalg.norm(merged)  # re-normalize
            embedding = merged.tolist()
            sessions += 1
        except (json.JSONDecodeError, KeyError):
            sessions = 1
    else:
        sessions = 1

    data = {
        "name": name,
        "embedding": embedding,
        "sessions": sessions,
    }

    filepath.write_text(json.dumps(data))
    return f"{safe_name}.json"


def main():
    args = sys.argv[1:]

    if len(args) < 2:
        print(json.dumps({"error": "Usage: voice_embed.py <command> <wav_path> [options]"}))
        sys.exit(1)

    command = args[0]
    wav_path = args[1]

    # Parse optional args
    start = 0.0
    end = 0.0
    profiles_dir = ""
    name = ""
    candidates = []

    i = 2
    while i < len(args):
        if args[i] == "--start" and i + 1 < len(args):
            start = float(args[i + 1]); i += 2
        elif args[i] == "--end" and i + 1 < len(args):
            end = float(args[i + 1]); i += 2
        elif args[i] == "--profiles" and i + 1 < len(args):
            profiles_dir = args[i + 1]; i += 2
        elif args[i] == "--name" and i + 1 < len(args):
            name = args[i + 1]; i += 2
        elif args[i] == "--candidates" and i + 1 < len(args):
            candidates = [c.strip() for c in args[i + 1].split(",")]; i += 2
        else:
            i += 1

    try:
        if command == "extract":
            embedding = extract_embedding(wav_path, start, end)
            print(json.dumps({"embedding": embedding}))

        elif command == "match":
            if not profiles_dir:
                print(json.dumps({"error": "--profiles dir required"}))
                sys.exit(1)
            embedding = extract_embedding(wav_path, start, end)
            profiles = load_profiles(profiles_dir, candidates or None)
            matches = match_against_profiles(embedding, profiles)
            print(json.dumps({"matches": matches}))

        elif command == "enroll":
            if not name or not profiles_dir:
                print(json.dumps({"error": "--name and --profiles required"}))
                sys.exit(1)
            embedding = extract_embedding(wav_path, start, end)
            if not embedding:
                print(json.dumps({"error": "Audio too short for embedding"}))
                sys.exit(1)
            saved = save_profile(name, embedding, profiles_dir)
            print(json.dumps({"saved": saved, "dimensions": len(embedding)}))

        else:
            print(json.dumps({"error": f"Unknown command: {command}"}))
            sys.exit(1)

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
