# dsh-talkback

[![npm](https://img.shields.io/npm/v/dsh-talkback)](https://www.npmjs.com/package/dsh-talkback)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

[中文](README.md) | English

Local voice conversation for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
speak into the microphone → your machine's ASR service turns it into text → the text is injected as a
user message → the assistant's reply is synthesized by your machine's TTS service → the audio is
streamed back to the browser. Start talking while it is speaking and it stops (barge-in).

Both engines stay on your machine. The plugin calls no cloud service, and audio lives only in memory
queues — nothing is written to disk.

The mic button next to the composer has two positions: **continuous** (auto-send after a pause,
auto-read replies, then keep listening) and **idle** (no mic, no playback — everything released).
It starts idle, so opening the page never grabs your microphone.

The plugin does not care what models run behind the two services; it only speaks a contract:
ASR is "upload audio, get text", TTS is "give text, get a WAV". See [docs/API.md](docs/API.md).

**This repository ships no models and no services.** You run a local ASR service (default
`127.0.0.1:8000`) and a local TTS service (default `127.0.0.1:9880`) that satisfy the contract.

## Install

```bash
dsh plugin add dsh-talkback --profile web
dsh --profile web --dump-config | grep talkback   # confirm the bundle landed
```

If the bundle is not in `dsh.profile.bundles`, add it to
`~/.dsh/profiles/web/package.json` manually, then restart `dsh web`.

Voice cloning has no default: run `/voice doctor` once. It probes both services, checks the
voice catalog, synthesizes one sentence for real, and prints a paste-ready config snippet.

## Configuration

Either use **Settings → Voice** in the Web UI, or edit
`~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: voice
  name: dsh-talkback
  config:
    enabled: true
    asr:
      endpoint: http://127.0.0.1:8000
    tts:
      enabled: true
      warmup: true
      voiceDir: 'C:\voices'
      voice: yunmia
```

Full field reference, privacy switches, and the two service contracts are in the
[Chinese README](README.md) and [docs/API.md](docs/API.md).

## Commands

| Command | What it does |
|---|---|
| `/voice` / `/voice status` | Session state, queue length, both endpoints |
| `/voice on` / `/voice off` | Read replies aloud / stop for this session |
| `/voice stop` | Stop playback and drop the rest of the queue |
| `/voice say 你好` | Speak a string without going through ASR |
| `/voice doctor` | Connectivity, contract, voice, reference audio, one real synthesis |

## Development

```bash
node test/run.mjs                          # self-tests, no models or network
node test/mock-services.mjs --amplitude .25  # fake ASR + TTS on real ports
```

No build step: the host half is plain ESM, the browser half is a hand-written module loader
registration with no bundler. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Privacy

Audio never touches disk and never leaves your machine unless you point `endpoint` at a remote host.
The voice routes refuse to start when `dsh web` binds to a non-loopback address, unless you opt in
with `transport.allowRemote`. Logs record lengths, not transcripts (`privacy.logText`).

## License

[MIT](./LICENSE) © 2026 kim